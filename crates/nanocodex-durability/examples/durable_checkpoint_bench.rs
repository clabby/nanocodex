//! Durable checkpoint cost per model boundary over a long tool loop.
//!
//! Drives one agent turn through a scripted Responses service on a SQLite
//! store: ~1000 tool-call boundaries with ~4 KiB tool outputs and one forced
//! mid-turn compaction. Every durable store replacement is timed and assigned
//! to the model boundary in which it happened. The final boundary blocks in a
//! tool; the stored continuation is then compared with the context the
//! scripted provider observed, first live and then after reopening the store
//! and resuming the turn in a new owner.
//!
//! ```text
//! cargo run --release -p nanocodex-durability --features sqlite \
//!   --example durable_checkpoint_bench -- [label] [boundaries]
//! ```
//!
//! Writes `output/durable-checkpoint-bench/<label>.json` at the repository root.

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Instant,
};

use eyre::{Result, ensure, eyre};
use nanocodex_agent::{Nanocodex, OpenAi, PromptRequest, ResponseError, Tools, session::SessionId};
use nanocodex_durability::{
    DurableAgentExt, DurableSession, OwnedState, OwnerId, OwnerToken, SqliteStore, StateStore,
    StoreError, StoreFuture, StoreRecord,
};
use nanocodex_oai_api::{
    responses::{ContentItem, MessageRole, ResponseItem, ResponseItemId, Usage, WarmupResponse},
    tower::{
        CodeCall, CodeCallKind, CompactionOutput, GenerationOutput, ResponsePipelineStats,
        ResponsesAttempt, ResponsesAttemptKind, ResponsesOutput, ResponsesServiceResponse,
    },
};
use serde::Serialize;
use serde_json::{Value, json};

const OUTPUT_BYTES: usize = 4096;
const OPERATION_ID: &str = "bench-turn";

#[derive(Clone, Serialize)]
struct ReplaceSample {
    boundary: u32,
    records: usize,
    bytes: usize,
    micros: u128,
}

#[derive(Default)]
struct Probe {
    /// Current model call; replacements are attributed to the boundary that
    /// follows this call.
    call: AtomicU32,
    replaces: Mutex<Vec<ReplaceSample>>,
    call_entered: Mutex<Vec<Instant>>,
    call_returned: Mutex<Vec<Instant>>,
    /// Provider-side mirror of the full model context.
    mirror: Mutex<Vec<Value>>,
    last_outputs: Mutex<Vec<Value>>,
    /// Full context observed by the final (blocking) model call.
    final_context: Mutex<Option<Vec<Value>>>,
    resumed_context: Mutex<Option<Vec<Value>>>,
    resumed: AtomicBool,
}

struct TimedStore {
    inner: SqliteStore,
    probe: Arc<Probe>,
}

impl StateStore for TimedStore {
    fn read_record<'a>(
        &'a mut self,
        state_id: &'a str,
        key: &'a str,
    ) -> StoreFuture<'a, Result<Option<String>, StoreError>> {
        self.inner.read_record(state_id, key)
    }

    fn read_records<'a>(
        &'a mut self,
        state_id: &'a str,
        keys: &'a [String],
    ) -> StoreFuture<'a, Result<Vec<Option<String>>, StoreError>> {
        self.inner.read_records(state_id, keys)
    }

    fn acquire<'a>(
        &'a mut self,
        state_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedState, StoreError>> {
        self.inner.acquire(state_id, owner_id)
    }

    fn replace<'a>(
        &'a mut self,
        state_id: &'a str,
        owner: &'a OwnerToken,
        expected_revision: u64,
        payload: &'a str,
        records: &'a [StoreRecord],
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let started = Instant::now();
            let result = self
                .inner
                .replace(state_id, owner, expected_revision, payload, records)
                .await;
            self.probe.replaces.lock().unwrap().push(ReplaceSample {
                boundary: self.probe.call.load(Ordering::SeqCst),
                records: records.len(),
                bytes: payload.len()
                    + records
                        .iter()
                        .map(|record| record.key.len() + record.value.len())
                        .sum::<usize>(),
                micros: started.elapsed().as_micros(),
            });
            result
        })
    }
}

