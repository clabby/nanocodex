use std::num::NonZeroU32;

use eyre::{Result, eyre};
use futures_util::{SinkExt, StreamExt};
use nanocodex_oai_api::{OpenAi, transport::ResponsesTransport};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream, accept_async, accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
        http::StatusCode,
    },
};

const TURN_STATE_HEADER: &str = "x-codex-turn-state";

#[tokio::test]
async fn exhausted_websocket_budget_falls_back_to_sticky_https_full_replay() -> Result<()> {
    let websocket_listener = TcpListener::bind("127.0.0.1:0").await?;
    let websocket_url = format!("ws://{}", websocket_listener.local_addr()?);
    let http_listener = TcpListener::bind("127.0.0.1:0").await?;
    let api_base_url = format!("http://{}", http_listener.local_addr()?);

    let websocket_server = tokio::spawn(async move {
        let (stream, _) = websocket_listener.accept().await?;
        let mut first = accept_async(stream).await?;
        let initial = next_ws_json(&mut first).await?;
        assert!(initial.to_string().contains("fall back safely"));
        send_ws_json(
            &mut first,
            json!({
                "type": "response.metadata",
                "headers": { TURN_STATE_HEADER: "sticky-before-fallback" }
            }),
        )
        .await?;
        drop(first);

        let (stream, _) = websocket_listener.accept().await?;
        let mut second = accept_hdr_async(stream, |request: &Request, response: Response| {
            assert_eq!(
                request
                    .headers()
                    .get(TURN_STATE_HEADER)
                    .and_then(|value| value.to_str().ok()),
                Some("sticky-before-fallback")
            );
            Ok(response)
        })
        .await?;
        let replay = next_ws_json(&mut second).await?;
        assert!(replay.get("previous_response_id").is_none());
        assert!(replay.to_string().contains("fall back safely"));
        drop(second);
        Result::<()>::Ok(())
    });

    let http_server = tokio::spawn(async move {
        let fallback = read_http_json(&http_listener).await?;
        assert_eq!(
            turn_state(&fallback.headers).as_deref(),
            Some("sticky-before-fallback")
        );
        assert!(
            fallback.body.get("kind").is_none(),
            "HTTPS must not reuse the WebSocket response.create envelope"
        );
        assert!(fallback.body.get("previous_response_id").is_none());
        assert!(
            fallback.body["client_metadata"]
                .get("responses_lite")
                .is_none(),
            "HTTPS must not retain Responses Lite client metadata"
        );
        assert!(fallback.body.to_string().contains("fall back safely"));
        send_http_events(
            fallback.stream,
            None,
            [completed_response("resp-fallback", "fallback")],
        )
        .await?;

        let continuation = read_http_json(&http_listener).await?;
        assert_eq!(
            turn_state(&continuation.headers).as_deref(),
            Some("sticky-before-fallback")
        );
        assert!(
            continuation.body.get("previous_response_id").is_none(),
            "store:false HTTPS continuation must replay authoritative history"
        );
        let body = continuation.body.to_string();
        assert!(body.contains("fall back safely"));
        assert!(body.contains("fallback"));
        assert!(body.contains("stay on https"));
        send_http_events(
            continuation.stream,
            None,
            [completed_response("resp-sticky", "https")],
        )
        .await?;
        Result::<()>::Ok(())
    });

    let openai = OpenAi::builder("test-key")
        .websocket_url(websocket_url)
        .api_base_url(api_base_url)
        .max_attempts(NonZeroU32::new(2).unwrap())
        .build()?;
    let mut session = openai
        .instructions("Use the configured transport transparently.")
        .build()?;
    let mut turn = session.turn();
    assert_eq!(
        turn.create("fall back safely").await?.output_text(),
        "fallback"
    );
    assert_eq!(turn.create("stay on https").await?.output_text(), "https");

    timeout(std::time::Duration::from_secs(5), websocket_server)
        .await
        .map_err(|_| eyre!("mock WebSocket exhaustion server did not finish"))???;
    timeout(std::time::Duration::from_secs(5), http_server)
        .await
        .map_err(|_| eyre!("mock HTTPS fallback server did not finish"))???;
    Ok(())
}

