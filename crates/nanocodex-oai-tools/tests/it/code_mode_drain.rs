use std::sync::Arc;

use nanocodex_oai_tools::{
    code_mode::{CodeModeObserver, CodeModeUpdate},
    contract::{DEFAULT_TOOL_OUTPUT_TOKENS, Tool, ToolContext, ToolDefinition, ToolInput, ToolOutput, ToolResult, async_trait},
    runtime::{ToolRuntime, Tools},
};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

struct ReceiptTool {
    release: Arc<Notify>,
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
        self.release.notified().await;
        Ok(ToolOutput::text("completed").with_structured_result(json!({"exact":7})))
    }
}

#[derive(Default)]
struct Receipts(Vec<Value>);
impl CodeModeObserver for Receipts {
    fn update(&mut self, update: CodeModeUpdate<'_>) {
        if let CodeModeUpdate::NestedCallCompleted(call) = update {
            self.0.push(call.structured_result.clone());
        }
    }
}

#[tokio::test]
async fn cancellation_preserves_buffered_completion_receipts() {
    let _serial = super::TOOL_RUNTIME_TEST_LOCK.lock().await;
    let workspace = tempfile::tempdir().unwrap();
    let release = Arc::new(Notify::new());
    let (consumed, mut consumed_rx) = mpsc::unbounded_channel();
    let tools = Tools::builder().without_defaults().tool(ReceiptTool {
        release: release.clone(), consumed,
    }).build().unwrap();
    let runtime = ToolRuntime::new_with_tools(workspace.path(), None, None, &tools);
    let context = ToolContext::new("fixture-model", "fixture-session", "exec-fixture", &[], DEFAULT_TOOL_OUTPUT_TOKENS);
    let mut receipts = Receipts::default();
    let execution = runtime.execute_code_with_updates(
        "// @exec: {\"yield_time_ms\": 1}\nawait tools.receipt({}); await tools.receipt({after:true});",
        context, &mut receipts,
    ).await.unwrap();
    assert!(execution.cell.unwrap().running);
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), consumed_rx.recv()).await.unwrap().unwrap();
    runtime.control().cancel().await;
    assert_eq!(receipts.0.iter().filter(|value| **value == json!({"exact":7})).count(), 1,
        "completed nested receipt disappeared at cancellation");
}