#[derive(Clone)]
struct ScriptedService {
    probe: Arc<Probe>,
    boundaries: u32,
    compact_at: u32,
}

fn generation(
    id: String,
    items: Vec<ResponseItem>,
    calls: Vec<CodeCall>,
    tokens: u64,
) -> ResponsesOutput {
    let end_turn = calls.is_empty();
    let final_message = end_turn.then(|| "bench resumed".to_owned());
    ResponsesOutput::Generation(GenerationOutput {
        id,
        reported_model: None,
        status: "completed".to_owned(),
        end_turn: Some(end_turn),
        final_message,
        output_items: items,
        code_calls: calls,
        usage: Some(Usage {
            total_tokens: tokens,
            ..Usage::default()
        }),
        time_to_first_event_ns: 0,
        time_to_first_output_ns: None,
        pipeline_stats: ResponsePipelineStats::default(),
    })
}

fn tool_call(name: &str, call_id: String, arguments: String) -> (ResponseItem, CodeCall) {
    let item = serde_json::from_value(json!({
        "type": "function_call",
        "id": format!("fc_{call_id}"),
        "call_id": call_id,
        "name": name,
        "arguments": arguments,
    }))
    .expect("function call decodes");
    (
        item,
        CodeCall {
            call_id,
            name: name.to_owned(),
            namespace: None,
            input: arguments,
            kind: CodeCallKind::Function,
        },
    )
}

impl ScriptedService {
    fn observe_request(&self, request: &ResponsesAttempt) -> Vec<Value> {
        let input = request
            .input_items()
            .map(|item| serde_json::to_value(item).expect("item encodes"))
            .collect::<Vec<_>>();
        let mut mirror = self.probe.mirror.lock().unwrap();
        if request.previous_response_id().is_none() {
            *mirror = input;
        } else {
            mirror.extend(self.probe.last_outputs.lock().unwrap().drain(..));
            mirror.extend(input);
        }
        mirror.clone()
    }

    fn record_outputs(&self, items: &[ResponseItem]) {
        *self.probe.last_outputs.lock().unwrap() = items
            .iter()
            .map(|item| serde_json::to_value(item).expect("item encodes"))
            .collect();
    }

    fn respond(&self, request: &ResponsesAttempt) -> ResponsesOutput {
        match request.kind() {
            ResponsesAttemptKind::Warmup => {
                self.observe_request(request);
                self.record_outputs(&[]);
                ResponsesOutput::Warmup(WarmupResponse {
                    id: "bench-warmup".to_owned(),
                    usage: None,
                })
            }
            ResponsesAttemptKind::Compaction => ResponsesOutput::Compaction(CompactionOutput {
                id: "bench-compaction".to_owned(),
                status: "completed".to_owned(),
                item: ResponseItem::Compaction {
                    id: Some(ResponseItemId::from("bench-cmp".to_owned())),
                    encrypted_content: "bench-compaction-summary".into(),
                    created_by: None,
                    internal_chat_message_metadata_passthrough: None,
                },
                usage: Some(Usage {
                    total_tokens: 120,
                    ..Usage::default()
                }),
                time_to_first_event_ns: 0,
                time_to_first_output_ns: None,
                pipeline_stats: ResponsePipelineStats::default(),
            }),
            ResponsesAttemptKind::Generation => {
                let call = request.model_call_index().expect("generation call index");
                let context = self.observe_request(request);
                if self.probe.resumed.load(Ordering::SeqCst) {
                    *self.probe.resumed_context.lock().unwrap() = Some(context);
                    let item = ResponseItem::message(
                        MessageRole::Assistant,
                        [ContentItem::output_text("bench resumed")],
                    );
                    self.record_outputs(std::slice::from_ref(&item));
                    return generation(
                        format!("bench-resumed-{call}"),
                        vec![item],
                        Vec::new(),
                        120,
                    );
                }
                let (item, code_call) = if call >= self.boundaries {
                    *self.probe.final_context.lock().unwrap() = Some(context);
                    tool_call("bench_block", format!("call-{call}"), "{}".to_owned())
                } else {
                    tool_call(
                        "bench_emit",
                        format!("call-{call}"),
                        json!({ "n": call }).to_string(),
                    )
                };
                // One forced mid-turn compaction; otherwise usage stays tiny so
                // automatic compaction never interferes with the measurement.
                let tokens = if call == self.compact_at {
                    244_800
                } else {
                    120
                };
                self.record_outputs(std::slice::from_ref(&item));
                generation(format!("bench-{call}"), vec![item], vec![code_call], tokens)
            }
            kind => panic!("unexpected bench attempt: {kind:?}"),
        }
    }
}

