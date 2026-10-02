use std::{
    collections::HashSet,
    fs::File,
    io::Write,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use eyre::{Result, WrapErr, ensure};
use futures_util::{SinkExt, StreamExt};
use nanocodex_tools::{
    Tool, ToolContext, ToolDefinition, ToolInput, ToolResult, Tools, WorkspaceTools,
    attachment::{AttachmentMachine, AttachmentMetadata, AttachmentTarget},
    contract::async_trait,
};
use serde_json::{Value, json};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Notify,
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

// Only the external CUA provider is substituted. Workspace commands, process
// retention and attachment transport run their shipped code.
struct PendingCua {
    name: &'static str,
    parallel: bool,
    started: Arc<Notify>,
    active: Arc<AtomicBool>,
}

struct ActiveCall(Arc<AtomicBool>);

impl Drop for ActiveCall {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[async_trait]
impl Tool for PendingCua {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            self.name,
            "Synthetic external CUA provider waiting for its response",
            json!({"type":"object", "properties":{}, "additionalProperties":false}),
        )
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        self.parallel
    }

    async fn execute(&self, _input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        self.active.store(true, Ordering::SeqCst);
        let _active = ActiveCall(Arc::clone(&self.active));
        self.started.notify_one();
        std::future::pending().await
    }
}

#[derive(Clone)]
struct Evidence {
    file: Arc<Mutex<File>>,
    started: Instant,
}

impl Evidence {
    fn record(&self, connection: &str, direction: &str, value: &Value) {
        let mut file = self.file.lock().unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "elapsed_ms": self.started.elapsed().as_millis(),
                "connection": connection,
                "direction": direction,
                "frame": value,
            })
        )
        .unwrap();
        file.flush().unwrap();
    }
}

struct Wire {
    socket: WebSocketStream<TcpStream>,
    evidence: Evidence,
    connection: &'static str,
    pending: HashSet<String>,
    catalog: Value,
    diagnostics: bool,
    progress: Vec<Value>,
}

impl Wire {
    async fn ready(
        listener: &TcpListener,
        evidence: Evidence,
        connection: &'static str,
    ) -> Result<Self> {
        Self::ready_with_version(listener, evidence, connection, Some("v1")).await
    }

    async fn ready_with_version(
        listener: &TcpListener,
        evidence: Evidence,
        connection: &'static str,
        version: Option<&str>,
    ) -> Result<Self> {
        let (stream, _) = listener.accept().await?;
        let socket = accept_hdr_async(stream, |_request: &Request, mut response: Response| {
            if let Some(version) = version {
                response
                    .headers_mut()
                    .insert("x-nanocodex-tools-diagnostics", version.parse().unwrap());
            }
            Ok(response)
        })
        .await?;
        evidence.record(
            connection,
            "upgrade",
            &json!({"diagnostics_version":version}),
        );
        let mut wire = Self {
            socket,
            evidence,
            connection,
            pending: HashSet::new(),
            catalog: Value::Null,
            diagnostics: version == Some("v1"),
            progress: Vec::new(),
        };
        wire.catalog = wire.recv(Duration::from_secs(5)).await?;
        ensure!(wire.catalog["type"] == "catalog", "missing catalog");
        wire.send(json!({"type":"ready"})).await?;
        Ok(wire)
    }

    async fn send(&mut self, frame: Value) -> Result<()> {
        self.evidence
            .record(self.connection, "remote_to_executor", &frame);
        self.socket
            .send(Message::Text(frame.to_string().into()))
            .await?;
        Ok(())
    }

    async fn call(&mut self, id: &str, name: &str, input: Value) -> Result<()> {
        self.call_before(id, name, input, now_ms() + 30_000).await
    }

    async fn call_before(
        &mut self,
        id: &str,
        name: &str,
        input: Value,
        deadline: u64,
    ) -> Result<()> {
        self.pending.insert(id.to_owned());
        self.send(json!({
            "type":"call", "session_id":"synthetic-session", "turn_id":"synthetic-turn:1",
            "call_id":id, "model":"synthetic-model", "name":name, "input":input,
            "output_token_budget":1000, "output_byte_budget":131072,
            "deadline_at":deadline,
        }))
        .await
    }