#[tokio::test]
async fn explicit_https_never_probes_the_websocket_endpoint() -> Result<()> {
    let websocket_listener = TcpListener::bind("127.0.0.1:0").await?;
    let websocket_url = format!("ws://{}", websocket_listener.local_addr()?);
    let http_listener = TcpListener::bind("127.0.0.1:0").await?;
    let api_base_url = format!("http://{}", http_listener.local_addr()?);

    let http_server = tokio::spawn(async move {
        let request = read_http_json(&http_listener).await?;
        send_http_events(
            request.stream,
            None,
            [completed_response("resp-https", "https only")],
        )
        .await
    });

    let openai = OpenAi::builder("test-key")
        .transport(ResponsesTransport::Https)
        .websocket_url(websocket_url)
        .api_base_url(api_base_url)
        .build()?;
    let mut session = openai.instructions("Use HTTPS only.").build()?;
    assert_eq!(
        session.turn().create("answer").await?.output_text(),
        "https only"
    );
    timeout(std::time::Duration::from_secs(5), http_server)
        .await
        .map_err(|_| eyre!("mock explicit HTTPS server did not finish"))???;
    assert!(
        timeout(
            std::time::Duration::from_millis(100),
            websocket_listener.accept()
        )
        .await
        .is_err(),
        "explicit HTTPS unexpectedly probed the WebSocket endpoint"
    );
    Ok(())
}

#[tokio::test]
async fn upgrade_required_falls_back_without_another_websocket_attempt() -> Result<()> {
    let websocket_listener = TcpListener::bind("127.0.0.1:0").await?;
    let websocket_url = format!("ws://{}", websocket_listener.local_addr()?);
    let http_listener = TcpListener::bind("127.0.0.1:0").await?;
    let api_base_url = format!("http://{}", http_listener.local_addr()?);

    let websocket_server = tokio::spawn(async move {
        let (stream, _) = websocket_listener.accept().await?;
        let rejected = accept_hdr_async(stream, |_request: &Request, response: Response| {
            let mut response = response.map(|()| Some("upgrade required".to_owned()));
            *response.status_mut() = StatusCode::UPGRADE_REQUIRED;
            Err(response)
        })
        .await;
        assert!(rejected.is_err());
        assert!(
            timeout(
                std::time::Duration::from_millis(250),
                websocket_listener.accept()
            )
            .await
            .is_err(),
            "HTTP 426 should switch transports without another WebSocket attempt"
        );
        Result::<()>::Ok(())
    });
    let http_server = tokio::spawn(async move {
        let request = read_http_json(&http_listener).await?;
        assert!(request.body.get("previous_response_id").is_none());
        assert!(request.body.to_string().contains("switch immediately"));
        send_http_events(
            request.stream,
            None,
            [completed_response("resp-upgrade", "upgraded")],
        )
        .await
    });

    let openai = OpenAi::builder("test-key")
        .websocket_url(websocket_url)
        .api_base_url(api_base_url)
        .max_attempts(NonZeroU32::new(3).unwrap())
        .build()?;
    let mut session = openai
        .instructions("Recover from unsupported WebSocket transport.")
        .build()?;
    assert_eq!(
        session
            .turn()
            .create("switch immediately")
            .await?
            .output_text(),
        "upgraded"
    );
    timeout(std::time::Duration::from_secs(5), websocket_server)
        .await
        .map_err(|_| eyre!("mock 426 WebSocket server did not finish"))???;
    timeout(std::time::Duration::from_secs(5), http_server)
        .await
        .map_err(|_| eyre!("mock 426 fallback HTTP server did not finish"))???;
    Ok(())
}

