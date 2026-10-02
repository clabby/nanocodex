use std::sync::Arc;

use nanocodex_oai_tools::{
    code_mode::{CodeModeObserver, CodeModeUpdate},
    contract::{
        DEFAULT_TOOL_OUTPUT_TOKENS, Tool, ToolContext, ToolDefinition, ToolInput, ToolOutput,
        ToolResult, async_trait,
    },
    runtime::{ToolRuntime, Tools},
};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

struct ReceiptTool {
    release: Arc<Notify>,
    started: Arc<Notify>,
    consumed: mpsc::UnboundedSender<()>,
}

#[async_trait]
impl Tool for ReceiptTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function("receipt", "Gated receipt fixture", json!({"type":"object"}))
    }

    async fn execute(&self, input: ToolInput, _: ToolContext<'_>) -> ToolResult {
        if input.decode_json::<Value>()?["after"] == true {
            self.consumed.send(()).unwrap();
            std::future::pending::<()>().await;
        }
        self.started.notify_one();
        self.release.notified().await;
        Ok(ToolOutput::text("completed")
            .with_structured_result(json!({"exact":7}))
            .with_metadata(json!({"receipt":"fixture"})))
    }
}

#[derive(Default)]
struct Receipts {
    starts: Vec<String>,
    completed: Vec<(String, Value, bool, Option<Value>)>,
}
impl CodeModeObserver for Receipts {
    fn update(&mut self, update: CodeModeUpdate<'_>) {
        match update {
            CodeModeUpdate::NestedCallStarted { call_id, .. } => self.starts.push(call_id.into()),
            CodeModeUpdate::NestedCallCompleted(call) => self.completed.push((
                call.call_id.clone(),
                call.structured_result.clone(),
                call.success,
                call.metadata
                    .as_ref()
                    .map(|raw| serde_json::from_str(raw.get()).unwrap()),
            )),
        }
    }
}

#[derive(Clone, Copy)]
enum Observation {
    Yielded,
    Dropped,
    Active,
    Parked,
}

async fn cancellation_journey(observation: Observation, all: bool) {
    let workspace = tempfile::tempdir().unwrap();
    let release = Arc::new(Notify::new());
    let started = Arc::new(Notify::new());
    let (consumed, mut consumed_rx) = mpsc::unbounded_channel();
    let tools = Tools::builder()
        .without_defaults()
        .tool(ReceiptTool {
            release: release.clone(),
            started: started.clone(),
            consumed,
        })
        .build()
        .unwrap();
    let runtime = ToolRuntime::new_with_tools(workspace.path(), None, None, &tools);
    let context = ToolContext::new(
        "fixture-model",
        "fixture-session",
        "exec-fixture",
        &[],
        DEFAULT_TOOL_OUTPUT_TOKENS,
    );
    let mut initial = Receipts::default();
    let mut drained = Receipts::default();
    let code = format!(
        "// @exec: {{\"yield_time_ms\": {}}}\nawait tools.receipt({{}}); await tools.receipt({{after:true}});",
        if matches!(observation, Observation::Yielded) {
            1
        } else {
            10000
        }
    );
    let mut execution = Box::pin(runtime.execute_code_with_updates(&code, context, &mut initial));
    if matches!(observation, Observation::Yielded) {
        assert!(execution.as_mut().await.unwrap().cell.unwrap().running);
    } else {
        tokio::select! {
            result = execution.as_mut() => panic!("unexpected early execution: {result:?}"),
            () = started.notified() => {},
        }
    }
    if matches!(observation, Observation::Parked) {
        if all {
            runtime.control().cancel().await;
        } else {
            runtime.control().cancel_turn().await;
        }
        drop(execution);
        return;
    }
    let control = runtime.control();
    let cancellation = async {
        release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(5), consumed_rx.recv())
            .await
            .unwrap()
            .unwrap();
        if all {
            control.cancel_with_updates(&mut drained).await;
        } else {
            control.cancel_turn_with_updates(&mut drained).await;
        }
    };
    if matches!(observation, Observation::Active) {
        let (result, ()) = tokio::join!(execution, cancellation);
        assert!(!result.unwrap().cell.unwrap().running);
    } else {
        // A dropped initial callback releases its lease while registry-owned updates survive.
        drop(execution);
        cancellation.await;
    }
    initial.starts.extend(drained.starts);
    initial.completed.extend(drained.completed);
    assert_eq!(initial.starts.len(), 2);
    assert_eq!(initial.completed.len(), 2);
    initial.starts.sort();
    let mut completed_ids = initial
        .completed
        .iter()
        .map(|entry| entry.0.clone())
        .collect::<Vec<_>>();
    completed_ids.sort();
    assert_eq!(initial.starts, completed_ids);
    assert!(
        completed_ids
            .iter()
            .all(|id| id.starts_with("exec-fixture/code-"))
    );
    let exact = initial
        .completed
        .iter()
        .filter(|entry| entry.1 == json!({"exact":7}))
        .collect::<Vec<_>>();
    assert_eq!(
        exact.len(),
        1,
        "completed nested receipt disappeared or duplicated at cancellation"
    );
    assert!(exact[0].2);
    assert_eq!(exact[0].3, Some(json!({"receipt":"fixture"})));
    let mut repeated = Receipts::default();
    control.cancel_with_updates(&mut repeated).await;
    assert!(repeated.starts.is_empty() && repeated.completed.is_empty());
}

#[tokio::test]
async fn cancellation_preserves_buffered_completion_receipts() {
    let _serial = super::TOOL_RUNTIME_TEST_LOCK.lock().await;
    for observation in [
        Observation::Yielded,
        Observation::Dropped,
        Observation::Active,
    ] {
        for all in [false, true] {
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                cancellation_journey(observation, all),
            )
            .await
            .unwrap();
        }
    }
}

#[tokio::test]
async fn cancellation_does_not_require_polling_a_parked_observation() {
    let _serial = super::TOOL_RUNTIME_TEST_LOCK.lock().await;
    for all in [false, true] {
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            cancellation_journey(Observation::Parked, all),
        )
        .await
        .unwrap();
    }
}
