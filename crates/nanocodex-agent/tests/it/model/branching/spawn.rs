use super::*;

#[tokio::test]
async fn per_agent_tool_factory_binds_recursive_forks_to_the_invoking_driver() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut root = accept_async(stream).await?;
        let warmup = next_json(&mut root).await?;
        assert_eq!(warmup["store"], true);
        let lineage = warmup["prompt_cache_key"].clone();
        let root_session = warmup["client_metadata"]["session_id"].clone();
        let root_thread = warmup["client_metadata"]["thread_id"].clone();
        send_warmup(&mut root, "resp-warmup").await?;
        let root_turn = next_json(&mut root).await?;
        assert_eq!(root_turn["previous_response_id"], "resp-warmup");
        send_final(&mut root, "resp-root").await?;

        let (stream, _) = listener.accept().await?;
        let mut child = accept_async(stream).await?;
        let child_turn = next_json(&mut child).await?;
        let child_session = child_turn["client_metadata"]["session_id"].clone();
        let child_thread = child_turn["client_metadata"]["thread_id"].clone();
        assert_eq!(child_turn["previous_response_id"], "resp-root");
        assert_eq!(child_turn["prompt_cache_key"], lineage);
        assert_eq!(child_session, root_session);
        assert_ne!(child_thread, root_thread);
        send_final(&mut child, "resp-child").await?;

        let (stream, _) = listener.accept().await?;
        let mut grandchild = accept_async(stream).await?;
        let grandchild_turn = next_json(&mut grandchild).await?;
        assert_eq!(grandchild_turn["previous_response_id"], "resp-child");
        assert_eq!(grandchild_turn["prompt_cache_key"], lineage);
        assert_eq!(
            grandchild_turn["client_metadata"]["session_id"],
            child_session
        );
        assert_ne!(
            grandchild_turn["client_metadata"]["thread_id"],
            child_thread
        );
        send_final(&mut grandchild, "resp-grandchild").await
    });

    let (handles, mut received_handles) = tokio::sync::mpsc::unbounded_channel::<AgentHandle>();
    let workspace = temporary_workspace("recursive-fork-tools")?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(endpoint)
        .store(true)
        .build()?;
    let (root, root_events) = Nanocodex::builder(openai)
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .session_id(test_session_id())
        .tools_factory(move |handle| {
            drop(handles.send(handle));
            Tools::builder().without_defaults().build()
        })
        .build()?;
    let root_handle = received_handles
        .recv()
        .await
        .ok_or_else(|| eyre!("root tool factory did not receive a fork handle"))?;

    root.prompt(Prompt::new("root turn"))
        .await?
        .result()
        .await?;
    let (child, child_events) = root_handle.fork().await?;
    let child_handle = received_handles
        .recv()
        .await
        .ok_or_else(|| eyre!("child tool factory did not receive a fork handle"))?;
    child.prompt("child turn").await?.result().await?;
    let (grandchild, grandchild_events) = child_handle.fork().await?;
    received_handles
        .recv()
        .await
        .ok_or_else(|| eyre!("grandchild tool factory did not receive a fork handle"))?;
    grandchild.prompt("grandchild turn").await?.result().await?;

    drop((
        root,
        child,
        grandchild,
        root_events,
        child_events,
        grandchild_events,
    ));
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn clean_spawn_and_runtime_restore_preserve_cache_identity_and_tier() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut root = accept_async(stream).await?;
        let root_warmup = next_json(&mut root).await?;
        assert_eq!(root_warmup["prompt_cache_key"], TEST_SESSION_ID);
        assert!(
            root_warmup
                .to_string()
                .contains("shared private configuration"),
            "root request omitted the configured system prompt"
        );
        send_warmup(&mut root, "resp-root-warmup").await?;
        let root_turn = next_json(&mut root).await?;
        assert_eq!(root_turn["previous_response_id"], "resp-root-warmup");
        send_final(&mut root, "resp-root").await?;

        let (stream, _) = listener.accept().await?;
        let mut child = accept_async(stream).await?;
        let child_warmup = next_json(&mut child).await?;
        assert_eq!(child_warmup["reasoning"]["effort"], "high");
        assert_eq!(child_warmup["service_tier"], "ultrafast");
        let child_session = child_warmup["client_metadata"]["session_id"]
            .as_str()
            .ok_or_else(|| eyre!("clean child warmup omitted its session id"))?;
        assert_eq!(child_session, TEST_SESSION_ID);
        assert_ne!(
            child_warmup["client_metadata"]["thread_id"],
            TEST_SESSION_ID
        );
        assert_eq!(child_warmup["prompt_cache_key"], TEST_SESSION_ID);
        assert!(child_warmup.get("previous_response_id").is_none());
        assert!(
            child_warmup
                .to_string()
                .contains("shared private configuration"),
            "clean child did not reuse the configured system prompt"
        );
        send_warmup(&mut child, "resp-child-warmup").await?;
        let child_turn = next_json(&mut child).await?;
        assert_eq!(child_turn["service_tier"], "ultrafast");
        assert_eq!(child_turn["previous_response_id"], "resp-child-warmup");
        assert_ne!(child_turn["previous_response_id"], "resp-root");
        send_final(&mut child, "resp-child").await?;

        for (response_id, tier) in [("resp-restored", "ultrafast"), ("resp-legacy", "priority")] {
            let (stream, _) = listener.accept().await?;
            let mut restored = accept_async(stream).await?;
            let request = next_json(&mut restored).await?;
            assert_eq!(request["model"], Model::Astra.as_str());
            assert_eq!(request["service_tier"], tier);
            assert_eq!(
                request["client_metadata"]["thread_id"],
                child_turn["client_metadata"]["thread_id"]
            );
            assert!(request.get("previous_response_id").is_none());
            assert!(request.to_string().contains("clean child turn"));
            send_final(&mut restored, response_id).await?;
        }
        Result::<()>::Ok(())
    });

    let (handles, mut received_handles) = tokio::sync::mpsc::unbounded_channel::<AgentHandle>();
    let workspace = temporary_workspace("clean-spawn-tools")?;
    let openai = OpenAi::builder("private-test-key")
        .websocket_url(endpoint.clone())
        .build()?;
    let (root, root_events) = Nanocodex::builder(openai)
        .model(Model::Astra)
        .instructions("shared private configuration")
        .thinking(Thinking::Low)
        .session_id(test_session_id())
        .workspace(&workspace)
        .tools_factory(move |handle| {
            drop(handles.send(handle));
            Tools::builder().without_defaults().build()
        })
        .build()?;
    let root_handle = received_handles
        .recv()
        .await
        .ok_or_else(|| eyre!("root tool factory did not receive an agent handle"))?;
    root.prompt("root turn").await?.result().await?;
    root.set_thinking(Thinking::High).await?;
    root.set_service_tier(ServiceTier::Ultrafast).await?;

    let (child, child_events) = root_handle.spawn().await?;
    received_handles
        .recv()
        .await
        .ok_or_else(|| eyre!("clean child tool factory did not receive an agent handle"))?;
    child.prompt("clean child turn").await?.result().await?;
    let ChildSnapshot::Codex(child_runtime) = child.runtime_snapshot().await? else {
        return Err(eyre!("native agent returned a different checkpoint family"));
    };
    assert_eq!(child_runtime.service_tier, ServiceTier::Ultrafast);

    let encoded = serde_json::to_value(&child_runtime)?;
    assert_eq!(encoded["service_tier"], "ultrafast");
    assert!(encoded.get("fast_mode").is_none());
    for (enabled, expected) in [(false, ServiceTier::Standard), (true, ServiceTier::Fast)] {
        let mut legacy = encoded.clone();
        legacy.as_object_mut().unwrap().remove("service_tier");
        legacy["fast_mode"] = json!(enabled);
        let decoded: ChildRuntimeSnapshot = serde_json::from_value(legacy)?;
        assert_eq!(decoded.service_tier, expected);
        assert!(serde_json::to_value(decoded)?.get("fast_mode").is_none());
    }
    let mut duplicate = encoded.clone();
    duplicate["service_tier"] = json!("standard");
    duplicate["fast_mode"] = json!(false);
    assert!(serde_json::from_value::<ChildRuntimeSnapshot>(duplicate).is_err());
    for invalid in [
        json!("future_tier"),
        json!(true),
        json!({"ultrafast": null}),
        Value::Null,
    ] {
        let mut malformed = encoded.clone();
        malformed["service_tier"] = invalid;
        assert!(serde_json::from_value::<ChildRuntimeSnapshot>(malformed).is_err());
    }
    for invalid in [json!("true"), json!(1), Value::Null] {
        let mut malformed = encoded.clone();
        malformed.as_object_mut().unwrap().remove("service_tier");
        malformed["fast_mode"] = invalid;
        assert!(serde_json::from_value::<ChildRuntimeSnapshot>(malformed).is_err());
    }
    let mut without_tier = encoded.clone();
    without_tier.as_object_mut().unwrap().remove("service_tier");
    assert!(serde_json::from_value::<ChildRuntimeSnapshot>(without_tier.clone()).is_err());
    let serialized = serde_json::to_string(&without_tier)?;
    let prefix = serialized.strip_suffix('}').unwrap();
    for field in [r#""service_tier":"ultrafast""#, r#""fast_mode":true"#] {
        let valid = format!("{prefix},{field}}}");
        serde_json::from_str::<ChildRuntimeSnapshot>(&valid)?;
        let duplicate = format!("{prefix},{field},{field}}}");
        let error = serde_json::from_str::<ChildRuntimeSnapshot>(&duplicate).unwrap_err();
        assert!(error.to_string().contains("duplicate"));
    }
    child.shutdown().await?;
    drop((child, child_events));
    root.set_service_tier(ServiceTier::Standard).await?;
    let (restored, restored_events) = root_handle
        .restore_child(serde_json::from_value(encoded.clone())?, None)
        .await?;
    let restored_result = restored
        .prompt("restored child turn")
        .await?
        .result()
        .await?;
    assert_eq!(
        restored_result
            .usage()
            .unwrap()
            .estimated_cost()
            .unwrap()
            .service_tier(),
        ServiceTier::Ultrafast
    );
    restored.shutdown().await?;
    drop((restored, restored_events));

    let mut legacy = encoded;
    legacy.as_object_mut().unwrap().remove("service_tier");
    legacy["fast_mode"] = json!(true);
    let openai = OpenAi::builder("private-test-key")
        .websocket_url(endpoint)
        .service_tier(ServiceTier::Ultrafast)
        .build()?;
    let (legacy, legacy_events) = Nanocodex::builder(openai)
        .restore_runtime(ChildSnapshot::Codex(serde_json::from_value(legacy)?))?
        .build()?;
    let legacy_result = legacy.prompt("legacy child turn").await?.result().await?;
    assert_eq!(
        legacy_result
            .usage()
            .unwrap()
            .estimated_cost()
            .unwrap()
            .service_tier(),
        ServiceTier::Fast
    );
    legacy.shutdown().await?;
    drop((root, legacy, root_events, legacy_events));
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn clean_batch_spawn_preserves_requested_order() -> Result<()> {
    let (handles, mut received_handles) = tokio::sync::mpsc::unbounded_channel::<AgentHandle>();
    let openai = OpenAi::builder("test-key")
        .websocket_url("ws://127.0.0.1:1")
        .build()?;
    let (root, root_events) = Nanocodex::builder(openai)
        .tools_factory(move |handle| {
            drop(handles.send(handle));
            Tools::builder().without_defaults().build()
        })
        .build()?;
    let root_handle = received_handles
        .recv()
        .await
        .ok_or_else(|| eyre!("root tool factory did not receive an agent handle"))?;

    let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed_sessions = Arc::clone(&observed);
    let children = root_handle
        .spawn_many_observed(3, move |session_id| {
            observed_sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(session_id.to_owned());
        })
        .await?;
    let child_session_ids = children
        .iter()
        .map(|(child, _)| child.session_id().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(child_session_ids.len(), 3);
    assert_ne!(child_session_ids[0], child_session_ids[1]);
    assert_ne!(child_session_ids[1], child_session_ids[2]);
    assert_eq!(
        *observed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        child_session_ids
    );
    for _ in 0..3 {
        received_handles
            .recv()
            .await
            .ok_or_else(|| eyre!("child tool factory did not receive an agent handle"))?;
    }

    drop((root, root_events, children));
    Ok(())
}

#[tokio::test]
async fn clean_spawn_can_override_model_and_thinking_without_mutating_parent() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut child = accept_async(stream).await?;
        let child_warmup = next_json(&mut child).await?;
        assert_eq!(child_warmup["model"], Model::Luna.as_str());
        assert_eq!(child_warmup["reasoning"]["effort"], "medium");
        assert_eq!(child_warmup["service_tier"], "priority");
        send_warmup(&mut child, "resp-child-warmup").await?;
        let child_turn = next_json(&mut child).await?;
        assert_eq!(child_turn["service_tier"], "priority");
        send_final(&mut child, "resp-child").await?;

        let (stream, _) = listener.accept().await?;
        let mut root = accept_async(stream).await?;
        let root_warmup = next_json(&mut root).await?;
        assert_eq!(root_warmup["model"], Model::Astra.as_str());
        assert_eq!(root_warmup["reasoning"]["effort"], "low");
        assert_eq!(root_warmup["service_tier"], "ultrafast");
        send_warmup(&mut root, "resp-root-warmup").await?;
        let root_turn = next_json(&mut root).await?;
        assert_eq!(root_turn["service_tier"], "ultrafast");
        send_final(&mut root, "resp-root").await?;

        Ok::<_, eyre::Report>((child_turn, root_turn))
    });

    let (handles, mut received_handles) = tokio::sync::mpsc::unbounded_channel::<AgentHandle>();
    let workspace = temporary_workspace("configured-clean-spawn")?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(endpoint)
        .build()?;
    let (root, root_events) = Nanocodex::builder(openai)
        .model(Model::Astra)
        .service_tier(ServiceTier::Ultrafast)
        .thinking(Thinking::Low)
        .session_id(test_session_id())
        .workspace(&workspace)
        .tools_factory(move |handle| {
            drop(handles.send(handle));
            Tools::builder().without_defaults().build()
        })
        .build()?;
    let root_handle = received_handles
        .recv()
        .await
        .ok_or_else(|| eyre!("root tool factory did not receive an agent handle"))?;

    let (child, child_events) = root_handle
        .spawn_with(
            SpawnOptions::new()
                .model(Model::Luna)
                .thinking(Thinking::Medium),
        )
        .await?;
    received_handles
        .recv()
        .await
        .ok_or_else(|| eyre!("clean child tool factory did not receive an agent handle"))?;
    let child_result = child.prompt("child turn").await?.result().await?;
    assert_eq!(
        child_result
            .usage()
            .unwrap()
            .estimated_cost()
            .unwrap()
            .service_tier(),
        ServiceTier::Fast
    );
    let ChildSnapshot::Codex(child_runtime) = child.runtime_snapshot().await? else {
        return Err(eyre!("native child returned a different checkpoint family"));
    };
    assert_eq!(child_runtime.service_tier, ServiceTier::Ultrafast);
    root.prompt("root turn").await?.result().await?;
    let ChildSnapshot::Codex(root_runtime) = root.runtime_snapshot().await? else {
        return Err(eyre!("native agent returned a different checkpoint family"));
    };
    assert_eq!(root_runtime.service_tier, ServiceTier::Ultrafast);

    drop((root, child, root_events, child_events));
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn cloned_builders_singleflight_one_shared_prefix_warmup() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut first = accept_async(stream).await?;
        let warmup = next_json(&mut first).await?;
        assert_eq!(warmup["prompt_cache_key"], "shared-prefix");
        assert_eq!(warmup["service_tier"], "ultrafast");
        let first_session = warmup["client_metadata"]["session_id"]
            .as_str()
            .ok_or_else(|| eyre!("first warmup omitted its session id"))?
            .to_owned();
        send_warmup(&mut first, "resp-shared-warmup").await?;
        let first_turn = next_json(&mut first).await?;
        assert_eq!(first_turn["previous_response_id"], "resp-shared-warmup");
        assert_eq!(first_turn["service_tier"], "ultrafast");
        send_final(&mut first, "resp-first").await?;

        let (stream, _) = listener.accept().await?;
        let mut second = accept_async(stream).await?;
        let second_turn = next_json(&mut second).await?;
        assert_eq!(second_turn["prompt_cache_key"], "shared-prefix");
        assert_eq!(second_turn["service_tier"], "ultrafast");
        assert!(second_turn.get("previous_response_id").is_none());
        assert_ne!(second_turn["client_metadata"]["session_id"], first_session);
        assert_eq!(second_turn["input"].as_array().map(Vec::len), Some(5));
        assert!(second_turn.get("generate").is_none());
        send_final(&mut second, "resp-second").await
    });

    let workspace = temporary_workspace("shared-warmup")?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(endpoint)
        .build()?;
    let builder = Nanocodex::builder(openai)
        .model(Model::Astra)
        .service_tier(ServiceTier::Ultrafast)
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .prompt_cache_key("shared-prefix")
        .shared_prompt_cache();

    let (first, mut first_events) = builder.clone().build()?;
    let first_session = first.session_id().to_owned();
    first.prompt("first turn").await?.result().await?;
    let ChildSnapshot::Codex(first_runtime) = first.runtime_snapshot().await? else {
        return Err(eyre!("native agent returned a different checkpoint family"));
    };
    assert_eq!(first_runtime.service_tier, ServiceTier::Ultrafast);
    drop(first);
    let mut first_warmup_source = None;
    while let Some(event) = first_events.recv().await {
        if event.kind == AgentEventKind::ModelWarmupCompleted {
            first_warmup_source = Some(event.decode_payload::<Value>()?["source"].clone());
        }
    }

    let (second, mut second_events) = builder.build()?;
    assert_ne!(second.session_id(), first_session);
    second.prompt("second turn").await?.result().await?;
    let ChildSnapshot::Codex(second_runtime) = second.runtime_snapshot().await? else {
        return Err(eyre!("native agent returned a different checkpoint family"));
    };
    assert_eq!(second_runtime.service_tier, ServiceTier::Ultrafast);
    drop(second);
    let mut second_warmup_source = None;
    while let Some(event) = second_events.recv().await {
        if event.kind == AgentEventKind::ModelWarmupCompleted {
            let payload = event.decode_payload::<Value>()?;
            assert!(payload.get("response_id").is_none());
            second_warmup_source = Some(payload["source"].clone());
        }
    }

    assert_eq!(first_warmup_source, Some(json!("response")));
    assert_eq!(second_warmup_source, Some(json!("shared_prefix")));
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}
