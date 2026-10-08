//! Guest-only transport and terminal. Never construct an account client, Hand,
//! reload registry, prompt cache, or owner TUI control socket here.
use super::terminal::TerminalSession;
use crossterm::event::{Event, EventStream, KeyCode, KeyEventKind, KeyModifiers};
use futures_util::StreamExt;
use nanocodex_managed::ManagedError;
use ratatui::{
    layout::{Constraint, Layout},
    widgets::{Block, Paragraph, Wrap},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use tokio::sync::mpsc;
use url::Url;
use zeroize::Zeroizing;

fn failure(message: &str) -> ManagedError {
    ManagedError::Configuration(message.into())
}
fn clean(value: &str, token: &str) -> String {
    value
        .replace(token, "[redacted]")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}

#[derive(Clone)]
struct Guest {
    http: reqwest::Client,
    base: String,
    origin: String,
    token: std::sync::Arc<Zeroizing<String>>,
}
impl Guest {
    fn request(&self, method: reqwest::Method, suffix: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{suffix}", self.base))
            .bearer_auth(self.token.as_str())
    }
    async fn get(&self, suffix: &str) -> Result<Value, ManagedError> {
        let response = self
            .request(reqwest::Method::GET, suffix)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|_| failure("Shared thread connection failed"))?;
        if !response.status().is_success() {
            return Err(failure(
                "Shared thread access unavailable (invalid or revoked link)",
            ));
        }
        response
            .json()
            .await
            .map_err(|_| failure("Invalid shared thread response"))
    }
}
enum Update {
    Event(Value),
    Status(&'static str),
    Revoked,
    Submission(Result<(), u16>),
}

pub(crate) async fn run_shared(reference: &str) -> Result<(), ManagedError> {
    let url = Url::parse(reference).map_err(|_| failure("Invalid shared URL"))?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
        || url
            .host_str()
            .is_some_and(|host| host.ends_with(".localhost"));
    if !(url.scheme() == "https" || url.scheme() == "http" && local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
    {
        return Err(failure(
            "Shared URLs require HTTPS (HTTP is supported on localhost), without credentials or query parameters",
        ));
    }
    let id = url
        .path()
        .strip_prefix("/share/")
        .unwrap_or("")
        .trim_end_matches('/');
    if id.len() != 36 || uuid::Uuid::parse_str(id).is_err() {
        return Err(failure("Invalid shared thread ID"));
    }
    let mut token = Zeroizing::new(
        url.fragment()
            .and_then(|value| value.strip_prefix("token="))
            .unwrap_or("")
            .to_owned(),
    );
    let mut terminal = TerminalSession::enter()
        .await
        .map_err(|_| failure("Shared attachment requires an interactive terminal"))?;
    let mut keys = EventStream::new();
    if token.is_empty() {
        loop {
            terminal
                .draw(|frame| {
                    frame.render_widget(
                        Paragraph::new("Paste shared token (hidden), then Enter. Esc cancels."),
                        frame.area(),
                    )
                })
                .map_err(|_| failure("Terminal unavailable"))?;
            match keys.next().await {
                Some(Ok(Event::Paste(value))) => token.push_str(value.trim()),
                Some(Ok(Event::Key(key))) if key.kind != KeyEventKind::Release => match key.code {
                    KeyCode::Esc => return Ok(()),
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        return Ok(());
                    }
                    KeyCode::Enter => break,
                    KeyCode::Backspace => {
                        token.pop();
                    }
                    KeyCode::Char(c) => token.push(c),
                    _ => {}
                },
                None | Some(Err(_)) => return Ok(()),
                _ => {}
            }
        }
    }
    if token.len() != 47
        || !token.starts_with("nsl_")
        || !token[4..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(failure("Invalid shared token"));
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let guest = Guest {
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| failure("Could not create guest transport"))?,
        origin: url.origin().ascii_serialization(),
        base: format!("{}/v1/shared/{id}", url.origin().ascii_serialization()),
        token: std::sync::Arc::new(token),
    };
    let meta = guest.get("").await?;
    let writable = meta["permission"] == "write";
    if !writable && meta["permission"] != "read" {
        return Err(failure("Invalid shared permission"));
    }
    let title = clean(
        meta["title"].as_str().unwrap_or("Shared thread"),
        &guest.token,
    );
    let cursor = meta["latest_event_cursor"]
        .as_str()
        .unwrap_or("0")
        .to_owned();
    let history = guest.get("/events/history").await?;
    let mut before = history["next_cursor"].as_str().map(str::to_owned);
    let mut events: Vec<Value> = history["data"].as_array().cloned().unwrap_or_default();
    let mut seen: HashSet<String> = events
        .iter()
        .filter_map(|v| v["cursor"].as_str().map(str::to_owned))
        .collect();
    let (tx, mut rx) = mpsc::channel(128);
    let stream = tokio::spawn(stream(guest.clone(), cursor, tx.clone()));
    let mut submission = None;
    let mut input = String::new();
    let mut status = "Connecting";
    let mut revoked = false;
    let mut pending = false;
    let mut scroll = 0u16;
    let result = async {
        loop {
            let text = render_events(&events, &guest.token);
            terminal.draw(|frame| {
                let areas = Layout::vertical([Constraint::Length(2), Constraint::Min(1), Constraint::Length(3)]).split(frame.area());
                let permission = if writable { "write" } else { "read-only" };
                frame.render_widget(Paragraph::new(format!("{title} · Shared · {permission}\n{status} · Ctrl-C exits · PgUp/PgDn scroll · Home loads older messages")), areas[0]);
                let paragraph = Paragraph::new(text.as_str()).wrap(Wrap { trim: false });
                let bottom = paragraph.line_count(areas[1].width).saturating_sub(usize::from(areas[1].height)).min(u16::MAX as usize) as u16;
                frame.render_widget(paragraph.scroll((bottom.saturating_sub(scroll), 0)), areas[1]);
                let prompt = if revoked { "Access revoked" } else if !writable { "Read-only shared thread" } else if pending { "Submitting…" } else { &input };
                frame.render_widget(Paragraph::new(prompt).wrap(Wrap { trim: false }).block(Block::bordered().title("Guest")), areas[2]);
            }).map_err(|_| failure("Terminal unavailable"))?;
            tokio::select! {
                update = rx.recv() => match update {
                    Some(Update::Event(event)) => {
                        if event["cursor"].as_str().is_none_or(|cursor| seen.insert(cursor.to_owned())) { events.push(event); }
                        status = "Live";
                    }
                    Some(Update::Status(value)) => status = value,
                    Some(Update::Revoked) => { revoked = true; status = "Access revoked or unavailable"; input.clear(); }
                    Some(Update::Submission(result)) => {
                        pending = false;
                        match result {
                            Ok(()) => { input.clear(); status = "Guest message accepted"; }
                            Err(403 | 404 | 401) => { revoked = true; input.clear(); status = "Access revoked or unavailable"; }
                            Err(0) => status = "Submission outcome unknown; check the live thread before sending again",
                            Err(_) => status = "Message rejected by server",
                        }
                    }
                    None => break,
                },
                key = keys.next() => match key {
                    Some(Ok(Event::Paste(value))) if writable && !revoked && !pending => {
                        input.extend(clean(&value, &guest.token).chars().take(32_000usize.saturating_sub(input.len())));
                    }
                    Some(Ok(Event::Key(key))) if key.kind != KeyEventKind::Release => match key.code {
                        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => break,
                        KeyCode::Esc => break,
                        KeyCode::PageUp => scroll = scroll.saturating_add(10),
                        KeyCode::PageDown => scroll = scroll.saturating_sub(10),
                        KeyCode::End => scroll = 0,
                        KeyCode::Home if !revoked => {
                            if let Some(cursor) = before.clone() {
                                let page = guest.get(&format!("/events/history?before={cursor}")).await?;
                                before = page["next_cursor"].as_str().map(str::to_owned);
                                let mut older = page["data"].as_array().cloned().unwrap_or_default();
                                older.retain(|v| v["cursor"].as_str().is_some_and(|c| seen.insert(c.to_owned())));
                                older.append(&mut events); events = older;
                                status = "Older messages loaded";
                            }
                        }
                        KeyCode::Enter if writable && !revoked && !pending && !input.trim().is_empty() => {
                            pending = true;
                            let guest = guest.clone(); let tx = tx.clone(); let input = input.clone();
                            submission = Some(tokio::spawn(async move {
                                // One request only: never retry an uncertain admission.
                                let response = guest.request(reqwest::Method::POST, "/turns")
                                    .header("origin", &guest.origin).timeout(Duration::from_secs(30))
                                    .json(&json!({"id": uuid::Uuid::new_v4().to_string(), "input": input}))
                                    .send().await;
                                let result = match response { Ok(r) if r.status().is_success() => Ok(()), Ok(r) => Err(r.status().as_u16()), Err(_) => Err(0) };
                                let _ = tx.send(Update::Submission(result)).await;
                            }));
                        }
                        KeyCode::Backspace if !pending => { input.pop(); }
                        KeyCode::Char(c) if writable && !revoked && !pending && input.len() < 32_000 && !key.modifiers.contains(KeyModifiers::CONTROL) => input.push(c),
                        _ => {}
                    },
                    None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
        Ok(())
    }.await;
    stream.abort();
    if let Some(task) = submission {
        task.abort();
    }
    result
}

async fn stream(guest: Guest, mut cursor: String, tx: mpsc::Sender<Update>) {
    loop {
        let response = guest
            .request(reqwest::Method::GET, "/events")
            .query(&[("after", &cursor)])
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                if tx.send(Update::Status("Live")).await.is_err() {
                    return;
                }
                let mut body = response.bytes_stream();
                let mut buffer = Vec::new();
                while let Some(Ok(bytes)) = body.next().await {
                    buffer.extend_from_slice(&bytes);
                    if buffer.len() > 4_000_000 {
                        break;
                    }
                    while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=end).collect();
                        if let Some(data) = line.strip_prefix(b"data: ") {
                            if let Ok(event) = serde_json::from_slice::<Value>(data) {
                                if let Some(id) = event["cursor"].as_str() {
                                    cursor = id.to_owned();
                                }
                                if tx.send(Update::Event(event)).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            Ok(response) if matches!(response.status().as_u16(), 401 | 403 | 404) => {
                let _ = tx.send(Update::Revoked).await;
                return;
            }
            _ => {}
        }
        if tx.send(Update::Status("Reconnecting")).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn render_events(events: &[Value], token: &str) -> String {
    // Reconcile streamed text with its completed message, so completion does
    // not print the assistant's answer a second (or third) time.
    let mut parts: Vec<String> = Vec::new();
    let mut messages: HashMap<String, usize> = HashMap::new();
    let mut completed = HashSet::new();
    for event in events {
        match event["type"].as_str().unwrap_or("") {
            "turn_accepted" => parts.push(format!(
                "\n{}: {}\n",
                if event["author"] == "guest" {
                    "Guest"
                } else {
                    "User"
                },
                event["input"].as_str().unwrap_or("")
            )),
            "turn_completed" => {
                let turn = event["turn_id"]
                    .as_str()
                    .or(event["id"].as_str())
                    .unwrap_or("");
                let answer = event["final_message"].as_str().unwrap_or("");
                if !completed.contains(&(turn.to_owned(), answer.to_owned())) {
                    parts.push(format!("\nAssistant: {answer}\n"));
                }
            }
            "event" => {
                let inner = &event["event"];
                let payload = &inner["payload"];
                let kind = inner["type"].as_str().unwrap_or("");
                match kind {
                    "assistant.delta" | "assistant.message" | "reasoning.summary.delta" => {
                        let reasoning = kind == "reasoning.summary.delta";
                        let key = json!([
                            event["turn_id"],
                            event["agent_id"],
                            payload["item_id"],
                            payload["phase"],
                            payload["model_call_index"],
                            reasoning
                        ])
                        .to_string();
                        let label = if reasoning { "Reasoning" } else { "Assistant" };
                        let index = *messages.entry(key).or_insert_with(|| {
                            parts.push(format!("\n{label}: "));
                            parts.len() - 1
                        });
                        let content = payload["text"].as_str().unwrap_or("");
                        if kind == "assistant.message" {
                            parts[index] = format!("\nAssistant: {content}\n");
                            if event["agent_id"].is_null() || event["agent_id"] == 0 {
                                completed.insert((
                                    event["turn_id"].as_str().unwrap_or("").to_owned(),
                                    content.to_owned(),
                                ));
                            }
                        } else {
                            parts[index].push_str(content);
                        }
                    }
                    "tool.call" | "tool.result" => parts.push(format!("\n{kind}: {payload}\n")),
                    _ => {}
                }
            }
            "turn_failed" | "turn_cancelled" | "turn_retryable" | "stream_failed" => {
                parts.push(format!("\n{}\n", event["type"].as_str().unwrap_or("")))
            }
            _ => {}
        }
    }
    clean(&parts.join(""), token)
}