    async fn recv(&mut self, limit: Duration) -> Result<Value> {
        tokio::time::timeout(limit, async {
            loop {
                let message = self
                    .socket
                    .next()
                    .await
                    .ok_or_else(|| eyre::eyre!("socket closed"))??;
                match message {
                    Message::Text(text) => {
                        let frame: Value = serde_json::from_str(&text)?;
                        self.evidence
                            .record(self.connection, "executor_to_remote", &frame);
                        if !self.diagnostics {
                            legacy_host_frame(&frame)?;
                        }
                        if frame["type"] == "ping" {
                            self.send(json!({"type":"pong", "nonce":frame["nonce"]}))
                                .await?;
                            continue;
                        }
                        if frame["type"] == "diagnostic" {
                            self.progress.push(frame);
                            continue;
                        }
                        return Ok(frame);
                    }
                    Message::Ping(payload) => self.socket.send(Message::Pong(payload)).await?,
                    other => eyre::bail!("unexpected socket frame {other:?}"),
                }
            }
        })
        .await
        .wrap_err("attachment response did not arrive within the progress bound")?
    }

    async fn result(&mut self, expected: &str, limit: Duration) -> Result<Value> {
        let frame = self.recv(limit).await?;
        ensure!(frame["type"] == "result", "expected result, got {frame}");
        let id = frame["call_id"]
            .as_str()
            .ok_or_else(|| eyre::eyre!("missing call id"))?;
        self.pending.remove(id);
        self.send(json!({"type":"ack", "call_id":id})).await?;
        ensure!(
            id == expected,
            "expected {expected} to progress first, got {frame}"
        );
        Ok(frame)
    }

    async fn cancel_pending(&mut self) -> Result<()> {
        for id in self.pending.clone() {
            self.send(json!({"type":"cancel", "call_id":id})).await?;
        }
        while !self.pending.is_empty() {
            let frame = self.recv(Duration::from_secs(5)).await?;
            ensure!(
                frame["type"] == "result",
                "expected cancellation result: {frame}"
            );
            let id = frame["call_id"]
                .as_str()
                .ok_or_else(|| eyre::eyre!("missing call id"))?;
            ensure!(
                self.pending.remove(id),
                "unexpected cancellation result: {frame}"
            );
            self.send(json!({"type":"ack", "call_id":id})).await?;
        }
        Ok(())
    }

    async fn drain(&mut self) -> Result<()> {
        ensure!(
            self.recv(Duration::from_secs(5)).await? == json!({"type":"drain"}),
            "missing drain"
        );
        self.send(json!({"type":"draining"})).await
    }
}

// Freeze the pre-observability broker's exact host-frame envelope from
// 755b23cc4 (hosted/protocol.ts). This real socket peer rejects extensions
// before acknowledging catalogs or receipts, as that strict broker does.
fn legacy_host_frame(frame: &Value) -> Result<()> {
    let allowed: &[&str] = match frame["type"].as_str() {
        Some("catalog") => &[
            "type",
            "tools",
            "machines",
            "attachment_id",
            "capabilities",
            "runtime_id",
        ],
        Some("result") => &["type", "call_id", "outcome"],
        Some("ping") => &["type", "nonce"],
        Some("drain") => &["type"],
        _ => eyre::bail!("old strict broker rejects host frame: {frame}"),
    };
    ensure!(
        frame
            .as_object()
            .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str()))),
        "old strict broker rejects unsupported fields: {frame}"
    );
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap()
}

fn shell(command: &str) -> Value {
    json!({"cmd":command, "shell":"/bin/sh", "login":false, "yield_time_ms":1000})
}

fn successful_process(frame: &Value) -> Result<&Value> {
    ensure!(
        frame["outcome"]["status"] == "completed",
        "call failed: {frame}"
    );
    ensure!(
        frame["outcome"]["output"]["success"] == true,
        "tool failed: {frame}"
    );
    Ok(&frame["outcome"]["output"]["structured_result"])
}

