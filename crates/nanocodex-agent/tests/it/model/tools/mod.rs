use super::*;

mod environment;
mod panic;
mod parallel;
mod yielded_results;

struct NativeToolSearch;
struct NamespacedEcho;

#[nanocodex_oai_tools::contract::async_trait]
impl nanocodex_oai_tools::Tool for NamespacedEcho {
    fn definition(&self) -> nanocodex_oai_tools::ToolDefinition {
        nanocodex_oai_tools::ToolDefinition::function(
            "test_namespace__echo",
            "Echo one value.",
            json!({
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        input: nanocodex_oai_tools::ToolInput,
        _context: nanocodex_oai_tools::ToolContext<'_>,
    ) -> nanocodex_oai_tools::ToolResult {
        let arguments: Value = input.decode_json()?;
        Ok(nanocodex_oai_tools::ToolOutput::text(
            arguments["value"].as_str().unwrap_or_default(),
        ))
    }
}

#[tokio::test]
async fn code_mode_executes_nested_function_and_custom_tools() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        let warmup = next_json(&mut socket).await?;
        let names = warmup["input"][0]["tools"]
            .as_array()
            .ok_or_else(|| eyre!("warmup tools were not an array"))?
            .iter()
            .filter_map(|definition| definition["name"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["exec", "wait"]);
        send_warmup(&mut socket, "resp-warmup").await?;
        let generation = next_json(&mut socket).await?;
        assert_eq!(generation["previous_response_id"], "resp-warmup");
        send_json(&mut socket, completed_response("resp-tools", &[json!({
            "type": "custom_tool_call", "call_id": "call-tools", "name": "exec",
            "input": r#"await tools.update_plan({plan:[{step:"exercise nested tools",status:"completed"}]});
text(await tools.apply_patch("*** Begin Patch\n*** Add File: nested-tool.txt\n+nested dispatch worked\n*** End Patch"));
text(await tools.test_namespace__echo({value:"namespaced nested dispatch worked"}));
text(await tools.exec_command({cmd:"printf nested-shell-dispatch-worked",login:false}));"#
        })])).await?;
        let continuation = next_json(&mut socket).await?;
        assert_eq!(continuation["previous_response_id"], "resp-tools");
        assert_eq!(continuation["input"][0]["type"], "custom_tool_call_output");
        assert_eq!(continuation["input"][0]["call_id"], "call-tools");
        let result = continuation["input"][0]["output"].to_string();
        assert!(
            result.contains("namespaced nested dispatch worked"),
            "{continuation}"
        );
        assert!(
            result.contains("nested-shell-dispatch-worked"),
            "{continuation}"
        );
        send_final(&mut socket, "resp-final").await
    });

    let workspace = temporary_workspace("code-mode-nested-tools")?;
    let tools = Tools::builder().tool(NamespacedEcho).build()?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(&endpoint)
        .build()?;
    let (agent, events) = Nanocodex::builder(openai)
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .session_id(test_session_id())
        .tools(tools)
        .build()?;
    let turn = agent.prompt("Use the nested tools.").await?;
    drop(agent);
    let mut output = Vec::new();
    let (event_result, turn_result) = tokio::join!(events.write_jsonl(&mut output), turn.result());
    event_result?;
    turn_result?;
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    assert_eq!(
        std::fs::read_to_string(workspace.join("nested-tool.txt"))?,
        "nested dispatch worked\n"
    );
    let output = String::from_utf8(output)?;
    assert!(output.contains(r#""tool":"update_plan""#));
    assert!(output.contains(r#""tool":"apply_patch""#));
    assert!(output.contains(r#""tool":"test_namespace__echo""#));
    let events = output
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
    let nested_results = events
        .iter()
        .filter(|event| event["type"] == "tool.result" && event["payload"]["tool"] != "exec")
        .collect::<Vec<_>>();
    assert_eq!(nested_results.len(), 4);
    assert!(
        nested_results
            .iter()
            .all(|event| event["payload"].get("structured_result").is_some())
    );
    let nested_shell_result = nested_results
        .into_iter()
        .find(|event| event["payload"]["tool"] == "exec_command")
        .ok_or_else(|| eyre!("nested shell result event was not emitted"))?;
    assert_eq!(
        nested_shell_result["payload"]["structured_result"]["exit_code"],
        0
    );
    assert_eq!(
        nested_shell_result["payload"]["structured_result"]["output"],
        "nested-shell-dispatch-worked"
    );
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[nanocodex_oai_tools::contract::async_trait]
impl nanocodex_oai_tools::Tool for NativeToolSearch {
    fn definition(&self) -> nanocodex_oai_tools::ToolDefinition {
        nanocodex_oai_tools::ToolDefinition::tool_search(
            "client",
            "Search caller-configured deferred tools.",
            nanocodex_oai_api::responses::JsonSchema::from(json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query for deferred tools."
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of tools to return."
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            })),
        )
    }

    async fn execute(
        &self,
        input: nanocodex_oai_tools::ToolInput,
        _context: nanocodex_oai_tools::ToolContext<'_>,
    ) -> nanocodex_oai_tools::ToolResult {
        let arguments: Value = input.decode_json()?;
        assert_eq!(arguments, json!({"query": "calendar create", "limit": 1}));
        Ok(nanocodex_oai_tools::ToolOutput::json(&json!([{
            "type": "function",
            "name": "calendar_create_event",
            "description": "Create a calendar event.",
            "defer_loading": true,
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"}
                },
                "required": ["title"],
                "additionalProperties": false
            }
        }])))
    }
}

#[tokio::test]
async fn configured_tool_search_runs_inside_code_mode() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        let warmup = next_json(&mut socket).await?;
        let names = warmup["input"][0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|definition| definition["name"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["exec", "wait"]);
        send_warmup(&mut socket, "resp-warmup").await?;
        let generation = next_json(&mut socket).await?;
        assert_eq!(generation["previous_response_id"], "resp-warmup");
        send_json(
            &mut socket,
            completed_response(
                "resp-search",
                &[json!({
                    "type": "custom_tool_call", "call_id": "search-1", "name": "exec",
                    "input": "text(await tools.tool_search({query:'calendar create',limit:1}));"
                })],
            ),
        )
        .await?;
        let continuation = next_json(&mut socket).await?;
        assert_eq!(continuation["previous_response_id"], "resp-search");
        assert_eq!(continuation["input"][0]["type"], "custom_tool_call_output");
        assert_eq!(continuation["input"][0]["call_id"], "search-1");
        assert!(
            continuation["input"][0]["output"]
                .to_string()
                .contains("calendar_create_event"),
            "{continuation}"
        );
        assert!(
            !continuation["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["type"] == "tool_search_output")
        );
        send_final(&mut socket, "resp-final").await
    });

    let workspace = temporary_workspace("native-tool-search")?;
    let tools = Tools::builder()
        .without_defaults()
        .tool(NativeToolSearch)
        .build()?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(&endpoint)
        .build()?;
    let (agent, events) = Nanocodex::builder(openai)
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .session_id(test_session_id())
        .tools(tools)
        .build()?;
    let turn = agent.prompt("Find the calendar creation tool.").await?;
    drop(agent);
    let mut output = Vec::new();
    let (event_result, turn_result) = tokio::join!(events.write_jsonl(&mut output), turn.result());
    event_result?;
    turn_result?;
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    let output = String::from_utf8(output)?;
    assert!(output.contains(r#""tool":"tool_search""#), "{output}");
    assert!(output.contains("\"run.completed\""), "{output}");
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn mcp_tool_search_discovers_and_calls_nested_tools() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        let warmup = next_json(&mut socket).await?;
        let names = warmup["input"][0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|definition| definition["name"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["exec", "wait"]);
        send_warmup(&mut socket, "resp-warmup").await?;
        let generation = next_json(&mut socket).await?;
        assert_eq!(generation["previous_response_id"], "resp-warmup");
        send_json(&mut socket, completed_response("resp-search", &[json!({
            "type": "custom_tool_call", "call_id": "search-mcp", "name": "exec",
            "input": "text(await tools.tool_search({query:'echo deterministic message',limit:1}));"
        })])).await?;
        let searched = next_json(&mut socket).await?;
        assert_eq!(searched["input"][0]["type"], "custom_tool_call_output");
        assert_eq!(searched["input"][0]["call_id"], "search-mcp");
        assert!(
            searched["input"][0]["output"].to_string().contains("echo"),
            "{searched}"
        );
        assert!(
            !searched["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["type"] == "tool_search_output")
        );
        send_json(
            &mut socket,
            completed_response(
                "resp-tool",
                &[json!({
                    "type": "custom_tool_call", "call_id": "call-mcp", "name": "exec",
                    "input": "text(await tools.mcp__fixture__echo({message:'hello'}));"
                })],
            ),
        )
        .await?;
        let called = next_json(&mut socket).await?;
        assert_eq!(called["input"][0]["type"], "custom_tool_call_output");
        assert_eq!(called["input"][0]["call_id"], "call-mcp");
        assert!(
            called["input"][0]["output"]
                .to_string()
                .contains("fixture:hello"),
            "{called}"
        );
        send_final(&mut socket, "resp-final").await
    });

    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../nanocodex-oai-tools/tests/fixtures/mcp-stdio-server.mjs");
    let mcp = nanocodex_oai_tools::mcp::Mcp::builder()
        .server(
            "fixture",
            nanocodex_oai_tools::mcp::McpServer::stdio("node").arg(fixture.to_string_lossy()),
        )
        .build()?;
    let workspace = temporary_workspace("mcp-native-tool-search")?;
    let tools = Tools::builder().provider(mcp).build()?;
    let openai = OpenAi::builder("test-key")
        .websocket_url(&endpoint)
        .build()?;
    let (agent, events) = Nanocodex::builder(openai)
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .session_id(test_session_id())
        .tools(tools)
        .build()?;
    let turn = agent.prompt("Find and call the MCP echo tool.").await?;
    drop(agent);
    let mut output = Vec::new();
    let (event_result, turn_result) = tokio::join!(events.write_jsonl(&mut output), turn.result());
    event_result?;
    turn_result?;
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    let output = String::from_utf8(output)?;
    assert!(output.contains(r#""tool":"tool_search""#), "{output}");
    assert!(
        output.contains(r#""tool":"mcp__fixture__echo""#),
        "{output}"
    );
    assert!(output.contains("\"run.completed\""), "{output}");
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn connection_local_response_code_mode_round_trip() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        let warmup = next_json(&mut socket).await?;
        assert_warmup(&warmup);
        send_json(
            &mut socket,
            json!({
                "type": "response.metadata",
                "headers": { "x-codex-turn-state": "sticky-test" }
            }),
        )
        .await?;
        send_warmup(&mut socket, "resp-warmup").await?;

        let generation = next_json(&mut socket).await?;
        assert_eq!(generation["previous_response_id"], "resp-warmup");
        assert_eq!(generation["store"], false);
        assert!(generation.get("generate").is_none());
        assert_eq!(generation["input"].as_array().map(Vec::len), Some(3));
        assert_eq!(generation["input"][0]["role"], "developer");
        assert_eq!(generation["input"][1]["role"], "user");
        assert_eq!(generation["input"][2]["role"], "user");
        assert_eq!(
            generation["client_metadata"]["x-codex-turn-state"],
            "sticky-test"
        );
        send_json(
            &mut socket,
            completed_response(
                "resp-tool",
                &[json!({
                    "id": "item-exec",
                    "type": "custom_tool_call",
                    "call_id": "call-exec",
                    "name": "exec",
                    "input": "const result = await tools.exec_command({cmd: \"printf hello\"}); text(result.output);"
                })],
            ),
        )
        .await?;

        let continuation = next_json(&mut socket).await?;
        assert_eq!(continuation["previous_response_id"], "resp-tool");
        assert_eq!(continuation["input"].as_array().map(Vec::len), Some(1));
        assert_eq!(continuation["input"][0]["type"], "custom_tool_call_output");
        assert_eq!(continuation["input"][0]["call_id"], "call-exec");
        assert!(continuation["input"][0].get("success").is_none());
        assert!(
            continuation["input"][0]["output"]
                .as_array()
                .is_some_and(|content| content.iter().any(|item| {
                    item["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("hello"))
                }))
        );
        send_final(&mut socket, "resp-final").await
    });

    let workspace = temporary_workspace("code-mode")?;
    let output = run_model(&endpoint, &workspace, "run a shell command").await?;
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    assert!(output.contains("\"tool\":\"exec\""));
    let shell_result = output
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .find(|event| event["type"] == "tool.result" && event["payload"]["tool"] == "exec_command")
        .ok_or_else(|| eyre!("nested shell result event was not emitted"))?;
    assert!(
        shell_result["payload"]["result"]
            .as_str()
            .is_some_and(|result| result.contains("Process exited with code 0"))
    );
    assert_eq!(shell_result["payload"]["structured_result"]["exit_code"], 0);
    assert_eq!(
        shell_result["payload"]["structured_result"]["output"],
        "hello"
    );
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn unsupported_direct_tools_return_failed_results_to_the_model() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        assert_warmup(&next_json(&mut socket).await?);
        send_warmup(&mut socket, "resp-warmup").await?;

        let generation = next_json(&mut socket).await?;
        assert_eq!(generation["previous_response_id"], "resp-warmup");
        send_json(
            &mut socket,
            completed_response(
                "resp-unsupported",
                &[
                    json!({
                        "type": "custom_tool_call",
                        "call_id": "call-custom",
                        "name": "missing_custom",
                        "input": "raw input"
                    }),
                    json!({
                        "type": "function_call",
                        "call_id": "call-function",
                        "namespace": "example::",
                        "name": "missing_function",
                        "arguments": "not json"
                    }),
                ],
            ),
        )
        .await?;

        let continuation = next_json(&mut socket).await?;
        assert_eq!(continuation["previous_response_id"], "resp-unsupported");
        let input = continuation["input"]
            .as_array()
            .ok_or_else(|| eyre!("continuation input was not an array"))?;
        assert_eq!(input[0]["type"], "custom_tool_call_output");
        assert_eq!(input[0]["call_id"], "call-custom");
        assert_eq!(
            input[0]["output"],
            "unsupported custom tool call: missing_custom"
        );
        assert_client_item_id(&input[0], "ctco");
        assert_eq!(input[1]["type"], "function_call_output");
        assert_eq!(input[1]["call_id"], "call-function");
        assert_eq!(
            input[1]["output"],
            "unsupported call: example::__missing_function"
        );
        assert_client_item_id(&input[1], "fco");
        send_final(&mut socket, "resp-final").await
    });

    let workspace = temporary_workspace("unsupported-tools")?;
    let output = run_model(&endpoint, &workspace, "recover from unsupported tools").await?;
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    assert_eq!(
        output.matches(r#""status":"failed""#).count(),
        2,
        "{output}"
    );
    assert!(output.contains("\"tool_calls\":2"));
    assert!(output.contains("\"run.completed\""));
    assert!(!output.contains("\"run.failed\""));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn code_mode_notify_adds_a_named_exec_output_to_the_next_request() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        assert_warmup(&next_json(&mut socket).await?);
        send_warmup(&mut socket, "resp-warmup").await?;

        let generation = next_json(&mut socket).await?;
        assert_eq!(generation["previous_response_id"], "resp-warmup");
        send_json(
            &mut socket,
            completed_response(
                "resp-notify",
                &[json!({
                    "type": "custom_tool_call",
                    "call_id": "call-exec",
                    "name": "exec",
                    "input": "notify({phase: \"working\"}); text(\"done\");"
                })],
            ),
        )
        .await?;

        let continuation = next_json(&mut socket).await?;
        assert_eq!(continuation["previous_response_id"], "resp-notify");
        let input = continuation["input"]
            .as_array()
            .ok_or_else(|| eyre!("continuation input was not an array"))?;
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["type"], "custom_tool_call_output");
        assert_eq!(input[0]["call_id"], "call-exec");
        assert!(input[0].get("name").is_none());
        assert!(input[0].to_string().contains("done"));
        assert_eq!(input[1]["type"], "custom_tool_call_output");
        assert_eq!(input[1]["call_id"], "call-exec");
        assert_eq!(input[1]["name"], "exec");
        assert_eq!(input[1]["output"], r#"{"phase":"working"}"#);
        assert!(input[1].get("success").is_none());
        send_final(&mut socket, "resp-final").await
    });

    let workspace = temporary_workspace("code-mode-notify")?;
    run_model(&endpoint, &workspace, "send a progress notification").await?;
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn prepares_images_and_stops_on_invalid_image_requests() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        assert_warmup(&next_json(&mut socket).await?);
        send_warmup(&mut socket, "resp-warmup").await?;

        let generation = next_json(&mut socket).await?;
        assert_eq!(generation["previous_response_id"], "resp-warmup");
        send_json(
            &mut socket,
            completed_response(
                "resp-image",
                &[json!({
                    "type": "custom_tool_call",
                    "call_id": "call-image",
                    "name": "exec",
                    "input": "image(\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=\", \"original\");"
                })],
            ),
        )
        .await?;

        let continuation = next_json(&mut socket).await?;
        let output = continuation["input"][0]["output"]
            .as_array()
            .ok_or_else(|| eyre!("image tool output was not content"))?;
        let image = output
            .iter()
            .find(|item| item["type"] == "input_image")
            .ok_or_else(|| eyre!("prepared image was missing"))?;
        assert!(
            image["image_url"]
                .as_str()
                .is_some_and(|url| url.starts_with("data:image/png;base64,"))
        );
        assert!(image.get("detail").is_none());

        send_json(
            &mut socket,
            json!({
                "type": "response.failed",
                "response": {
                    "id": "resp-invalid-image",
                    "status": "failed",
                    "error": {
                        "code": "invalid_image",
                        "message": "The image data you provided does not represent a valid image"
                    }
                }
            }),
        )
        .await?;

        Ok::<(), eyre::Report>(())
    });

    let workspace = temporary_workspace("images")?;
    let error = run_model(&endpoint, &workspace, "inspect images")
        .await
        .expect_err("invalid tool image should fail the turn");
    let error = error
        .downcast_ref::<NanocodexError>()
        .ok_or_else(|| eyre!("invalid image returned the wrong error type"))?;
    assert!(matches!(
        error.responses_error(),
        Some(ResponsesError::InvalidImageRequest { .. })
    ));
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn yielded_exec_cell_continues_through_direct_wait_tool() -> Result<()> {
    assert_yielded_exec_cell(false).await
}

#[tokio::test]
async fn yielded_exec_cell_finishes_nested_tool_started_before_yield() -> Result<()> {
    assert_yielded_exec_cell(true).await
}

async fn assert_yielded_exec_cell(start_before_yield: bool) -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        assert_warmup(&next_json(&mut socket).await?);
        send_warmup(&mut socket, "resp-warmup").await?;

        let generation = next_json(&mut socket).await?;
        assert_eq!(generation["previous_response_id"], "resp-warmup");
        send_json(
            &mut socket,
            completed_response(
                "resp-exec",
                &[json!({
                    "type": "custom_tool_call",
                    "call_id": "call-exec",
                    "name": "exec",
                    "input": if start_before_yield {
                        "const pending = tools.exec_command({cmd: \"sleep 1; printf after\", login: false, yield_time_ms: 10000}); await new Promise(resolve => setTimeout(resolve, 100)); text(\"before\"); await yield_control(); text((await pending).output);"
                    } else {
                        "text(\"before\"); await yield_control(); const result = await tools.exec_command({cmd: \"printf after\", login: false}); text(result.output);"
                    }
                })],
            ),
        )
        .await?;

        let yielded = next_json(&mut socket).await?;
        assert_eq!(yielded["previous_response_id"], "resp-exec");
        assert_eq!(yielded["input"][0]["type"], "custom_tool_call_output");
        assert!(
            yielded
                .to_string()
                .contains("Script running with cell ID 1")
        );
        send_json(
            &mut socket,
            completed_response(
                "resp-wait",
                &[json!({
                    "type": "function_call",
                    "call_id": "call-wait",
                    "name": "wait",
                    "arguments": "{\"cell_id\":\"1\",\"yield_time_ms\":30000}"
                })],
            ),
        )
        .await?;

        let completed = next_json(&mut socket).await?;
        assert_eq!(completed["previous_response_id"], "resp-wait");
        assert_eq!(completed["input"][0]["type"], "function_call_output");
        assert_eq!(completed["input"][0]["call_id"], "call-wait");
        assert!(completed.to_string().contains("after"));
        send_final(&mut socket, "resp-final").await
    });

