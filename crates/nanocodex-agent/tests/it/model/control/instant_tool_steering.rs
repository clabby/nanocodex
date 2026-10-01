use super::*;

// A public Agent/Turn journey through the real WebSocket Responses transport,
// QuickJS evaluator and shell runtime. Only the model provider is a fixture.
#[tokio::test]
async fn instant_steering_yields_exec_and_wait_without_replaying_effects() -> Result<()> {
    let workspace = temporary_workspace("instant-tool-steering")?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let (waiting, mut waiting_rx) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        assert_warmup(&next_json(&mut socket).await?);
        send_warmup(&mut socket, "resp-warmup").await?;
        next_json(&mut socket).await?;
        send_json(&mut socket, completed_response("resp-exec", &[json!({
            "type":"custom_tool_call", "call_id":"origin-exec", "name":"exec",
            "input":"// @exec: {\"yield_time_ms\": 120000}\ntext(\"prefix-before-steering\"); const result = await tools.exec_command({cmd: \"printf x >> effect-count; touch started; while [ ! -f release ]; do sleep 0.01; done; printf final-effect\", yield_time_ms: 300000}); text(result.output);"
        })])).await?;
        let yielded = timeout(std::time::Duration::from_secs(3), next_json(&mut socket)).await??;
        let output = yielded["input"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["call_id"] == "origin-exec"))
            .and_then(|item| item["output"].as_str())
            .ok_or_else(|| eyre!("missing exec output: {yielded}"))?;
        assert!(output.contains("prefix-before-steering"), "{output}");
        assert!(output.contains("Script running with cell ID"), "{output}");
        let cell = output
            .split("Script running with cell ID ")
            .nth(1)
            .ok_or_else(|| eyre!("missing live cell"))?
            .split_whitespace()
            .next()
            .unwrap()
            .trim_end_matches('.')
            .to_owned();
        assert!(yielded["input"].to_string().contains("first steering"));
        assert_eq!(yielded["previous_response_id"], "resp-exec");
        eprintln!(
            "instant_steering exec: origin=origin-exec cell={cell} status=running output={output}"
        );
        send_json(
            &mut socket,
            completed_response(
                "resp-wait",
                &[json!({
                    "type":"function_call", "call_id":"first-wait", "name":"wait",
                    "arguments":json!({"cell_id":cell,"yield_time_ms":120000}).to_string()
                })],
            ),
        )
        .await?;
        waiting.send(1)?;
        let yielded_wait =
            timeout(std::time::Duration::from_secs(3), next_json(&mut socket)).await??;
        let output = yielded_wait["input"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["call_id"] == "first-wait"))
            .ok_or_else(|| eyre!("missing first-wait output: {yielded_wait}"))?["output"]
            .to_string();
        assert!(
            output.contains(&format!("Script running with cell ID {cell}")),
            "{output}"
        );
        assert!(
            !output.contains("prefix-before-steering"),
            "output was repeated: {output}"
        );
        assert!(
            yielded_wait["input"]
                .to_string()
                .contains("second steering")
        );
        assert_eq!(yielded_wait["previous_response_id"], "resp-wait");
        eprintln!("instant_steering wait: same_cell={cell} output={output}");
        send_json(
            &mut socket,
            completed_response(
                "resp-final-wait",
                &[json!({
                    "type":"function_call", "call_id":"second-wait", "name":"wait",
                    "arguments":json!({"cell_id":cell,"yield_time_ms":120000}).to_string()
                })],
            ),
        )
        .await?;
        waiting.send(2)?;
        let completed =
            timeout(std::time::Duration::from_secs(5), next_json(&mut socket)).await??;
        let output = completed["input"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["call_id"] == "second-wait"))
            .ok_or_else(|| eyre!("missing second-wait output: {completed}"))?["output"]
            .to_string();
        assert!(
            output.contains("Script completed") && output.contains("final-effect"),
            "{output}"
        );
        assert_eq!(completed["previous_response_id"], "resp-final-wait");
        eprintln!("instant_steering resumed: same_cell={cell} output={output}");
        send_final(&mut socket, "resp-done").await
    });
    let openai = OpenAi::builder("test-key")
        .websocket_url(endpoint)
        .build()?;
    let (agent, mut events) = Nanocodex::builder(openai)
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .session_id(test_session_id())
        .instant_tool_steering(true)
        .build()?;
    let turn = agent
        .prompt("run exactly one effect and retain the cell")
        .await?;
    timeout(std::time::Duration::from_secs(5), async {
        while !workspace.join("started").exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| eyre!("shell did not start"))?;
    turn.steer("first steering").await?;
    let first = waiting_rx.recv().await;
    if first.is_none() {
        server.await??;
        return Err(eyre!("provider fixture ended before admitting wait"));
    }
    assert_eq!(first, Some(1));
    // Wait for the public tool admission event, not an assumed timer duration.
    timeout(std::time::Duration::from_secs(3), async {
        while let Some(event) = events.recv().await {
            if event.kind == AgentEventKind::ToolCall
                && event.decode_payload::<Value>()?["tool"] == "wait"
            {
                return Ok::<_, eyre::Report>(());
            }
        }
        Err(eyre!("wait not admitted"))
    })
    .await??;
    turn.steer("second steering").await?;
    let second = waiting_rx.recv().await;
    if second.is_none() {
        server.await??;
        return Err(eyre!("provider fixture ended before admitting final wait"));
    }
    assert_eq!(second, Some(2));
    assert_eq!(
        std::fs::read_to_string(workspace.join("effect-count"))?,
        "x"
    );
    std::fs::write(workspace.join("release"), [])?;
    assert_eq!(
        timeout(std::time::Duration::from_secs(5), turn.result())
            .await??
            .final_message(),
        "done"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join("effect-count"))?,
        "x"
    );
    eprintln!(
        "instant_steering effect_count={} final_message=done",
        std::fs::read_to_string(workspace.join("effect-count"))?
    );
    agent.shutdown().await?;
    timeout(std::time::Duration::from_secs(5), server).await???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}