#[tokio::test]
async fn forbidden_websocket_handshake_retries_then_falls_back_to_https() -> Result<()> {
    let websocket_listener = TcpListener::bind("127.0.0.1:0").await?;
    let websocket_url = format!("ws://{}", websocket_listener.local_addr()?);
    let http_listener = TcpListener::bind("127.0.0.1:0").await?;
    let api_base_url = format!("http://{}", http_listener.local_addr()?);

    let websocket_server = tokio::spawn(async move {
        for attempt in 1..=2 {
            let (stream, _) = websocket_listener.accept().await?;
            let cf_ray = format!("ray-{attempt}").parse()?;
            let rejected =
                accept_hdr_async(stream, move |_request: &Request, response: Response| {
                    let mut response = response.map(|()| Some(String::new()));
                    *response.status_mut() = StatusCode::FORBIDDEN;
                    response.headers_mut().insert("cf-ray", cf_ray);
                    Err(response)
                })
                .await;
            assert!(rejected.is_err());
        }
        assert!(
            timeout(
                std::time::Duration::from_millis(250),
                websocket_listener.accept()
            )
            .await
            .is_err(),
            "HTTP 403 recovery exceeded the configured WebSocket attempt budget"
        );
        Result::<()>::Ok(())
    });
    let http_server = tokio::spawn(async move {
        let request = read_http_json(&http_listener).await?;
        assert!(request.body.get("previous_response_id").is_none());
        assert!(
            request
                .body
                .to_string()
                .contains("recover forbidden upgrade")
        );
        send_http_events(
            request.stream,
            None,
            [completed_response("resp-forbidden", "recovered")],
        )
        .await
    });

    let openai = OpenAi::builder("test-key")
        .websocket_url(websocket_url)
        .api_base_url(api_base_url)
        .max_attempts(NonZeroU32::new(2).unwrap())
        .build()?;
    let mut session = openai
        .instructions("Recover transient WebSocket upgrade failures.")
        .build()?;
    assert_eq!(
        session
            .turn()
            .create("recover forbidden upgrade")
            .await?
            .output_text(),
        "recovered"
    );
    timeout(std::time::Duration::from_secs(5), websocket_server)
        .await
        .map_err(|_| eyre!("mock 403 WebSocket server did not finish"))???;
    timeout(std::time::Duration::from_secs(5), http_server)
        .await
        .map_err(|_| eyre!("mock 403 fallback HTTP server did not finish"))???;
    Ok(())
}

async fn next_ws_json<S>(socket: &mut WebSocketStream<S>) -> Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| eyre!("WebSocket closed before the client request"))??;
        if let Message::Text(text) = message {
            return Ok(serde_json::from_str(text.as_str())?);
        }
    }
}

async fn send_ws_json<S>(socket: &mut WebSocketStream<S>, value: Value) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket.send(Message::Text(value.to_string().into())).await?;
    Ok(())
}

struct CapturedHttpRequest {
    stream: TcpStream,
    headers: String,
    body: Value,
}

async fn read_http_json(listener: &TcpListener) -> Result<CapturedHttpRequest> {
    let (mut stream, _) = listener.accept().await?;
    let mut bytes = Vec::with_capacity(4_096);
    let header_end = loop {
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if stream.read_buf(&mut bytes).await? == 0 {
            return Err(eyre!("HTTP request ended before its headers"));
        }
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec())?.to_ascii_lowercase();
    let content_length = headers
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .map(str::trim)
        .ok_or_else(|| eyre!("HTTP request omitted Content-Length"))?
        .parse::<usize>()?;
    while bytes.len().saturating_sub(header_end) < content_length {
        if stream.read_buf(&mut bytes).await? == 0 {
            return Err(eyre!("HTTP request body ended early"));
        }
    }
    let body = serde_json::from_slice(&bytes[header_end..header_end + content_length])?;
    Ok(CapturedHttpRequest {
        stream,
        headers,
        body,
    })
}

fn turn_state(headers: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        line.strip_prefix(TURN_STATE_HEADER)
            .and_then(|value| value.strip_prefix(':'))
            .map(str::trim)
            .map(str::to_owned)
    })
}

async fn send_http_events(
    mut stream: TcpStream,
    turn_state: Option<&str>,
    events: impl IntoIterator<Item = Value>,
) -> Result<()> {
    let mut body = String::new();
    for event in events {
        body.push_str("data: ");
        body.push_str(&event.to_string());
        body.push_str("\n\n");
    }
    body.push_str("data: [DONE]\n\n");
    let turn_state = turn_state.map_or_else(String::new, |value| {
        format!("{TURN_STATE_HEADER}: {value}\r\n")
    });
    stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\
                 content-length: {}\r\n{turn_state}connection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    stream.shutdown().await?;
    Ok(())
}

fn completed_response(response_id: &str, text: &str) -> Value {
    json!({
        "type": "response.completed",
        "response": {
            "id": response_id,
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": text }]
            }],
            "usage": null
        }
    })
}