    let workspace = temporary_workspace("code-mode-wait")?;
    let output = run_model(&endpoint, &workspace, "yield and wait").await?;
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    assert!(output.contains("\"tool\":\"wait\""));
    let events = output
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
    let nested_call_index = events
        .iter()
        .position(|event| {
            event["type"] == "tool.call" && event["payload"]["call_id"] == "call-exec/code-1"
        })
        .ok_or_else(|| eyre!("nested call did not retain its original exec lineage"))?;
    assert_eq!(events[nested_call_index]["payload"]["model_call_index"], 1);
    if start_before_yield {
        let yield_index = events
            .iter()
            .position(|event| {
                event["type"] == "tool.result" && event["payload"]["call_id"] == "call-exec"
            })
            .ok_or_else(|| eyre!("exec did not yield"))?;
        assert!(nested_call_index < yield_index);
    }
    let nested_results = events
        .iter()
        .filter(|event| {
            event["type"] == "tool.result" && event["payload"]["call_id"] == "call-exec/code-1"
        })
        .collect::<Vec<_>>();
    assert_eq!(
        nested_results.len(),
        1,
        "nested tool must finish exactly once"
    );
    assert_eq!(nested_results[0]["payload"]["tool"], "exec_command");
    assert_eq!(nested_results[0]["payload"]["status"], "completed");
    assert_eq!(
        nested_results[0]["payload"]["structured_result"]["exit_code"],
        0
    );
    assert_eq!(
        nested_results[0]["payload"]["structured_result"]["output"],
        "after"
    );
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}
