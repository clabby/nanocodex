use super::*;

#[tokio::test]
async fn websocket_ephemeral_fork_replays_history_on_its_fresh_socket() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut root = accept_async(stream).await?;
        let warmup = next_json(&mut root).await?;
        assert_eq!(warmup["store"], false);
        assert_eq!(warmup["generate"], false);
        send_warmup(&mut root, "resp-warmup").await?;

        let first = next_json(&mut root).await?;
        assert_eq!(first["store"], false);
        assert_eq!(first["previous_response_id"], "resp-warmup");
        send_final(&mut root, "resp-first").await?;

        let second = next_json(&mut root).await?;
        assert_eq!(second["previous_response_id"], "resp-first");
        assert_eq!(second["input"].as_array().map(Vec::len), Some(1));
        send_final(&mut root, "resp-second").await?;

        let (stream, _) = listener.accept().await?;
        let mut branch = accept_async(stream).await?;
        let request = next_json(&mut branch).await?;
        assert_eq!(request["store"], false);
        assert!(request.get("previous_response_id").is_none());
        let request_text = request.to_string();
        assert!(request_text.contains("first prompt"));
        assert!(request_text.contains("branch prompt"));
        assert!(!request_text.contains("second prompt"));
        send_final(&mut branch, "resp-branch").await
    });

    let workspace = temporary_workspace("websocket-ephemeral-fork")?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(endpoint)
        .store(false)
        .build()?;
    let (agent, root_events) = Nanocodex::builder(openai)
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .session_id(test_session_id())
        .build()?;
    let first = agent.prompt("first prompt").await?.result().await?;
    assert_eq!(
        agent
            .prompt("second prompt")
            .await?
            .result()
            .await?
            .final_message(),
        "done"
    );
    let (fork, fork_events) = agent.fork_from(&first).await?;
    assert_eq!(
        fork.prompt("branch prompt")
            .await?
            .result()
            .await?
            .final_message(),
        "done"
    );
    drop((agent, fork, root_events, fork_events));
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn websocket_full_replay_never_sends_a_previous_response_id() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        let warmup = next_json(&mut socket).await?;
        send_warmup(&mut socket, "resp-warmup").await?;

        let first = next_json(&mut socket).await?;
        assert!(first.get("previous_response_id").is_none());
        assert!(first.to_string().contains("first prompt"));
        send_final(&mut socket, "resp-first").await?;

        let second = next_json(&mut socket).await?;
        assert!(second.get("previous_response_id").is_none());
        let replay = second.to_string();
        assert!(replay.contains("first prompt"));
        assert!(replay.contains("second prompt"));
        send_final(&mut socket, "resp-second").await?;
        drop(warmup);
        Result::<()>::Ok(())
    });

    let workspace = temporary_workspace("websocket-full-replay")?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(endpoint)
        .store(false)
        .history(ResponsesHistory::FullReplay)
        .build()?;
    let (agent, events) = Nanocodex::builder(openai)
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .session_id(test_session_id())
        .build()?;
    agent.prompt("first prompt").await?.result().await?;
    agent.prompt("second prompt").await?.result().await?;
    drop((agent, events));
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn model_is_fixed_at_creation_while_runtime_reasoning_policy_can_change() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        let warmup = next_json(&mut socket).await?;
        assert_warmup(&warmup);
        assert_eq!(warmup["model"], "gpt-6-astra");
        assert_eq!(warmup["reasoning"]["effort"], "low");
        assert_eq!(warmup["input"][1]["content"][0]["text"], "custom prompt");
        send_warmup(&mut socket, "resp-warmup").await?;

        let first = next_json(&mut socket).await?;
        assert_eq!(first["model"], "gpt-6-astra");
        assert_eq!(first["previous_response_id"], "resp-warmup");
        assert_eq!(first["reasoning"]["effort"], "low");
        assert_eq!(first["service_tier"], "default");
        let prompt_cache_key = first["prompt_cache_key"].clone();
        send_final(&mut socket, "resp-first").await?;

        let follow_on = next_json(&mut socket).await?;
        assert_eq!(follow_on["model"], "gpt-6-astra");
        assert!(follow_on.get("previous_response_id").is_none());
        assert_eq!(follow_on["reasoning"]["effort"], "high");
        assert_eq!(follow_on["service_tier"], "priority");
        assert_eq!(follow_on["prompt_cache_key"], prompt_cache_key);
        let replay = follow_on.to_string();
        assert!(replay.contains("first prompt"));
        assert!(replay.contains("second prompt"));
        send_final(&mut socket, "resp-second").await?;

        let standard = next_json(&mut socket).await?;
        assert_eq!(standard["model"], "gpt-6-astra");
        assert!(standard.get("previous_response_id").is_none());
        assert_eq!(standard["reasoning"]["effort"], "high");
        assert_eq!(standard["service_tier"], "default");
        let replay = standard.to_string();
        assert!(replay.contains("first prompt"));
        assert!(replay.contains("second prompt"));
        assert!(replay.contains("third prompt"));
        send_final(&mut socket, "resp-third").await
    });

    let workspace = temporary_workspace("follow-on")?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(endpoint)
        .model(Model::Sol)
        .thinking(Thinking::Medium)
        .fast_mode(true)
        .reasoning_mode(ReasoningMode::Pro)
        .build()?;
    let (agent, mut events) = Nanocodex::builder(openai)
        .instructions("custom prompt")
        .model(Model::Astra)
        .thinking(Thinking::Low)
        .service_tier(ServiceTier::Ultrafast)
        .fast_mode(false)
        .reasoning_mode(ReasoningMode::Standard)
        .workspace(&workspace)
        .session_id(test_session_id())
        .build()?;

    let first = agent.prompt(Prompt::new("first prompt")).await?;
    assert_eq!(first.result().await?.final_message(), "done");
    agent.set_thinking(Thinking::High).await?;
    agent.set_service_tier(ServiceTier::Ultrafast).await?;
    agent.set_fast_mode(true).await?;
    let second = agent.prompt(Prompt::new("second prompt")).await?;
    assert_eq!(second.result().await?.final_message(), "done");
    agent.set_service_tier(ServiceTier::Ultrafast).await?;
    agent.set_fast_mode(false).await?;
    let third = agent.prompt(Prompt::new("third prompt")).await?;
    assert_eq!(third.result().await?.final_message(), "done");
    drop(agent);

    let mut completed = Vec::new();
    while let Some(event) = events.recv().await {
        if event.kind == AgentEventKind::RunCompleted {
            completed.push(event.decode_payload::<Value>()?);
        }
    }
    assert_eq!(completed.len(), 3);
    assert_eq!(completed[0]["connection_attempts"], 1);
    assert_eq!(completed[0]["response_attempts"], 2);
    assert_eq!(completed[0]["effort"], "low");
    assert_eq!(completed[0]["model"], "gpt-6-astra");
    assert_eq!(completed[1]["connection_attempts"], 0);
    assert_eq!(completed[1]["response_attempts"], 1);
    assert_eq!(completed[1]["effort"], "high");
    assert_eq!(completed[1]["model"], "gpt-6-astra");
    assert_eq!(completed[2]["connection_attempts"], 0);
    assert_eq!(completed[2]["response_attempts"], 1);
    assert_eq!(completed[2]["effort"], "high");
    assert_eq!(completed[2]["model"], "gpt-6-astra");

    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn queued_prompts_and_tool_continuations_retain_captured_tier_and_effort() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let (first_started, first_started_rx) = tokio::sync::oneshot::channel();
    let (release_first, release_first_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        let warmup = next_json(&mut socket).await?;
        assert_eq!(warmup["model"], "gpt-6-astra");
        assert_eq!(warmup["reasoning"]["effort"], "low");
        assert_eq!(warmup["service_tier"], "default");
        send_warmup(&mut socket, "resp-warmup").await?;

        let first = next_json(&mut socket).await?;
        assert_eq!(first["model"], "gpt-6-astra");
        assert_eq!(first["reasoning"]["effort"], "low");
        assert_eq!(first["service_tier"], "default");
        first_started
            .send(())
            .map_err(|()| eyre!("first request signal receiver dropped"))?;
        release_first_rx
            .await
            .map_err(|_| eyre!("first request release sender dropped"))?;
        send_json(
            &mut socket,
            completed_response(
                "resp-first-tool",
                &[json!({
                    "type": "custom_tool_call",
                    "call_id": "call-exec",
                    "name": "exec",
                    "input": "text(\"continued\")"
                })],
            ),
        )
        .await?;

        let continuation = next_json(&mut socket).await?;
        assert_eq!(continuation["model"], "gpt-6-astra");
        assert_eq!(continuation["previous_response_id"], "resp-first-tool");
        assert_eq!(continuation["reasoning"]["effort"], "low");
        assert_eq!(continuation["service_tier"], "default");
        send_final(&mut socket, "resp-first").await?;

        let queued = next_json(&mut socket).await?;
        assert_eq!(queued["model"], "gpt-6-astra");
        assert_eq!(queued["previous_response_id"], "resp-first");
        assert_eq!(queued["reasoning"]["effort"], "low");
        assert_eq!(queued["service_tier"], "default");
        send_json(
            &mut socket,
            completed_response(
                "resp-queued-tool",
                &[json!({
                    "type": "custom_tool_call", "call_id": "call-queued",
                    "name": "exec", "input": "text(\"queued continuation\")"
                })],
            ),
        )
        .await?;
        let queued_continuation = next_json(&mut socket).await?;
        assert_eq!(
            queued_continuation["previous_response_id"],
            "resp-queued-tool"
        );
        assert_eq!(queued_continuation["reasoning"]["effort"], "low");
        assert_eq!(queued_continuation["service_tier"], "default");
        assert!(
            queued_continuation
                .to_string()
                .contains("queued continuation")
        );
        send_final(&mut socket, "resp-queued").await?;

        let updated = next_json(&mut socket).await?;
        assert_eq!(updated["model"], "gpt-6-astra");
        assert!(updated.get("previous_response_id").is_none());
        assert_eq!(updated["reasoning"]["effort"], "high");
        assert_eq!(updated["service_tier"], "ultrafast");
        let replay = updated.to_string();
        assert!(replay.contains("first prompt"));
        assert!(replay.contains("queued prompt"));
        assert!(replay.contains("updated prompt"));
        send_final(&mut socket, "resp-updated").await?;

        let compact = next_json(&mut socket).await?;
        assert_eq!(compact["service_tier"], "ultrafast");
        assert_eq!(compact["previous_response_id"], "resp-updated");
        assert_eq!(compact["input"], json!([{"type": "compaction_trigger"}]));
        send_json(&mut socket, json!({
            "type": "response.output_item.done",
            "item": { "id": "cmp-ultra", "type": "compaction", "encrypted_content": "ultra-summary" }
        })).await?;
        send_json(
            &mut socket,
            completed_response_with_usage("resp-compact", &[], 120),
        )
        .await?;

        let after_compaction = next_json(&mut socket).await?;
        assert_eq!(after_compaction["service_tier"], "ultrafast");
        assert_eq!(after_compaction["reasoning"]["effort"], "high");
        assert!(after_compaction.get("previous_response_id").is_none());
        assert!(after_compaction.to_string().contains("ultra-summary"));
        send_final(&mut socket, "resp-after-compaction").await?;
        Ok::<_, eyre::Report>(vec![
            warmup,
            first,
            continuation,
            queued,
            queued_continuation,
            updated,
            compact,
            after_compaction,
        ])
    });

    let workspace = temporary_workspace("queued-turn-policy")?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(endpoint)
        .build()?;
    let (agent, events) = Nanocodex::builder(openai)
        .model(Model::Astra)
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .session_id(test_session_id())
        .build()?;

    let first = agent.prompt("first prompt").await?;
    first_started_rx
        .await
        .map_err(|_| eyre!("first request was not observed"))?;
    let queued = agent.prompt("queued prompt").await?;
    agent.set_thinking(Thinking::High).await?;
    agent.set_service_tier(ServiceTier::Ultrafast).await?;
    release_first
        .send(())
        .map_err(|()| eyre!("first request release receiver dropped"))?;
    let first = first.result().await?;
    assert_eq!(
        first
            .usage()
            .unwrap()
            .estimated_cost()
            .unwrap()
            .service_tier(),
        ServiceTier::Standard
    );
    let queued = queued.result().await?;
    assert_eq!(
        serde_json::to_value(
            queued
                .snapshot()
                .expect("local turns always retain a snapshot"),
        )?["model"],
        "gpt-6-astra"
    );
    assert_eq!(
        queued
            .usage()
            .unwrap()
            .estimated_cost()
            .unwrap()
            .service_tier(),
        ServiceTier::Standard
    );
    let updated = agent.prompt("updated prompt").await?.result().await?;
    assert_eq!(
        updated
            .usage()
            .unwrap()
            .estimated_cost()
            .unwrap()
            .service_tier(),
        ServiceTier::Ultrafast
    );
    assert_eq!(
        serde_json::to_value(
            updated
                .snapshot()
                .expect("local turns always retain a snapshot"),
        )?["model"],
        "gpt-6-astra"
    );

    agent.compact().await?;
    let after_compaction = agent.prompt("after compaction").await?.result().await?;
    assert_eq!(
        after_compaction
            .usage()
            .unwrap()
            .estimated_cost()
            .unwrap()
            .service_tier(),
        ServiceTier::Ultrafast
    );
    let ChildSnapshot::Codex(runtime) = agent.runtime_snapshot().await? else {
        return Err(eyre!("native agent returned a different checkpoint family"));
    };
    assert_eq!(runtime.service_tier, ServiceTier::Ultrafast);

    drop((agent, events));
    let requests = timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    if let Some(path) = std::env::var_os("NANOCODEX_E2E_TRANSCRIPT") {
        std::fs::write(path, serde_json::to_string_pretty(&requests)?)?;
    }
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}