impl tower::Service<ResponsesAttempt> for ScriptedService {
    type Response = ResponsesServiceResponse;
    type Error = ResponseError;
    type Future = std::future::Ready<Result<Self::Response, Self::Error>>;

    fn poll_ready(
        &mut self,
        _context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: ResponsesAttempt) -> Self::Future {
        let generation = matches!(request.kind(), ResponsesAttemptKind::Generation);
        if generation {
            self.probe.call_entered.lock().unwrap().push(Instant::now());
        }
        let output = self.respond(&request);
        if generation {
            self.probe.call.store(
                request.model_call_index().expect("generation call index"),
                Ordering::SeqCst,
            );
            self.probe
                .call_returned
                .lock()
                .unwrap()
                .push(Instant::now());
        }
        std::future::ready(Ok(ResponsesServiceResponse::new(output)))
    }
}

struct EmitTool;
struct BlockTool(Arc<tokio::sync::Notify>, Arc<Probe>);

fn object_schema() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": true })
}

#[nanocodex_tools::contract::async_trait]
impl nanocodex_agent::Tool for EmitTool {
    fn definition(&self) -> nanocodex_tools::ToolDefinition {
        nanocodex_tools::ToolDefinition::function(
            "bench_emit",
            "Return a deterministic 4 KiB tool output.",
            object_schema(),
        )
    }

    async fn execute(
        &self,
        input: nanocodex_tools::ToolInput,
        _context: nanocodex_tools::ToolContext<'_>,
    ) -> nanocodex_tools::ToolResult {
        let seed = match &input {
            nanocodex_tools::ToolInput::Function(raw) => raw.get().to_owned(),
            nanocodex_tools::ToolInput::Freeform(text) => text.clone(),
        };
        let mut output = String::with_capacity(OUTPUT_BYTES);
        while output.len() < OUTPUT_BYTES {
            output.push_str(&seed);
            output.push(' ');
        }
        output.truncate(OUTPUT_BYTES);
        Ok(nanocodex_tools::ToolOutput::text(output))
    }
}

#[nanocodex_tools::contract::async_trait]
impl nanocodex_agent::Tool for BlockTool {
    fn definition(&self) -> nanocodex_tools::ToolDefinition {
        nanocodex_tools::ToolDefinition::function(
            "bench_block",
            "Block until the owner is replaced.",
            object_schema(),
        )
    }

    async fn execute(
        &self,
        _input: nanocodex_tools::ToolInput,
        _context: nanocodex_tools::ToolContext<'_>,
    ) -> nanocodex_tools::ToolResult {
        if self.1.resumed.load(Ordering::SeqCst) {
            // The resumed owner re-executes the unsettled final step.
            return Ok(nanocodex_tools::ToolOutput::text("unblocked"));
        }
        self.0.notify_one();
        std::future::pending().await
    }
}

#[derive(Serialize)]
struct Boundary {
    boundary: u32,
    /// Agent-side wall time between a model response and the next request.
    gap_micros: u128,
    replaces: usize,
    records: usize,
    bytes: usize,
    store_micros: u128,
}

fn stored_context(continuation: &nanocodex_agent::execution::ExecutionContinuation) -> Vec<Value> {
    continuation
        .prefix
        .iter()
        .chain(continuation.history.iter())
        .map(|item| serde_json::to_value(item).expect("item encodes"))
        .collect()
}

