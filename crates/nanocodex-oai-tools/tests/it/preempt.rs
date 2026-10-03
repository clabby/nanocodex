use nanocodex_oai_tools::{ToolContext, runtime::ToolRuntime};
use serde_json::json;
use std::time::Duration;
use tokio::time::timeout;

fn context() -> ToolContext<'static> {
    ToolContext::new("gpt-6-astra", "preempt-session", "origin-exec", &[], 10000)
}

// Public embedding API journey through the real native evaluator. Unlike the
// provider-transport journey this can deliberately collide host controls with
// completion and busy evaluation, including teardown and stale signals.
#[tokio::test]
async fn host_preemption_retains_busy_cells_and_cancel_remains_terminal() {
    let _guard = crate::TOOL_RUNTIME_TEST_LOCK.lock().await;
    let workspace = tempfile::tempdir().unwrap();
    let tools = ToolRuntime::new(workspace.path(), None, None);
    let control = tools.control();
    control.begin_turn();
    let code = "// @exec: {\"yield_time_ms\": 120000}\ntext(\"before-busy\"); await tools.exec_command({cmd: \"touch started; while [ ! -f release ]; do sleep 0.01; done; printf x >> effect\", yield_time_ms: 300000}); const until = Date.now() + 400; while (Date.now() < until) {}; store(\"retained\", 42); text(\"after-busy\");";
    let execution = tools.execute_code(code, context());
    tokio::pin!(execution);
    // Poll the real cell startup before waiting for shell's admission sentinel.
    tokio::select! {
        output = &mut execution => panic!("completed before steering: {:?}", output.unwrap().cell),
        () = async {
            timeout(Duration::from_secs(5), async {
                while !workspace.path().join("started").exists() { tokio::task::yield_now().await; }
            }).await.unwrap();
        } => {}
    }
    control.preempt_turn().await;
    let yielded = timeout(Duration::from_secs(1), execution)
        .await
        .unwrap()
        .unwrap();
    assert!(yielded.cell.as_ref().unwrap().running);
    assert_eq!(yielded.cell.as_ref().unwrap().origin_call_id, "origin-exec");
    assert!(format!("{:?}", yielded.output).contains("before-busy"));
    // Busy JS occupies its host thread, not the foreground Rust observer.
    std::fs::write(workspace.path().join("release"), "").unwrap();
    let input = json!({"cell_id":"1", "yield_time_ms":120000}).to_string();
    let waiting = tools.wait_for_code(&input, context());
    tokio::pin!(waiting);
    tokio::select! {
        output = &mut waiting => panic!("completed before busy steering: {:?}", output.unwrap().cell),
        () = tokio::time::sleep(Duration::from_millis(40)) => {}
    }
    control.preempt_turn().await;
    let early = timeout(Duration::from_millis(250), waiting)
        .await
        .unwrap()
        .unwrap();
    assert!(early.cell.as_ref().unwrap().running);
    eprintln!(
        "host_preempt busy_observer cell={:?} output={:?}",
        early.cell, early.output
    );
    let finished = timeout(
        Duration::from_secs(2),
        tools.wait_for_code(&input, context()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!finished.cell.as_ref().unwrap().running);
    assert!(format!("{:?}", finished.output).contains("after-busy"));
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("effect")).unwrap(),
        "x"
    );
    assert!(
        early
            .nested_calls
            .iter()
            .chain(&finished.nested_calls)
            .any(|call| call.name == "exec_command" && call.success)
    );
    // A signal without an observer must not become sticky on a future cell.
    control.preempt_turn().await;
    let fresh = tools
        .execute_code("text(load(\"retained\"));", context())
        .await
        .unwrap();
    assert!(!fresh.cell.unwrap().running);
    assert!(format!("{:?}", fresh.output).contains("42"));
    // Termination, unlike preemption, closes the cell and stops continuation.
    let hanging = tools
        .execute_code(
            "// @exec: {\"yield_time_ms\": 10}\nawait new Promise(() => {}); store(\"never\", 1);",
            context(),
        )
        .await
        .unwrap();
    assert!(hanging.cell.unwrap().running);
    let terminate = json!({"cell_id":"3", "terminate":true}).to_string();
    control.preempt_turn().await;
    let terminal = timeout(
        Duration::from_secs(2),
        tools.wait_for_code(&terminate, context()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!terminal.cell.unwrap().running);
    eprintln!("host_terminate output={:?}", terminal.output);
    assert!(format!("{:?}", terminal.output).contains("Script terminated"));
    let missing = tools
        .wait_for_code(&json!({"cell_id":"3"}).to_string(), context())
        .await
        .unwrap();
    assert!(!missing.success);
    control.cancel().await;
    eprintln!(
        "host_preempt continuation=preserved effect_count=x stale_signal=ignored teardown=complete"
    );
}

#[tokio::test]
async fn completion_preemption_races_preserve_once_only_output_and_store() {
    let _guard = crate::TOOL_RUNTIME_TEST_LOCK.lock().await;
    let workspace = tempfile::tempdir().unwrap();
    let tools = ToolRuntime::new(workspace.path(), None, None);
    let control = tools.control();
    control.begin_turn();
    for id in 1..=20 {
        let execution = tools.execute_code("// @exec: {\"yield_time_ms\": 1000}\nstore(\"n\", (load(\"n\") ?? 0) + 1); text(\"exactly-once\");", context());
        tokio::pin!(execution);
        tokio::select! {
            output = &mut execution => {
                let output = output.unwrap();
                assert!(!output.cell.unwrap().running);
                assert!(format!("{:?}", output.output).contains("exactly-once"));
                continue;
            }
            () = tokio::time::sleep(Duration::from_millis(1)) => {}
        }
        control.preempt_turn().await;
        let output = execution.await.unwrap();
        let mut count = usize::from(format!("{:?}", output.output).contains("exactly-once"));
        if output.cell.unwrap().running {
            let input = json!({"cell_id":id.to_string(), "yield_time_ms":1000}).to_string();
            let later = tools.wait_for_code(&input, context()).await.unwrap();
            assert!(!later.cell.unwrap().running);
            count += usize::from(format!("{:?}", later.output).contains("exactly-once"));
        }
        assert_eq!(count, 1);
    }
    let output = tools
        .execute_code("text(load(\"n\"));", context())
        .await
        .unwrap();
    assert!(format!("{:?}", output.output).contains("20"));
    eprintln!(
        "completion_preempt races=20 commits=20 final_output={:?}",
        output.output
    );
    control.cancel().await;
}
