//! Real CLI journeys; only the external model providers are synthetic.
//! Evidence: output/harness-routing/<journey>-<uuid>/ includes scenario, outcome,
//! provider requests, and CLI output or the raw terminal transcript.
use std::{
    collections::HashMap,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    pin::Pin,
    process::{Output, Stdio},
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

use axum::{Json, Router, response::IntoResponse, routing::post, serve::ListenerExt as _};
use eyre::{Result, eyre};
use futures_util::{SinkExt as _, StreamExt as _};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde_json::{Value, json};
use tokio::{net::TcpListener, process::Command, time::timeout};
use tokio_tungstenite::{accept_async, tungstenite::Message};

const CODEX_MODEL: &str = "gpt-6.1-sol";
const CLAUDE_MODEL: &str = "claude-sonnet-5-5";
const LIMIT: Duration = Duration::from_secs(45);

#[derive(Clone, Copy, PartialEq)]
enum Journey {
    Smoke,
    Mixed,
    MissingChildAuth,
}

struct Provider {
    root: &'static str,
    journey: Journey,
    counts: HashMap<String, usize>,
    log: Vec<Value>,
    artifact: PathBuf,
    pauses: usize,
    cancellations: usize,
    connections: Vec<Value>,
}

impl Provider {
    fn connected(&mut self, family: &str) {
        self.connections
            .push(json!({"family":family,"connection":self.connections.len()+1}));
        std::fs::write(
            self.artifact.join("connections.json"),
            serde_json::to_vec_pretty(&self.connections).unwrap(),
        )
        .unwrap();
    }
    fn respond(&mut self, family: &str, label: &str, request: Value) -> Reply {
        let stage = *self.counts.entry(label.into()).or_default();
        *self.counts.get_mut(label).unwrap() += 1;
        let reply = self.script(label, stage);
        if matches!(reply, Reply::Pause) {
            self.pauses += 1;
        }
        self.log.push(
            json!({"family":family,"label":label,"stage":stage,"model":request["model"],
            "tool_result":last_tool_result(&request),"request":request,"reply":reply.value()}),
        );
        std::fs::write(
            self.artifact.join("provider.json"),
            serde_json::to_vec_pretty(&self.log).unwrap(),
        )
        .unwrap();
        reply
    }

    fn script(&self, label: &str, stage: usize) -> Reply {
        if self.journey == Journey::Smoke {
            return Reply::Text("claude-only-answer".into());
        }
        let other = if self.root == "codex" {
            "claude"
        } else {
            "codex"
        };
        let spawn = |family: Option<&str>, task: &str| {
            let mut value =
                json!({"role":task,"task":task,"output_contract":contract(),"thinking":null});
            if let Some(family) = family {
                value["harness"] = json!(family);
                value["model"] = json!(model(family));
            }
            value.to_string()
        };
        if self.journey == Journey::MissingChildAuth {
            return if stage == 0 {
                Reply::Code(format!(
                    "let denied=false; try {{ await tools.spawn_agent({}); }} catch(e) {{ denied=true; text(String(e)); }} if(!denied) throw Error('missing credentials admitted'); const d=await tools.list_agents({{include_completed:true}}); if(d.agents.length) throw Error('failed spawn retained child'); text('auth-denied-ok');",
                    spawn(Some(other), "AUTH_CHILD")
                ))
            } else {
                Reply::Text("auth-denied-answer".into())
            };
        }
        match (label, stage) {
            ("root", 0) => Reply::Code(format!(r#"
const base={}; let rejected=0;
for(const override of [{{harness:'bogus'}},{{harness:'claude',model:'sol'}},{{harness:'codex',model:'claude-sonnet-4-6'}}]) {{
  try {{ await tools.spawn_agent({{...base,...override}}); }} catch(e) {{ rejected++; text(String(e)); }}
}}
if(rejected!==3) throw Error('invalid selection admitted');
const empty=await tools.list_agents({{include_completed:true}}); if(empty.agents.length) throw Error('invalid selection had registry effects');
const c=await tools.spawn_agent({}); store('child',c.agent_id);
const w=await tools.wait_agent({{agent_ids:[c.agent_id],timeout_ms:20000}}); text(w);
if(w.timed_out || w.agents[0].status.state!=='completed' || w.agents[0].status.output.answer!=='nested-answer') throw Error('mixed child failed');
const inherited=await tools.spawn_agent({});
const same=await tools.wait_agent({{agent_ids:[inherited.agent_id],timeout_ms:20000}}); text(same);
if(same.timed_out || same.agents[0].status.output.answer!=='inherited-answer') throw Error('inheritance failed');
text('nested-and-inherited-ok');
"#, spawn(None,"INVALID_CHILD"), spawn(Some(other),"MIXED_CHILD"), spawn(None,"INHERITED_CHILD"))),
            ("root", 1) => Reply::Code(r#"
const id=load('child'); const receipt=await tools.send_agent_message({agent_id:id,message:'FOLLOWUP_CHILD'}); text(receipt);
const w=await tools.wait_agent({agent_ids:[id],timeout_ms:20000}); text(w);
if(w.timed_out || w.agents[0].status.state!=='completed' || w.agents[0].status.output.answer!=='followup-answer') throw Error('reuse failed');
text('reuse-ok');
"#.into()),
            ("root", 2) => Reply::Code(r#"
const c=await tools.close_agent({agent_id:load('child')}); text(c);
if(c.agents.length!==2 || c.agents.some(a=>a.status.state!=='closed')) throw Error('subtree not closed');
let denied=false; try { await tools.send_agent_message({agent_id:load('child'),message:'cannot revive'}); } catch(e) { denied=true; text(String(e)); }
if(!denied) throw Error('closed child reused');
text(await tools.list_agents({include_completed:true})); text('closed-subtree-ok');
"#.into()),
            ("root", 3) => Reply::Code(format!(r#"
const c=await tools.spawn_agent({});
const waiting=await tools.wait_agent({{agent_ids:[c.agent_id],timeout_ms:1000}}); text(waiting);
if(!waiting.timed_out || waiting.agents[0].status.state!=='running') throw Error('paused child did not remain active');
const interrupted=await tools.interrupt_agent({{agent_id:c.agent_id}}); text(interrupted);
if(interrupted.agents.length!==2 || interrupted.agents.some(a=>a.status.state!=='interrupted')) throw Error('mixed subtree not interrupted');
const closed=await tools.close_agent({{agent_id:c.agent_id}}); text(closed);
if(closed.agents.length!==2 || closed.agents.some(a=>a.status.state!=='closed')) throw Error('interrupted subtree not closed');
text('paused-subtree-released-ok');
"#,spawn(Some(other),"PAUSED_CHILD"))),
            ("root", _) => Reply::Text("mixed-routing-answer".into()),
            ("paused-child", 0) => Reply::Code(format!("const c=await tools.spawn_agent({}); text(await tools.wait_agent({{agent_ids:[c.agent_id],timeout_ms:20000}}));",spawn(Some(self.root),"PAUSED_GRANDCHILD"))),
            ("paused-grandchild", _) => Reply::Pause,
            ("child", 0) => Reply::Code(format!(r#"
const c=await tools.spawn_agent({}); const w=await tools.wait_agent({{agent_ids:[c.agent_id],timeout_ms:20000}}); text(w);
if(w.timed_out || w.agents[0].status.state!=='completed' || w.agents[0].status.output.answer!=='grandchild-answer') throw Error('grandchild failed');
text('grandchild-ok');
"#,spawn(Some(self.root),"MIXED_GRANDCHILD"))),
            ("child", 1) => Reply::Code(r#"
let denied=false; try { await tools.submit_result({output:{answer:42}}); } catch(e) { denied=true; text(String(e)); }
if(!denied) throw Error('invalid output contract admitted');
const receipt=await tools.submit_result({output:{answer:'nested-answer'}}); text(receipt);
if(!receipt.accepted) throw Error('valid output rejected'); text('contract-recovered-ok');
"#.into()),
            ("child", _) => Reply::Text("child finished".into()),
            ("followup", 0) => Reply::Code("text(await tools.submit_result({output:{answer:'followup-answer'}}));".into()),
            ("followup", _) => Reply::Text("followup finished".into()),
            ("grandchild", 0) if self.root == "claude" => Reply::Write,
            ("grandchild", 1) if self.root == "claude" => Reply::Code("text(await tools.submit_result({output:{answer:'grandchild-answer'}}));".into()),
            ("grandchild", 0) => Reply::Code(r#"
text(await tools.exec_command({cmd:"printf 'grandchild-effect' > grandchild.txt",shell:'/bin/sh',login:false}));
text(await tools.submit_result({output:{answer:'grandchild-answer'}}));
"#.into()),
            ("grandchild", _) => Reply::Text("grandchild finished".into()),
            ("inherited", 0) => Reply::Code("text(await tools.submit_result({output:{answer:'inherited-answer'}}));".into()),
            ("inherited", _) => Reply::Text("inherited finished".into()),
            _ => Reply::Text("unexpected fixture request".into()),
        }
    }
}

enum Reply {
    Code(String),
    Text(String),
    Write,
    Pause,
}
impl Reply {
    fn value(&self) -> Value {
        match self {
            Self::Code(code) => json!({"code":code}),
            Self::Text(text) => json!({"text":text}),
            Self::Write => {
                json!({"tool":"Write","file_path":"grandchild.txt","content":"grandchild-effect"})
            }
            Self::Pause => json!({"paused":true}),
        }
    }
    fn codex(&self, id: &str) -> Value {
        let output = match self {
            Self::Code(code) => {
                json!({"type":"custom_tool_call","name":"exec","call_id":id,"input":code})
            }
            Self::Text(text) => {
                json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]})
            }
            Self::Write => unreachable!("native Claude Write cannot route to Responses"),
            Self::Pause => unreachable!("paused generation has no terminal response"),
        };
        json!({"type":"response.completed","response":{"id":id,"status":"completed","output":[output],
            "usage":{"input_tokens":1,"input_tokens_details":{"cached_tokens":0},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":2}}})
    }
    fn claude(&self, id: &str) -> String {
        let (block, delta, stop) = match self {
            Self::Code(code) => (
                json!({"type":"tool_use","id":id,"name":"exec","input":{}}),
                json!({"type":"input_json_delta","partial_json":json!({"code":code}).to_string()}),
                "tool_use",
            ),
            Self::Text(text) => (
                json!({"type":"text","text":""}),
                json!({"type":"text_delta","text":text}),
                "end_turn",
            ),
            Self::Write => (
                json!({"type":"tool_use","id":id,"name":"Write","input":{}}),
                json!({"type":"input_json_delta","partial_json":json!({"file_path":"grandchild.txt","content":"grandchild-effect"}).to_string()}),
                "tool_use",
            ),
            Self::Pause => unreachable!("paused generation has no terminal response"),
        };
        [json!({"type":"message_start","message":{"id":id,"type":"message","role":"assistant","model":CLAUDE_MODEL,"content":[],"usage":{"input_tokens":1,"output_tokens":0}}}),
            json!({"type":"content_block_start","index":0,"content_block":block}),
            json!({"type":"content_block_delta","index":0,"delta":delta}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":1}}),
            json!({"type":"message_stop"})].iter().map(|event|format!("data: {event}\n\n")).collect()
    }
}

fn contract() -> Value {
    json!({"kind":"object","fields":[{"name":"answer","required":true,"schema":{"kind":"string"}}]})
}
fn model(family: &str) -> &'static str {
    if family == "claude" {
        CLAUDE_MODEL
    } else {
        CODEX_MODEL
    }
}

// Routing uses user input only, never a tool catalog or fixture-script copy.
fn label(request: &Value) -> String {
    let input = request
        .get("messages")
        .or_else(|| request.get("input"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item["role"] == "user")
        .flat_map(|item| match &item["content"] {
            Value::String(text) => vec![text.clone()],
            Value::Array(blocks) => blocks
                .iter()
                .filter(|block| block["type"] == "text" || block["type"] == "input_text")
                .filter_map(|block| block["text"].as_str().map(str::to_owned))
                .collect(),
            _ => vec![],
        })
        .collect::<Vec<_>>()
        .join("\n");
    if input.contains("PAUSED_GRANDCHILD") {
        "paused-grandchild"
    } else if input.contains("PAUSED_CHILD") {
        "paused-child"
    } else if input.contains("FOLLOWUP_CHILD") {
        "followup"
    } else if input.contains("MIXED_GRANDCHILD") {
        "grandchild"
    } else if input.contains("INHERITED_CHILD") {
        "inherited"
    } else if input.contains("MIXED_CHILD") {
        "child"
    } else {
        "root"
    }
    .into()
}

fn last_tool_result(request: &Value) -> Value {
    if let Some(messages) = request["messages"].as_array() {
        return messages
            .iter()
            .rev()
            .filter_map(|m| m["content"].as_array())
            .flat_map(|blocks| blocks.iter().rev())
            .find(|b| b["type"] == "tool_result")
            .map(|b| b["content"].clone())
            .unwrap_or(Value::Null);
    }
    request["input"]
        .as_array()
        .and_then(|items| {
            items.iter().rev().find(|item| {
                item["type"] == "custom_tool_call_output" || item["type"] == "function_call_output"
            })
        })
        .map(|item| item["output"].clone())
        .unwrap_or(Value::Null)
}

struct Servers {
    codex: String,
    claude: String,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

struct PauseGuard {
    state: Arc<Mutex<Provider>>,
    observed: bool,
}
impl Drop for PauseGuard {
    fn drop(&mut self) {
        if !self.observed {
            return;
        }
        let mut state = self.state.lock().unwrap();
        state.cancellations += 1;
        std::fs::write(
            state.artifact.join("paused-provider.json"),
            serde_json::to_vec_pretty(
                &json!({"started":state.pauses,"released":state.cancellations}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}
struct PausedStream {
    _guard: PauseGuard,
}
impl futures_util::Stream for PausedStream {
    type Item = std::result::Result<axum::body::Bytes, std::convert::Infallible>;
    fn poll_next(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Pending
    }
}
impl Drop for Servers {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn servers(provider: Arc<Mutex<Provider>>) -> Result<Servers> {
    let http = TcpListener::bind("127.0.0.1:0").await?;
    let claude = format!("http://{}/v1/messages", http.local_addr()?);
    let state = Arc::clone(&provider);
    let router = Router::new().route(
        "/v1/messages",
        post(move |Json(request): Json<Value>| {
            let state = Arc::clone(&state);
            async move {
                let label = label(&request);
                let reply = state.lock().unwrap().respond("claude", &label, request);
                if matches!(reply, Reply::Pause) {
                    return axum::response::Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(axum::body::Body::from_stream(PausedStream {
                            _guard: PauseGuard {
                                state,
                                observed: true,
                            },
                        }))
                        .unwrap();
                }
                (
                    [("content-type", "text/event-stream")],
                    reply.claude(&uuid::Uuid::new_v4().to_string()),
                )
                    .into_response()
            }
        }),
    );
    let connections = Arc::clone(&provider);
    let http = http.tap_io(move |_| connections.lock().unwrap().connected("claude"));
    let http_task = tokio::spawn(async move {
        axum::serve(http, router).await.unwrap();
    });
    let ws = TcpListener::bind("127.0.0.1:0").await?;
    let codex = format!("ws://{}", ws.local_addr()?);
    let ws_task = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let (stream, _) = ws.accept().await.unwrap();
            provider.lock().unwrap().connected("codex");
            let state = Arc::clone(&provider);
            connections.spawn(async move {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                let mut session_label = None;
                while let Some(Ok(message)) = socket.next().await {
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let request: Value = serde_json::from_str(text.as_str()).unwrap();
                    let current = label(&request);
                    if session_label.is_none() || current == "followup" {
                        session_label = Some(current);
                    }
                    let reply = state.lock().unwrap().respond(
                        "codex",
                        session_label.as_deref().unwrap(),
                        request,
                    );
                    if matches!(reply, Reply::Pause) {
                        let mut guard = PauseGuard {
                            state: Arc::clone(&state),
                            observed: false,
                        };
                        guard.observed = timeout(Duration::from_secs(20), async {
                            while let Some(Ok(message)) = socket.next().await {
                                if matches!(message, Message::Close(_)) {
                                    break;
                                }
                            }
                        })
                        .await
                        .is_ok();
                        break;
                    }
                    if socket
                        .send(Message::Text(
                            reply
                                .codex(&uuid::Uuid::new_v4().to_string())
                                .to_string()
                                .into(),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
    });
    Ok(Servers {
        codex,
        claude,
        tasks: vec![http_task, ws_task],
    })
}

fn command(
    workspace: &Path,
    endpoints: &Servers,
    family: &str,
    with_codex_auth: bool,
    with_claude_auth: bool,
    root_prompt: bool,
) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nanocodex"));
    if !root_prompt {
        command.arg("run");
    }
    command
        .current_dir(workspace)
        .env_clear()
        .env("HOME", workspace.join("home"))
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("CODEX_HOME", workspace.join("codex-home"))
        .env("NANOCODEX_COMPUTER", "off")
        .args([
            "--thinking",
            "medium",
            "--websocket-url",
            &endpoints.codex,
            "--claude-messages-url",
            &endpoints.claude,
            "--websocket-warmup",
            "false",
            "--responses-transport",
            "websocket",
            "--store-responses",
            "false",
            "--rollouts",
            "false",
            "--browser=none",
            "--mcp-defaults",
            "false",
            "--mcp-codex-config",
            "false",
            "--web-search",
            "false",
            "--image-generation",
            "false",
            "--subagents",
            "true",
            "--memory",
            "false",
        ])
        .arg("--cwd")
        .arg(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if family == "claude" {
        command.arg("--claude");
    }
    if with_codex_auth {
        command.args(["--api-key", "synthetic-openai-key"]);
    }
    if with_claude_auth {
        command.args(["--claude-api-key", "synthetic-anthropic-key"]);
    }
    command
}

fn artifact(name: &str) -> Result<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../output/harness-routing")
        .join(format!("{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(path.join("workspace/home"))?;
    std::fs::write(path.join("provider.json"), "[]\n")?;
    std::fs::write(path.join("connections.json"), "[]\n")?;
    Ok(path)
}

async fn run(mut command: Command, artifact: &Path, expected: &str) -> Result<Output> {
    std::fs::write(
        artifact.join("scenario.json"),
        serde_json::to_vec_pretty(&json!({
        "reproduce":"cargo test --locked -p nanocodex-bin --test harness_routing -- --nocapture",
        "command":format!("{command:?}"),"expected":expected,
        "boundary":"shipped nanocodex executable, native Code Mode/tools/subagent registry; only external providers use loopback fixtures"}))?,
    )?;
    let output = timeout(LIMIT, command.output())
        .await
        .map_err(|_| eyre!("CLI timeout; inspect {}", artifact.display()))??;
    std::fs::write(artifact.join("stdout.jsonl"), &output.stdout)?;
    std::fs::write(artifact.join("stderr.log"), &output.stderr)?;
    std::fs::write(
        artifact.join("outcome.json"),
        serde_json::to_vec_pretty(&json!({
            "exit_code":output.status.code(),"success":output.status.success(),
            "stdout":"stdout.jsonl","stderr":"stderr.log","provider_transcript":"provider.json"
        }))?,
    )?;
    eprintln!("journey evidence: {}", artifact.display());
    Ok(output)
}

struct TuiChild(Box<dyn portable_pty::Child + Send + Sync>);

impl Drop for TuiChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

async fn run_tui(command: Command, artifact: &Path, answer: &str) -> Result<()> {
    let command = command.as_std();
    let mut terminal_command = CommandBuilder::new(command.get_program());
    terminal_command.args(command.get_args());
    terminal_command.env_clear();
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            terminal_command.env(key, value);
        }
    }
    terminal_command.env("TERM", "xterm-256color");
    if let Some(directory) = command.get_current_dir() {
        terminal_command.cwd(directory);
    }
    std::fs::write(
        artifact.join("scenario.json"),
        serde_json::to_vec_pretty(&json!({
            "reproduce":"cargo test --locked -p nanocodex-bin --test harness_routing claude_root_needs_only_anthropic_credentials -- --nocapture",
            "command":format!("{terminal_command:?}"),
            "expected":format!("TUI displays {answer}, then exits successfully after Ctrl+D"),
            "boundary":"shipped nanocodex executable in a 140x32 PTY; only external providers use loopback fixtures",
            "input_after_answer":"Ctrl+D (0x04)",
            "terminal_transcript":"terminal.log"
        }))?,
    )?;
    let mut transcript = std::fs::File::create(artifact.join("terminal.log"))?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 32,
            cols: 140,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| eyre!(error.to_string()))?;
    let mut child = TuiChild(
        pair.slave
            .spawn_command(terminal_command)
            .map_err(|error| eyre!(error.to_string()))?,
    );
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| eyre!(error.to_string()))?;
    let mut keyboard = pair
        .master
        .take_writer()
        .map_err(|error| eyre!(error.to_string()))?;
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let capture = std::thread::spawn(move || -> std::io::Result<()> {
        let mut bytes = [0; 8192];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 {
                break;
            }
            transcript.write_all(&bytes[..count])?;
            let _ = send.send(bytes[..count].to_vec());
        }
        Ok(())
    });
    let mut answer_visible = false;
    let result = timeout(LIMIT, async {
        let mut bytes = Vec::new();
        while !String::from_utf8_lossy(&bytes).contains(answer) {
            let chunk = receive
                .recv()
                .await
                .ok_or_else(|| eyre!("TUI closed before displaying {answer}"))?;
            bytes.extend(chunk);
        }
        answer_visible = true;
        keyboard.write_all(b"\x04")?;
        keyboard.flush()?;
        loop {
            if let Some(status) = child.0.try_wait()? {
                return Ok::<_, eyre::Report>(status);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| eyre!("TUI timed out waiting for its answer or clean exit"))
    .and_then(|result| result);
    drop(child);
    drop(keyboard);
    drop(pair.master);
    let capture_result = tokio::task::spawn_blocking(move || capture.join()).await?;
    std::fs::write(
        artifact.join("outcome.json"),
        serde_json::to_vec_pretty(&json!({
            "exit_code":result.as_ref().ok().map(|status| status.exit_code()),
            "success":result.as_ref().is_ok_and(|status| status.success()),
            "answer_visible":answer_visible,
            "error":result.as_ref().err().map(ToString::to_string),
            "terminal_transcript":"terminal.log","provider_transcript":"provider.json"
        }))?,
    )?;
    eprintln!("journey evidence: {}", artifact.display());
    capture_result.map_err(|_| {
        eyre!(
            "terminal capture thread panicked; evidence {}",
            artifact.display()
        )
    })??;
    let status = result.map_err(|error| eyre!("{error}; evidence {}", artifact.display()))?;
    if !status.success() {
        return Err(eyre!(
            "TUI failed ({status}); evidence {}",
            artifact.display()
        ));
    }
    Ok(())
}

fn success(output: &Output, artifact: &Path, answer: &str) -> Result<()> {
    if !output.status.success() {
        return Err(eyre!(
            "CLI failed; evidence {}\n{}\n{}",
            artifact.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let events: Vec<Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?;
    assert!(
        events.iter().any(|e| e["type"] == "run.completed"),
        "missing terminal event: {events:?}"
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(answer),
        "missing final answer; evidence {}",
        artifact.display()
    );
    Ok(())
}

async fn journey(family: &'static str, kind: Journey) -> Result<()> {
    let artifact = artifact(&format!(
        "{family}-{}",
        if kind == Journey::Mixed {
            "mixed"
        } else if kind == Journey::Smoke {
            "only"
        } else {
            "missing-auth"
        }
    ))?;
    let provider = Arc::new(Mutex::new(Provider {
        root: family,
        journey: kind,
        counts: HashMap::new(),
        log: vec![],
        artifact: artifact.clone(),
        pauses: 0,
        cancellations: 0,
        connections: vec![],
    }));
    let servers = servers(Arc::clone(&provider)).await?;
    let mut command = command(
        &artifact.join("workspace"),
        &servers,
        family,
        kind == Journey::Mixed || family == "codex",
        kind == Journey::Mixed || family == "claude",
        kind == Journey::Smoke,
    );
    command.args(["--model", model(family)]);
    if kind == Journey::Smoke {
        command.arg("--prompt");
    }
    command.arg("HARNESS_ROUTING_ROOT");
    let answer = match kind {
        Journey::Smoke => "claude-only-answer",
        Journey::Mixed => "mixed-routing-answer",
        Journey::MissingChildAuth => "auth-denied-answer",
    };
    if kind == Journey::Smoke {
        run_tui(command, &artifact, answer).await?;
    } else {
        let output = run(command, &artifact, answer).await?;
        success(&output, &artifact, answer)?;
    }
    if kind == Journey::Mixed {
        timeout(Duration::from_secs(3), async {
            while provider.lock().unwrap().cancellations == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| {
            eyre!(
                "paused provider remained open after subtree interruption; evidence {}",
                artifact.display()
            )
        })?;
    }
    let provider = provider.lock().unwrap();
    if kind == Journey::Smoke {
        assert_eq!(provider.log.len(), 1);
        assert_eq!(provider.connections.len(), 1);
        assert_eq!(provider.log[0]["family"], "claude");
        assert_eq!(provider.log[0]["request"]["stream"], true);
    } else if kind == Journey::MissingChildAuth {
        assert_eq!(
            provider.log.len(),
            2,
            "unauthorized child contacted a model provider"
        );
        assert!(
            provider
                .connections
                .iter()
                .all(|connection| connection["family"] == family),
            "unauthorized child opened a provider connection"
        );
        assert!(
            provider.log[1]["tool_result"]
                .to_string()
                .contains("auth-denied-ok")
        );
    } else {
        for (label, expected_family) in [
            ("root", family),
            ("child", if family == "codex" { "claude" } else { "codex" }),
            ("grandchild", family),
            ("inherited", family),
            (
                "followup",
                if family == "codex" { "claude" } else { "codex" },
            ),
        ] {
            let calls: Vec<_> = provider
                .log
                .iter()
                .filter(|call| call["label"] == label)
                .collect();
            assert!(
                !calls.is_empty(),
                "{label} never dispatched; evidence {}",
                artifact.display()
            );
            for call in calls {
                assert_eq!(call["family"], expected_family);
                assert_eq!(call["model"], model(expected_family));
            }
        }
        for (label, stage, expected) in [
            ("root", 1, "nested-and-inherited-ok"),
            ("root", 2, "reuse-ok"),
            ("root", 3, "closed-subtree-ok"),
            ("root", 4, "paused-subtree-released-ok"),
            ("child", 1, "grandchild-ok"),
            ("child", 2, "contract-recovered-ok"),
        ] {
            let call = provider
                .log
                .iter()
                .find(|call| call["label"] == label && call["stage"] == stage)
                .ok_or_else(|| eyre!("missing {label} stage {stage}"))?;
            assert!(
                call["tool_result"].to_string().contains(expected),
                "{label}/{stage} failed: {}; evidence {}",
                call["tool_result"],
                artifact.display()
            );
        }
        assert_eq!(
            std::fs::read_to_string(artifact.join("workspace/grandchild.txt"))?,
            "grandchild-effect"
        );
        let inherited = provider
            .log
            .iter()
            .find(|call| call["label"] == "inherited")
            .unwrap();
        let effort = if family == "claude" {
            &inherited["request"]["output_config"]["effort"]
        } else {
            &inherited["request"]["reasoning"]["effort"]
        };
        assert_eq!(
            effort, "medium",
            "same-family null thinking did not inherit parent effort"
        );
        assert_eq!(
            provider.pauses, 1,
            "active grandchild never reached the paused provider"
        );
        assert_eq!(
            provider.cancellations, 1,
            "interruption retained the paused provider transport"
        );
    }
    Ok(())
}

#[tokio::test]
async fn claude_root_needs_only_anthropic_credentials() -> Result<()> {
    journey("claude", Journey::Smoke).await
}
#[tokio::test]
async fn codex_claude_codex_nested_lifecycle_and_inheritance() -> Result<()> {
    journey("codex", Journey::Mixed).await
}
#[tokio::test]
async fn claude_codex_claude_nested_lifecycle_and_inheritance() -> Result<()> {
    journey("claude", Journey::Mixed).await
}
#[tokio::test]
async fn cross_family_missing_credentials_has_no_child_dispatch_or_registry_effect() -> Result<()> {
    journey("codex", Journey::MissingChildAuth).await?;
    journey("claude", Journey::MissingChildAuth).await
}

#[tokio::test]
async fn root_selection_and_missing_auth_fail_before_provider_dispatch() -> Result<()> {
    for (name, family, auth, flags) in [
        ("invalid-family", "codex", true, vec!["--harness", "bogus"]),
        (
            "codex-wrong-model",
            "codex",
            true,
            vec!["--model", CLAUDE_MODEL],
        ),
        (
            "claude-wrong-model",
            "claude",
            true,
            vec!["--model", CODEX_MODEL],
        ),
        (
            "conflicting-family",
            "claude",
            true,
            vec!["--harness", "codex"],
        ),
        ("codex-no-auth", "codex", false, vec![]),
        ("claude-no-auth", "claude", false, vec![]),
    ] {
        let artifact = artifact(name)?;
        let provider = Arc::new(Mutex::new(Provider {
            root: family,
            journey: Journey::Smoke,
            counts: HashMap::new(),
            log: vec![],
            artifact: artifact.clone(),
            pauses: 0,
            cancellations: 0,
            connections: vec![],
        }));
        let servers = servers(Arc::clone(&provider)).await?;
        let mut command = command(
            &artifact.join("workspace"),
            &servers,
            family,
            auth,
            auth,
            false,
        );
        command.args(flags).arg("REJECT_ROOT_BEFORE_DISPATCH");
        let output = run(
            command,
            &artifact,
            "nonzero exit, actionable error, zero provider requests",
        )
        .await?;
        assert!(
            !output.status.success(),
            "invalid root succeeded; evidence {}",
            artifact.display()
        );
        assert!(
            provider.lock().unwrap().connections.is_empty(),
            "invalid root opened a provider connection"
        );
        assert!(!output.stderr.is_empty(), "invalid root omitted its error");
        assert!(
            provider.lock().unwrap().log.is_empty(),
            "invalid root dispatched a provider request; evidence {}",
            artifact.display()
        );
        assert!(!artifact.join("workspace/grandchild.txt").exists());
    }
    Ok(())
}

#[tokio::test]
async fn claude_durable_terminal_replays_in_a_second_process_without_a_provider_request()
-> Result<()> {
    let artifact = artifact("claude-durable-replay")?;
    let workspace = artifact.join("workspace");
    let database = workspace.join("claude.sqlite3");
    let provider = Arc::new(Mutex::new(Provider {
        root: "claude",
        journey: Journey::Smoke,
        counts: HashMap::new(),
        log: vec![],
        artifact: artifact.clone(),
        pauses: 0,
        cancellations: 0,
        connections: vec![],
    }));
    let servers = servers(Arc::clone(&provider)).await?;
    let invocation = || {
        let mut command = command(&workspace, &servers, "claude", false, true, false);
        command
            .args(["--model", CLAUDE_MODEL, "--local-durability"])
            .arg(&database)
            .args([
                "--local-durability-state-id",
                "synthetic-claude-root",
                "--request-id",
                "synthetic-claude-turn",
                "DURABLE_CLAUDE_ROOT",
            ]);
        command
    };
    let first = artifact.join("initial");
    std::fs::create_dir_all(&first)?;
    let initial = run(
        invocation(),
        &first,
        "durably completed Claude Messages answer",
    )
    .await?;
    success(&initial, &first, "claude-only-answer")?;
    assert_eq!(provider.lock().unwrap().log.len(), 1);
    let initial_connections = provider.lock().unwrap().connections.len();
    assert_eq!(initial_connections, 1);
    std::fs::write(
        first.join("provider.json"),
        serde_json::to_vec_pretty(&provider.lock().unwrap().log)?,
    )?;
    assert!(
        database.exists(),
        "CLI did not create its requested durability store"
    );
    let second = artifact.join("replay");
    std::fs::create_dir_all(&second)?;
    let replay = run(
        invocation(),
        &second,
        "single terminal replay event, zero new provider requests",
    )
    .await?;
    success(&replay, &second, "claude-only-answer")?;
    let events: Vec<Value> = String::from_utf8_lossy(&replay.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?;
    assert_eq!(events.len(), 1, "durable replay emitted generation events");
    assert_eq!(events[0]["type"], "run.completed");
    assert_eq!(events[0]["payload"]["model_calls"], 0);
    assert_eq!(
        provider.lock().unwrap().log.len(),
        1,
        "second process dispatched a Claude Messages request"
    );
    assert_eq!(
        provider.lock().unwrap().connections.len(),
        initial_connections,
        "second process connected to a provider during terminal replay"
    );
    std::fs::write(second.join("provider.json"), "[]\n")?;
    std::fs::write(second.join("connections.json"), "[]\n")?;
    Ok(())
}