fn first_difference(left: &[Value], right: &[Value]) -> String {
    let index = left
        .iter()
        .zip(right)
        .position(|(left, right)| left != right)
        .unwrap_or(left.len().min(right.len()));
    format!(
        "lengths {} vs {}, first difference at {index}: {:?} vs {:?}",
        left.len(),
        right.len(),
        left.get(index),
        right.get(index)
    )
}

async fn open_agent(
    path: &std::path::Path,
    workspace: &std::path::Path,
    session_id: &SessionId,
    probe: &Arc<Probe>,
    service: &ScriptedService,
    blocked: &Arc<tokio::sync::Notify>,
) -> Result<(
    DurableSession,
    nanocodex_agent::Nanocodex,
    nanocodex_agent::events::AgentEvents,
)> {
    let store = TimedStore {
        inner: SqliteStore::open(path)?,
        probe: Arc::clone(probe),
    };
    let state = DurableSession::open(store, "durable-checkpoint-bench").await?;
    let openai = OpenAi::builder("bench-key")
        .service({
            let service = service.clone();
            move || service.clone()
        })
        .build()?;
    let tools = Tools::builder()
        .without_defaults()
        .tool(EmitTool)
        .tool(BlockTool(Arc::clone(blocked), Arc::clone(probe)))
        .build()?;
    let (agent, events) = Nanocodex::builder(openai)
        .workspace(workspace)
        .session_id(*session_id)
        .tools(tools)
        .durability(state.clone())
        .await?
        .build()?;
    Ok((state, agent, events))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let label = args.next().unwrap_or_else(|| "run".to_owned());
    let boundaries: u32 = args.next().map_or(Ok(1000), |value| value.parse())?;
    let compact_at = boundaries / 2;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output_dir = root.join("output/durable-checkpoint-bench");
    std::fs::create_dir_all(&output_dir)?;
    let scratch = tempfile::tempdir()?;
    let database = scratch.path().join("bench.sqlite");
    let workspace = scratch.path().join("workspace");
    std::fs::create_dir_all(&workspace)?;
    let session_id = SessionId::default();
    let probe = Arc::new(Probe::default());
    let service = ScriptedService {
        probe: Arc::clone(&probe),
        boundaries,
        compact_at,
    };
    let blocked = Arc::new(tokio::sync::Notify::new());

    let started = Instant::now();
    let (state, agent, events) = open_agent(
        &database,
        &workspace,
        &session_id,
        &probe,
        &service,
        &blocked,
    )
    .await?;
    let turn = agent
        .prompt(PromptRequest::new("run the checkpoint benchmark").request_id(OPERATION_ID))
        .await?;
    let mut turn = Box::pin(turn.result());
    tokio::select! {
        () = blocked.notified() => {}
        result = &mut turn => return Err(eyre!("turn ended before the final boundary: {:?}", result.map(|turn| turn.final_message().to_owned()))),
    }
    let live_elapsed = started.elapsed();

    let final_context = probe
        .final_context
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| eyre!("final boundary context was not observed"))?;
    let live = state
        .agent_continuation(OPERATION_ID)
        .await?
        .ok_or_else(|| eyre!("live continuation missing"))?;
    let live_context = stored_context(&live);
    ensure!(
        live_context == final_context,
        "live stored continuation differs from the provider context: {}",
        first_difference(&live_context, &final_context)
    );
    ensure!(
        final_context
            .iter()
            .any(|item| item["type"] == "compaction"),
        "forced compaction did not reach the final context"
    );

    // Simulate a crashed host: leave the live owner blocked mid-tool (no
    // graceful cancellation reaches the store), reopen the file on a fresh
    // connection, and resume the exact operation in a new, fencing owner.
    let abandoned = (turn, agent, events, state);
    probe.resumed.store(true, Ordering::SeqCst);
    let (state, agent, events) = open_agent(
        &database,
        &workspace,
        &session_id,
        &probe,
        &service,
        &blocked,
    )
    .await?;
    let restored = state
        .agent_continuation(OPERATION_ID)
        .await?
        .ok_or_else(|| eyre!("restored continuation missing"))?;
    let restored_context = stored_context(&restored);
    ensure!(
        restored_context == final_context,
        "restored continuation differs from the live provider context: {}",
        first_difference(&restored_context, &final_context)
    );
    let resumed = agent
        .prompt(PromptRequest::new("run the checkpoint benchmark").request_id(OPERATION_ID))
        .await?
        .result()
        .await?;
    ensure!(resumed.final_message() == "bench resumed");
    let resumed_context = probe
        .resumed_context
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| eyre!("resumed request was not observed"))?;
    // The resumed request replays the stored context plus the re-executed
    // final tool call and its output.
    ensure!(
        resumed_context.len() == final_context.len() + 2
            && resumed_context[..final_context.len()] == final_context[..],
        "resumed provider request does not extend the live context: {}",
        first_difference(&resumed_context, &final_context)
    );
    agent.shutdown().await?;
    drop((agent, events, state));
    drop(abandoned);

    let entered = probe.call_entered.lock().unwrap().clone();
    let returned = probe.call_returned.lock().unwrap().clone();
    let replaces = probe.replaces.lock().unwrap().clone();
    let mut rows = Vec::new();
    for boundary in 1..boundaries {
        let index = boundary as usize;
        let gap = entered[index].duration_since(returned[index - 1]);
        let samples = replaces
            .iter()
            .filter(|sample| sample.boundary == boundary)
            .collect::<Vec<_>>();
        rows.push(Boundary {
            boundary,
            gap_micros: gap.as_micros(),
            replaces: samples.len(),
            records: samples.iter().map(|sample| sample.records).sum(),
            bytes: samples.iter().map(|sample| sample.bytes).sum(),
            store_micros: samples.iter().map(|sample| sample.micros).sum(),
        });
    }
    let window = |range: std::ops::Range<usize>| {
        let slice = &rows[range];
        let count = slice.len().max(1) as u128;
        json!({
            "boundaries": slice.len(),
            "mean_gap_micros": slice.iter().map(|row| row.gap_micros).sum::<u128>() / count,
            "mean_store_micros": slice.iter().map(|row| row.store_micros).sum::<u128>() / count,
            // Agent/durability CPU between model calls, excluding store I/O.
            "mean_non_store_micros": slice
                .iter()
                .map(|row| row.gap_micros.saturating_sub(row.store_micros))
                .sum::<u128>()
                / count,
            "mean_bytes": slice.iter().map(|row| row.bytes as u128).sum::<u128>() / count,
            "mean_records": slice.iter().map(|row| row.records as u128).sum::<u128>() / count,
        })
    };
    let tenth = rows.len() / 10;
    let compact_index = compact_at as usize;
    let summary = json!({
        "label": label,
        "command": format!(
            "cargo run --release -p nanocodex-durability --features sqlite --example durable_checkpoint_bench -- {label} {boundaries}"
        ),
        "commit": std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&root)
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned()),
        "inputs": {
            "boundaries": boundaries,
            "tool_output_bytes": OUTPUT_BYTES,
            "forced_compaction_at_call": compact_at,
        },
        "expected": "per-boundary gap and bytes stay flat as history grows; stored, reopened, and resumed contexts equal the provider-observed context",
        "live_turn_seconds": live_elapsed.as_secs_f64(),
        "total_gap_seconds": rows.iter().map(|row| row.gap_micros).sum::<u128>() as f64 / 1e6,
        "total_store_seconds": rows.iter().map(|row| row.store_micros).sum::<u128>() as f64 / 1e6,
        "total_bytes_written": rows.iter().map(|row| row.bytes).sum::<usize>(),
        "first_tenth": window(0..tenth),
        "before_compaction_tenth": window(compact_index.saturating_sub(tenth + 1)..compact_index - 1),
        "last_tenth": window(rows.len() - tenth..rows.len()),
        "context_items_at_final_boundary": final_context.len(),
        "resume_verified": true,
        "boundaries_detail": rows,
    });
    let path = output_dir.join(format!("{label}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&summary)?)?;
    let mut brief = summary;
    brief.as_object_mut().unwrap().remove("boundaries_detail");
    println!("{}", serde_json::to_string_pretty(&brief)?);
    println!("wrote {}", path.display());
    Ok(())
}