#[tokio::test]
async fn compaction_falls_back_after_two_retries_and_preserves_history_on_exhaustion() -> Result<()>
{
    let websocket_listener = TcpListener::bind("127.0.0.1:0").await?;
    let websocket_url = format!("ws://{}", websocket_listener.local_addr()?);
    let http_listener = TcpListener::bind("127.0.0.1:0").await?;
    let api_base_url = format!("http://{}", http_listener.local_addr()?);
    let websocket_server = tokio::spawn(async move {
        for attempt in 0..3 {
            let (stream, _) = websocket_listener.accept().await?;
            let mut socket = accept_async(stream).await?;
            if attempt == 0 {
                next_ws_json(&mut socket).await?;
                send_ws_json(&mut socket, completed_response("resp-before", "remembered")).await?;
            }
            let compact = next_ws_json(&mut socket).await?;
            assert_eq!(
                compact["input"].as_array().unwrap().last().unwrap()["type"],
                "compaction_trigger"
            );
            if attempt > 0 {
                assert!(compact.get("previous_response_id").is_none());
                assert!(compact.to_string().contains("keep build req_7f3"));
            }
            // Abrupt closure reproduces the incident's transport error.
            drop(socket);
        }
        Ok::<_, eyre::Report>(websocket_listener)
    });
    let http_server = tokio::spawn(async move {
        for _ in 0..3 {
            let mut request = read_http_json(&http_listener).await?;
            assert!(request.body.get("previous_response_id").is_none());
            assert!(request.body.get("type").is_none());
            assert_eq!(request.body["stream"], true);
            assert!(request.body.to_string().contains("keep build req_7f3"));
            assert_eq!(
                request.body["input"].as_array().unwrap().last().unwrap()["type"],
                "compaction_trigger"
            );
            request.stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
            request.stream.shutdown().await?;
        }
        Ok::<_, eyre::Report>(http_listener)
    });
    let openai = OpenAi::builder("test-key")
        .websocket_url(websocket_url)
        .api_base_url(api_base_url)
        .build()?;
    let mut session = openai.instructions("Preserve exact identifiers.").build()?;
    session.turn().create("keep build req_7f3").await?;
    let original_history = serde_json::to_value(session.history().collect::<Vec<_>>())?;
    let error = timeout(std::time::Duration::from_secs(10), session.turn().compact())
        .await?
        .err()
        .expect("both transport budgets must exhaust");
    assert!(error.to_string().contains("503"), "{error}");
    assert_eq!(
        serde_json::to_value(session.history().collect::<Vec<_>>())?,
        original_history
    );
    let websocket_listener = websocket_server.await??;
    let http_listener = http_server.await??;
    assert!(
        timeout(
            std::time::Duration::from_millis(50),
            websocket_listener.accept()
        )
        .await
        .is_err()
    );
    assert!(
        timeout(std::time::Duration::from_millis(50), http_listener.accept())
            .await
            .is_err()
    );
    Ok(())
}

/// Real public SDK journey: the last WS response carries overload advice;
/// HTTPS must not start until that receipt-time deadline, even for compaction.
#[tokio::test]
async fn last_websocket_advice_delays_sampling_fallback() -> Result<()> {
    advised_fallback_journey(false).await
}

#[tokio::test]
async fn last_websocket_advice_delays_manual_compaction_fallback() -> Result<()> {
    advised_fallback_journey(true).await
}