async fn journey(
    wire: &mut Wire,
    workspace: &std::path::Path,
    started: &Notify,
    active: &AtomicBool,
) -> Result<()> {
    let catalog = wire.catalog["tools"]
        .as_array()
        .ok_or_else(|| eyre::eyre!("missing tools catalog"))?;
    for (name, timeout) in [("exec_command", 40_000), ("write_stdin", 310_000)] {
        let entry = catalog
            .iter()
            .find(|entry| entry["definition"]["name"] == name)
            .ok_or_else(|| eyre::eyre!("missing {name} in catalog"))?;
        ensure!(
            entry["parallel_safe"] == true && entry["timeout_ms"] == timeout,
            "unexpected public shell execution contract: {entry}"
        );
    }
    wire.call("cua", "cua_pending", json!({})).await?;
    tokio::time::timeout(Duration::from_secs(2), started.notified()).await?;
    ensure!(active.load(Ordering::SeqCst), "CUA never started");
    wire.evidence
        .record("owner", "observation", &json!({"cua_active":true}));

    wire.call(
        "printf",
        "exec_command",
        shell("printf 'attachment-progress'"),
    )
    .await?;
    let frame = wire
        .result("printf", Duration::from_secs(2))
        .await
        .wrap_err("real printf stalled while the parallel CUA call was active")?;
    let process = successful_process(&frame)?;
    ensure!(
        process["exit_code"] == 0 && process["output"] == "attachment-progress",
        "unexpected printf: {frame}"
    );
    ensure!(
        active.load(Ordering::SeqCst),
        "CUA completed before shell progress"
    );

    wire.call(
        "session",
        "exec_command",
        shell("printf 'session-start\n'; sleep 5; printf 'session-finish\n'"),
    )
    .await?;
    let frame = wire.result("session", Duration::from_secs(2)).await?;
    let process = successful_process(&frame)?;
    ensure!(
        process["output"] == "session-start\n",
        "missing initial process output: {frame}"
    );
    let session = process["session_id"]
        .as_i64()
        .ok_or_else(|| eyre::eyre!("process was not retained: {frame}"))?;

    // The process belongs to this attachment runtime. A second public Tools
    // recipe at the same workspace must not address it by the numeric ID.
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let other_tools = Tools::builder()
        .without_defaults()
        .add(WorkspaceTools::new(workspace))
        .build()?;
    let target = AttachmentTarget::new(
        format!("ws://{}/tools", listener.local_addr()?),
        "synthetic-bearer",
    )?;
    let (other_wire, other_attachment) = tokio::join!(
        Wire::ready(&listener, wire.evidence.clone(), "other-runtime"),
        other_tools.attach(target).connect(),
    );
    let mut other_wire = other_wire?;
    let (other_attachment, _events) = other_attachment?;
    other_wire
        .call(
            "foreign-poll",
            "write_stdin",
            json!({"session_id":session, "chars":"", "yield_time_ms":5000}),
        )
        .await?;
    let ownership = other_wire
        .result("foreign-poll", Duration::from_secs(2))
        .await?;
    let (drain, detach) = tokio::join!(other_wire.drain(), other_attachment.detach());
    drain?;
    detach?;
    ensure!(
        ownership["outcome"]["status"] == "completed"
            && ownership["outcome"]["output"]["success"] == false,
        "foreign process was accessible: {ownership}"
    );
    ensure!(
        ownership.to_string().contains("Unknown process id"),
        "unexpected ownership error: {ownership}"
    );

    wire.call(
        "poll",
        "write_stdin",
        json!({"session_id":session, "chars":"", "yield_time_ms":5000}),
    )
    .await?;
    wire.call(
        "concurrent-printf",
        "exec_command",
        shell("printf 'during-poll'"),
    )
    .await?;
    let concurrent = wire
        .result("concurrent-printf", Duration::from_secs(2))
        .await?;
    let process = successful_process(&concurrent)?;
    ensure!(
        process["exit_code"] == 0 && process["output"] == "during-poll",
        "concurrent command failed: {concurrent}"
    );
    let polled = wire.result("poll", Duration::from_secs(6)).await?;
    let process = successful_process(&polled)?;
    ensure!(
        process["exit_code"] == 0
            && process["output"] == "session-finish\n"
            && process["session_id"].is_null(),
        "retained process did not finish: {polled}"
    );
    ensure!(
        active.load(Ordering::SeqCst),
        "CUA did not remain active through both shell calls"
    );

    wire.send(json!({"type":"cancel", "call_id":"cua"})).await?;
    let cancelled = wire.result("cua", Duration::from_secs(2)).await?;
    ensure!(
        cancelled["outcome"]["status"] == "ambiguous",
        "unexpected cancellation receipt: {cancelled}"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while active.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    wire.call("exclusive-cua", "cua_exclusive", json!({}))
        .await?;
    tokio::time::timeout(Duration::from_secs(2), started.notified()).await?;
    ensure!(active.load(Ordering::SeqCst), "exclusive CUA never started");
    wire.call(
        "concurrent-declared-serial",
        "exec_command",
        shell("printf 'during-declared-serial'"),
    )
    .await?;
    let concurrent = wire
        .result("concurrent-declared-serial", Duration::from_secs(2))
        .await?;
    let process = successful_process(&concurrent)?;
    ensure!(
        process["exit_code"] == 0 && process["output"] == "during-declared-serial",
        "provider metadata blocked the concurrent shell: {concurrent}"
    );
    ensure!(
        active.load(Ordering::SeqCst),
        "declared-serial CUA stopped before the concurrent shell finished"
    );
    wire.call_before(
        "expired-printf",
        "exec_command",
        shell("printf 'expired-should-not-run' > expired-must-not-exist"),
        now_ms() - 1,
    )
    .await?;
    let expired = wire
        .result("expired-printf", Duration::from_secs(2))
        .await?;
    ensure!(
        expired["outcome"]["status"] == "unavailable",
        "expired call was dispatched: {expired}"
    );
    ensure!(
        !workspace.join("expired-must-not-exist").exists(),
        "expired shell executed its side effect"
    );
    wire.send(json!({"type":"cancel", "call_id":"exclusive-cua"}))
        .await?;
    let cancelled = wire.result("exclusive-cua", Duration::from_secs(2)).await?;
    ensure!(
        cancelled["outcome"]["status"] == "ambiguous",
        "unexpected exclusive cancellation: {cancelled}"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while active.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    wire.call(
        "recovered-printf",
        "exec_command",
        shell("printf 'after-cancel'"),
    )
    .await?;
    let recovered = wire
        .result("recovered-printf", Duration::from_secs(2))
        .await?;
    let process = successful_process(&recovered)?;
    ensure!(
        process["exit_code"] == 0 && process["output"] == "after-cancel",
        "shell did not recover after CUA cancellation: {recovered}"
    );
    ensure!(
        !workspace.join("expired-must-not-exist").exists(),
        "expired shell ran after provider cancellation"
    );
    wire.evidence.record(
        "owner",
        "observation",
        &json!({"cua_active":false, "journey":"passed"}),
    );
    Ok(())
}

#[tokio::test]
async fn attachment_negotiates_diagnostics_before_native_shell_and_process_poll() {
    let _runtime_lock = crate::TOOL_RUNTIME_TEST_LOCK.lock().await;
    let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../output/attachment-compatibility")
        .join(now_ms().to_string());
    std::fs::create_dir_all(&output).unwrap();
    let evidence = Evidence {
        file: Arc::new(Mutex::new(File::create(output.join("wire.jsonl")).unwrap())),
        started: Instant::now(),
    };
    let command = "cargo test --locked -p nanocodex-tools --features attachment --test it attachment::attachment_negotiates_diagnostics_before_native_shell_and_process_poll -- --exact --nocapture";
    std::fs::write(
        output.join("README.md"),
        format!("Command: `{command}`\n\nInputs: real loopback WebSocket upgrade with absent, unknown v2, or recognized v1 capability; synthetic native /bin/sh commands and retained process polling.\n\nExpected: all modes execute printf and poll one native process to exit 0. Absent/unknown modes pass the frozen 755b23cc4 strict host-frame envelope with no diagnostics or timing. v1 retains four progress phases and six monotonic timing fields per call. Routing metadata and runtime identity remain present in every mode.\n\nObserved: see wire.jsonl, including upgrade, raw socket frames and outcome records.\n\nScope: shipped Rust attachment/native executor over its actual transport; the peer freezes the old broker's envelope validation, not hosted authentication, persistence or deployment/proxy behavior.\n"),
    )
    .unwrap();
    eprintln!("Attachment compatibility evidence: {}", output.display());

    for (label, version) in [
        ("absent", None),
        ("unknown", Some("v2")),
        ("modern", Some("v1")),
    ] {
        let workspace = tempfile::tempdir().unwrap();
        let tools = Tools::builder()
            .without_defaults()
            .add(WorkspaceTools::new(workspace.path()))
            .build()
            .unwrap();
        let machine = AttachmentMachine::new(
            "compatibility-machine",
            "Synthetic compatibility Hand",
            workspace.path().to_str().unwrap(),
            ["process"],
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = AttachmentTarget::new(
            format!("ws://{}/tools", listener.local_addr().unwrap()),
            "synthetic-bearer",
        )
        .unwrap();
        let (wire, attachment) = tokio::join!(
            Wire::ready_with_version(&listener, evidence.clone(), label, version),
            tools
                .attach(target)
                .metadata(AttachmentMetadata::machine(machine))
                .connect(),
        );
        let mut wire = wire.unwrap();
        let (attachment, _events) = attachment.unwrap();
        let outcome: Result<()> = async {
            ensure!(wire.catalog["capabilities"] == json!(["turn_metadata"]));
            ensure!(wire.catalog["runtime_id"].is_string());
            ensure!(wire.catalog["attachment_id"] == "compatibility-machine");
            ensure!(wire.catalog["machines"][0]["id"] == "compatibility-machine");
            ensure!(wire.catalog["machines"][0]["workspace"] == workspace.path().to_str().unwrap());
            if wire.diagnostics {
                ensure!(wire.catalog["diagnostics"] == true);
                let id = uuid::Uuid::parse_str(wire.catalog["connection_id"].as_str().unwrap())?;
                ensure!(id.get_version_num() == 4);
            }

            wire.call("printf", "exec_command", shell("printf COMPATIBLE"))
                .await?;
            let printf = wire.result("printf", Duration::from_secs(3)).await?;
            ensure!(successful_process(&printf)?["output"] == "COMPATIBLE");
            ensure!(successful_process(&printf)?["exit_code"] == 0);

            // A second real command releases the process through this same
            // transport, avoiding wall-clock races and fixture-only execution.
            wire.call(
                "session",
                "exec_command",
                shell(
                    "printf STARTED; while [ ! -f release ]; do sleep 0.02; done; printf FINISHED",
                ),
            )
            .await?;
            let session = wire.result("session", Duration::from_secs(3)).await?;
            let process = successful_process(&session)?;
            ensure!(process["output"] == "STARTED");
            let session_id = process["session_id"]
                .as_i64()
                .ok_or_else(|| eyre::eyre!("native process was not retained: {session}"))?;
            wire.call("release", "exec_command", shell("touch release"))
                .await?;
            let released = wire.result("release", Duration::from_secs(3)).await?;
            ensure!(successful_process(&released)?["exit_code"] == 0);
            wire.call(
                "poll",
                "write_stdin",
                json!({"session_id":session_id,"chars":"","yield_time_ms":1000}),
            )
            .await?;
            let poll = wire.result("poll", Duration::from_secs(3)).await?;
            let process = successful_process(&poll)?;
            ensure!(
                process["output"] == "FINISHED"
                    && process["exit_code"] == 0
                    && process["session_id"].is_null()
            );

            if wire.diagnostics {
                for (id, result) in [
                    ("printf", &printf),
                    ("session", &session),
                    ("release", &released),
                    ("poll", &poll),
                ] {
                    let phases: Vec<_> = wire
                        .progress
                        .iter()
                        .filter(|frame| frame["call_id"] == id)
                        .map(|frame| frame["stage"].as_str().unwrap())
                        .collect();
                    ensure!(
                        phases
                            == [
                                "received",
                                "execution_started",
                                "execution_finished",
                                "result_prepared"
                            ],
                        "missing modern progress for {id}: {phases:?}"
                    );
                    let timing = result["timing"]
                        .as_object()
                        .ok_or_else(|| eyre::eyre!("modern receipt lost timing: {result}"))?;
                    let keys = [
                        "scheduler_ms",
                        "execution_gate_ms",
                        "execution_ms",
                        "result_encode_ms",
                        "result_queue_ms",
                        "host_elapsed_ms",
                    ];
                    ensure!(timing.len() == keys.len());
                    for key in keys {
                        ensure!(
                            timing[key]
                                .as_f64()
                                .is_some_and(|value| value.is_finite() && value >= 0.0)
                        );
                    }
                    let phase_total: f64 = keys[..5]
                        .iter()
                        .map(|key| timing[*key].as_f64().unwrap())
                        .sum();
                    ensure!(phase_total <= timing["host_elapsed_ms"].as_f64().unwrap() + 0.01);
                }
            } else {
                ensure!(wire.progress.is_empty());
            }
            Ok(())
        }
        .await;
        evidence.record(label, "outcome", &json!({
            "passed":outcome.is_ok(), "error":outcome.as_ref().err().map(|error|format!("{error:#}")),
                "native_shell_and_process_poll_completed":outcome.is_ok(),
            "diagnostics":wire.diagnostics,
        }));
        // Release a retained native command on assertion failure as well.
        std::fs::write(workspace.path().join("release"), "").unwrap();
        let cleanup = wire.cancel_pending().await;
        let (drain, detach) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(wire.drain(), attachment.detach())
        })
        .await
        .expect("compatibility cleanup exceeded its bound");
        cleanup.unwrap();
        drain.unwrap();
        detach.unwrap();
        outcome.unwrap();
    }
}

#[tokio::test]
async fn pending_parallel_cua_does_not_stall_workspace_shell_or_session_poll() {
    let _runtime_lock = crate::TOOL_RUNTIME_TEST_LOCK.lock().await;
    let workspace = tempfile::tempdir().unwrap();
    let output =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../output/attachment-progress");
    std::fs::create_dir_all(&output).unwrap();
    let path = output.join(format!("wire-{}.jsonl", now_ms()));
    let evidence = Evidence {
        file: Arc::new(Mutex::new(File::create(&path).unwrap())),
        started: Instant::now(),
    };
    eprintln!("Attachment journey wire evidence: {}", path.display());
    let started = Arc::new(Notify::new());
    let active = Arc::new(AtomicBool::new(false));
    let tools = Tools::builder()
        .without_defaults()
        .add(WorkspaceTools::new(workspace.path()))
        .tool(PendingCua {
            name: "cua_pending",
            parallel: true,
            started: Arc::clone(&started),
            active: Arc::clone(&active),
        })
        .tool(PendingCua {
            name: "cua_exclusive",
            parallel: false,
            started: Arc::clone(&started),
            active: Arc::clone(&active),
        })
        .build()
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = AttachmentTarget::new(
        format!("ws://{}/tools", listener.local_addr().unwrap()),
        "synthetic-bearer",
    )
    .unwrap();
    let (wire, attachment) = tokio::join!(
        Wire::ready(&listener, evidence.clone(), "owner"),
        tools.attach(target).connect()
    );
    let mut wire = wire.unwrap();
    let (attachment, _events) = attachment.unwrap();
    let outcome = journey(&mut wire, workspace.path(), &started, &active).await;
    if let Err(error) = &outcome {
        evidence.record(
            "owner",
            "observation",
            &json!({"journey":"failed", "error":format!("{error:#}")}),
        );
    }
    // Even the failing baseline cancels queued/in-flight calls, acknowledges
    // every receipt, and drains the socket before reporting the failure.
    let cleanup = wire.cancel_pending().await;
    let (drain, detach) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(wire.drain(), attachment.detach())
    })
    .await
    .expect("attachment cleanup exceeded its progress bound");
    cleanup.unwrap();
    drain.unwrap();
    detach.unwrap();
    assert!(
        !active.load(Ordering::SeqCst),
        "CUA survived attachment shutdown"
    );
    outcome.unwrap();
}