async fn advised_fallback_journey(compact: bool) -> Result<()> {
    use std::time::{Duration, Instant};
    let websocket_listener = TcpListener::bind("127.0.0.1:0").await?;
    let http_listener = TcpListener::bind("127.0.0.1:0").await?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(format!("ws://{}", websocket_listener.local_addr()?))
        .api_base_url(format!("http://{}", http_listener.local_addr()?))
        .max_attempts(NonZeroU32::new(1).unwrap())
        .build()?;
    let (sent, received) = tokio::sync::oneshot::channel();
    let websocket_server = tokio::spawn(async move {
        let (stream, _) = websocket_listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        let initial = next_ws_json(&mut socket).await?;
        assert!(initial.to_string().contains("deadline fixture"));
        if compact {
            send_ws_json(&mut socket, completed_response("resp-before", "remembered")).await?;
            let request = next_ws_json(&mut socket).await?;
            assert_eq!(
                request["input"].as_array().unwrap().last().unwrap()["type"],
                "compaction_trigger"
            );
        }
        let deadline = Instant::now() + Duration::from_millis(200);
        sent.send(deadline).unwrap();
        send_ws_json(
            &mut socket,
            json!({"type": "response.failed", "response": {
                "error": {"code": "server_is_overloaded", "retry_after": 0.2}
            }}),
        )
        .await?;
        // Keep the listener, so an unexpected extra WS attempt is detectable.
        Ok::<_, eyre::Report>(websocket_listener)
    });
    let http_server = tokio::spawn(async move {
        let deadline = received.await?;
        let request = read_http_json(&http_listener).await?;
        assert!(Instant::now() >= deadline, "HTTPS bypassed final WS advice");
        assert!(request.body.get("previous_response_id").is_none());
        assert!(request.body.to_string().contains("deadline fixture"));
        if compact {
            assert_eq!(
                request.body["input"].as_array().unwrap().last().unwrap()["type"],
                "compaction_trigger"
            );
            send_http_events(request.stream, None, [
                json!({"type": "response.output_item.done", "item": {
                    "id": "cmp-deadline", "type": "compaction", "encrypted_content": "retained-summary"
                }}), completed_response("resp-compacted", "")
            ]).await?;
        } else {
            send_http_events(
                request.stream,
                None,
                [completed_response("resp-fallback", "deadline respected")],
            )
            .await?;
        }
        Ok::<_, eyre::Report>(http_listener)
    });
    let mut session = openai
        .instructions("Preserve identifiers across retries.")
        .build()?;
    if compact {
        session.turn().create("deadline fixture").await?;
        session.turn().compact().await?;
    } else {
        assert_eq!(
            session
                .turn()
                .create("deadline fixture")
                .await?
                .output_text(),
            "deadline respected"
        );
    }
    let ws = websocket_server.await??;
    let http = http_server.await??;
    assert!(
        timeout(Duration::from_millis(20), ws.accept())
            .await
            .is_err()
    );
    assert!(
        timeout(Duration::from_millis(20), http.accept())
            .await
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn quota_usage_and_policy_http_errors_with_advice_are_terminal() -> Result<()> {
    for code in [
        "insufficient_quota",
        "usage_not_included",
        "cyber_policy",
        "bio_policy",
        "misalignment_policy_violation",
    ] {
        for discriminator in ["code", "type", "mixed"] {
            for status in [429, 500] {
                let listener = TcpListener::bind("127.0.0.1:0").await?;
                let openai = OpenAi::builder("test-key")
                    .transport(ResponsesTransport::Https)
                    .api_base_url(format!("http://{}", listener.local_addr()?))
                    .build()?;
                let mut payload = json!({"error": {}});
                if discriminator == "mixed" {
                    payload["code"] = json!("rate_limit_exceeded");
                    payload["error"]["code"] = json!("server_error");
                    payload["error"]["type"] = json!(code);
                } else {
                    payload["error"][discriminator] = json!(code);
                }
                let body = payload.to_string();
                let server = tokio::spawn(async move {
                    let mut request = read_http_json(&listener).await?;
                    request.stream.write_all(format!("HTTP/1.1 {status} Provider Rejection\r\nRetry-After: 10\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await?;
                    request.stream.shutdown().await?;
                    Ok::<_, eyre::Report>(listener)
                });
                let mut session = openai.instructions("Return terminal failures.").build()?;
                let error = match timeout(
                    std::time::Duration::from_secs(2),
                    session.turn().create("terminal fixture"),
                )
                .await?
                {
                    Ok(_) => panic!("terminal provider rejection unexpectedly succeeded"),
                    Err(error) => error,
                };
                assert!(error.to_string().contains(code));
                let listener = server.await??;
                assert!(
                    timeout(std::time::Duration::from_millis(20), listener.accept())
                        .await
                        .is_err(),
                    "{code} retried"
                );
            }
        }
    }
    Ok(())
}

#[tokio::test]
async fn rejected_https_body_processing_does_not_restart_numeric_advice() -> Result<()> {
    delayed_http_body_journey("1".to_owned()).await
}

#[tokio::test]
async fn rejected_https_body_processing_does_not_restart_http_date_advice() -> Result<()> {
    delayed_http_body_journey("date".to_owned()).await
}

// A transport trace acknowledges the *client's* captured header advice, rather
// than treating a server write as proof of receipt. The server does not send its
// body until that acknowledgement plus enough real time to expire the advice.
// Tokio's paused-clock auto-advance is deliberately not mixed with real TCP IO.
async fn delayed_http_body_journey(header: String) -> Result<()> {
    use std::future::IntoFuture;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use tracing::instrument::WithSubscriber;
    use tracing_subscriber::prelude::*;

    struct CaptureHeaders(Arc<Mutex<Option<tokio::sync::oneshot::Sender<u64>>>>);
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CaptureHeaders {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _context: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if event.metadata().target() != "nanocodex::responses::http" {
                return;
            }
            #[derive(Default)]
            struct Deadline(Option<u64>);
            impl tracing::field::Visit for Deadline {
                fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
                    if field.name() == "retry_after_deadline_ms" {
                        self.0 = Some(value);
                    }
                }
                fn record_debug(
                    &mut self,
                    _field: &tracing::field::Field,
                    _value: &dyn std::fmt::Debug,
                ) {
                }
            }
            let mut deadline = Deadline::default();
            event.record(&mut deadline);
            if let Some(deadline) = deadline.0
                && let Some(sender) = self.0.lock().unwrap().take()
            {
                let _ = sender.send(deadline);
            }
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let openai = OpenAi::builder("test-key")
        .transport(ResponsesTransport::Https)
        .api_base_url(format!("http://{}", listener.local_addr()?))
        .max_attempts(NonZeroU32::new(2).unwrap())
        .build()?;
    let (captured, receipt) = tokio::sync::oneshot::channel();
    let dispatch = tracing::Dispatch::new(
        tracing_subscriber::registry().with(CaptureHeaders(Arc::new(Mutex::new(Some(captured))))),
    );
    // Avoid tracing's single-dispatcher fast path caching no interest in a
    // parallel test before this scoped subscriber encounters the callsite.
    let _parallel_test_registration =
        tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    let server = tokio::spawn(async move {
        let mut initial = read_http_json(&listener).await?;
        // Construct date advice only when the actual fixture request arrives;
        // client initialization is not part of the server's advised interval.
        let is_date = header == "date";
        let header = if is_date {
            httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(2))
        } else {
            header
        };
        let headers_written_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
        initial.stream.write_all(format!("HTTP/1.1 503 Service Unavailable\r\nRetry-After: {header}\r\nContent-Length: 1\r\nConnection: close\r\n\r\n").as_bytes()).await?;
        // This fails if advice is moved after response.text(): the withheld
        // body cannot finish and no header-receipt acknowledgement can arrive.
        let deadline_ms = timeout(Duration::from_secs(5), receipt).await??;
        if header == "1" {
            assert!(deadline_ms >= headers_written_ms + 1_000);
        } else {
            let date_ms = httpdate::parse_http_date(&header)?
                .duration_since(UNIX_EPOCH)?
                .as_millis() as u64;
            assert!(
                deadline_ms.abs_diff(date_ms) <= 1,
                "HTTP-date deadline changed at receipt"
            );
        }
        println!(
            "rejected HTTP header advice captured before body: header={header}, deadline_ms={deadline_ms}"
        );
        tokio::time::sleep(Duration::from_millis(if is_date { 2_500 } else { 1_500 })).await;
        let body_finished = Instant::now();
        initial.stream.write_all(b"x").await?;
        initial.stream.shutdown().await?;
        // A restarted numeric interval is 1s; a header-receipt deadline is
        // already expired. Bound actual next-request IO well below that 1s.
        let retried = timeout(Duration::from_millis(500), read_http_json(&listener)).await??;
        assert!(
            body_finished.elapsed() < Duration::from_millis(500),
            "expired server deadline restarted after body processing"
        );
        send_http_events(
            retried.stream,
            None,
            [completed_response(
                "resp-body",
                "receipt deadline respected",
            )],
        )
        .await?;
        Ok::<_, eyre::Report>(())
    });
    let mut session = openai
        .instructions("Use receipt-time retry deadlines.")
        .build()?;
    let mut turn = session.turn();
    let completed = IntoFuture::into_future(turn.create("delayed HTTP body fixture"))
        .with_subscriber(dispatch)
        .await?;
    assert_eq!(completed.output_text(), "receipt deadline respected");
    server.await??;
    Ok(())
}

#[tokio::test]
async fn terminal_upgrade_rejection_never_activates_https_fallback() -> Result<()> {
    let websocket_listener = TcpListener::bind("127.0.0.1:0").await?;
    let http_listener = TcpListener::bind("127.0.0.1:0").await?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(format!("ws://{}", websocket_listener.local_addr()?))
        .api_base_url(format!("http://{}", http_listener.local_addr()?))
        .max_attempts(NonZeroU32::new(1).unwrap())
        .build()?;
    let server = tokio::spawn(async move {
        let (stream, _) = websocket_listener.accept().await?;
        let result = accept_hdr_async(stream, |_request: &Request, response: Response| {
            let mut rejection = response
                .map(|()| Some(json!({"error": {"type": "insufficient_quota"}}).to_string()));
            *rejection.status_mut() = StatusCode::UPGRADE_REQUIRED;
            rejection
                .headers_mut()
                .insert("retry-after", "10".parse().unwrap());
            Err(rejection)
        })
        .await;
        assert!(result.is_err());
        Ok::<_, eyre::Report>(websocket_listener)
    });
    let mut session = openai
        .instructions("Do not retry terminal provider errors.")
        .build()?;
    let error = match timeout(
        std::time::Duration::from_secs(2),
        session.turn().create("terminal upgrade fixture"),
    )
    .await?
    {
        Ok(_) => panic!("terminal upgrade unexpectedly succeeded"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("insufficient_quota"));
    let ws = server.await??;
    assert!(
        timeout(std::time::Duration::from_millis(20), ws.accept())
            .await
            .is_err()
    );
    assert!(
        timeout(std::time::Duration::from_millis(20), http_listener.accept())
            .await
            .is_err()
    );
    Ok(())
}

/// A public streaming caller stalls after the first delta while the native
/// socket pump receives an error. Resuming the observer must not restart advice.
#[tokio::test]
async fn delayed_stream_observer_does_not_restart_queued_websocket_advice() -> Result<()> {
    use futures_util::TryStreamExt;
    use std::time::{Duration, Instant};
    let websocket_listener = TcpListener::bind("127.0.0.1:0").await?;
    let http_listener = TcpListener::bind("127.0.0.1:0").await?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(format!("ws://{}", websocket_listener.local_addr()?))
        .api_base_url(format!("http://{}", http_listener.local_addr()?))
        .max_attempts(NonZeroU32::new(1).unwrap())
        .build()?;
    let (delta_seen, send_error) = tokio::sync::oneshot::channel();
    let (error_sent, await_error) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = websocket_listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        next_ws_json(&mut socket).await?;
        send_ws_json(
            &mut socket,
            json!({"type": "response.output_text.delta", "output_index": 0, "delta": "partial"}),
        )
        .await?;
        send_error.await?;
        send_ws_json(&mut socket, json!({"type": "response.failed", "response": {"error": {"code": "server_is_overloaded", "retry_after": 0.5}}})).await?;
        error_sent.send(()).unwrap();
        let request = read_http_json(&http_listener).await?;
        send_http_events(
            request.stream,
            None,
            [completed_response("resp-observer", "observer resumed")],
        )
        .await?;
        Ok::<_, eyre::Report>(())
    });
    let mut session = openai.instructions("Use original receipt time.").build()?;
    let mut turn = session.turn();
    let mut response = turn.create("delayed observer fixture");
    assert!(response.try_next().await?.is_some());
    delta_seen.send(()).unwrap();
    await_error.await?;
    // Advice expires while the application does not poll its response at all.
    tokio::time::sleep(Duration::from_millis(750)).await;
    let resumed = Instant::now();
    assert_eq!(
        timeout(Duration::from_millis(300), response)
            .await??
            .output_text(),
        "observer resumed"
    );
    assert!(resumed.elapsed() < Duration::from_millis(300));
    server.await??;
    Ok(())
}
