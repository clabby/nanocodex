//! End-to-end behavioral contract against a synthetic loopback Messages API.
use axum::{Json, Router, response::IntoResponse, routing::post};
use futures_util::StreamExt;
use nanocodex_agent::{Nanocodex, events::AgentEventKind};
use nanocodex_claude::{Claude, ClaudeClient, Effort, ToolDefinition};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn stream(blocks: Vec<Value>, stop: &str) -> String {
    let mut out = String::new();
    let mut emit = |event: Value| out.push_str(&format!("data: {event}\n\n"));
    emit(
        json!({"type":"message_start","message":{"id":"msg","role":"assistant","model":"test","content":[],"usage":{"input_tokens":3,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"output_tokens":0}}}),
    );
    for (i, block) in blocks.iter().enumerate() {
        let start = if block["type"] == "text" {
            json!({"type":"text","text":""})
        } else {
            json!({"type":"tool_use","id":block["id"],"name":block["name"],"input":{}})
        };
        emit(json!({"type":"content_block_start","index":i,"content_block":start}));
        let delta = if block["type"] == "text" {
            json!({"type":"text_delta","text":block["text"]})
        } else {
            json!({"type":"input_json_delta","partial_json":block["input"].to_string()})
        };
        emit(json!({"type":"content_block_delta","index":i,"delta":delta}));
        emit(json!({"type":"content_block_stop","index":i}));
    }
    emit(json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":5}}));
    emit(json!({"type":"message_stop"}));
    out
}

#[tokio::test]
async fn stream_tool_once_compact_and_failed_turn_preserves_history() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let received = Arc::new(Mutex::new(Vec::<Value>::new()));
    let requests = received.clone();
    let app = Router::new().route("/v1/messages", post(move |Json(body): Json<Value>| {
        let requests = requests.clone();
        async move {
            let index = { let mut r = requests.lock().unwrap(); r.push(body.clone()); r.len() };
            if index == 5 { return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "synthetic failure".to_string()).into_response(); }
            let (blocks, reason) = match index {
                1 => (vec![json!({"type":"text","text":"Hello "}),json!({"type":"text","text":"world"})], "end_turn"),
                2 => (vec![json!({"type":"tool_use","id":"tool-1","name":"lookup","input":{"key":"x"}})], "tool_use"),
                3 => (vec![json!({"type":"text","text":"found value"})], "end_turn"),
                4 => (vec![json!({"type":"text","text":"SUMMARY: user greeting and lookup x = value"})], "end_turn"),
                _ => (vec![json!({"type":"text","text":"after failure"})], "end_turn"),
            };
            ([("content-type","text/event-stream")], stream(blocks,reason)).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{address}/v1/messages"),
        "synthetic",
    );
    let claude = Claude::new(client, "test");
    let (agent, mut events) = Nanocodex::builder(claude)
        .max_tokens(128)
        .automatic_cache(true)
        .effort(Effort::High)
        .tool(
            ToolDefinition {
                name: "lookup".into(),
                description: "Test lookup".into(),
                input_schema: json!({"type":"object","properties":{"key":{"type":"string"}}}),
                strict: None,
            },
            move |input| {
                counter.fetch_add(1, Ordering::SeqCst);
                async move { Ok(format!("value for {}", input["key"])) }
            },
        )
        .build()
        .unwrap();
    let first = agent.prompt("hello").await.unwrap().result().await.unwrap();
    assert_eq!(first.final_message(), "Hello world");
    assert_eq!(first.usage().unwrap().cached_input_tokens(), 2);
    assert_eq!(first.usage().unwrap().cache_write_input_tokens(), 1);
    assert_eq!(first.usage().unwrap().total_tokens(), 11);
    assert_eq!(
        first.usage().unwrap().cost_status(),
        nanocodex_agent::CostStatus::Other
    );
    assert_eq!(
        agent
            .prompt("lookup x")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "found value"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // /compact is a normal summary request. The old history is swapped only after success.
    agent.compact().await.unwrap();
    assert!(
        agent
            .prompt("fail now")
            .await
            .unwrap()
            .result()
            .await
            .is_err()
    );
    assert_eq!(
        agent
            .prompt("continue")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "after failure"
    );
    let mut kinds = Vec::new();
    let mut next_seq = 1u64;
    while kinds
        .iter()
        .filter(|kind| {
            matches!(
                kind,
                AgentEventKind::RunCompleted | AgentEventKind::RunFailed
            )
        })
        .count()
        < 4
    {
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.seq, next_seq, "lost or misordered backend event");
        next_seq += 1;
        kinds.push(event.kind);
    }
    assert!(kinds.contains(&AgentEventKind::AssistantDelta));
    assert!(kinds.contains(&AgentEventKind::ToolCall));
    assert!(kinds.contains(&AgentEventKind::ToolResult));
    let log = received.lock().unwrap();
    assert_eq!(log.len(), 6);
    assert_eq!(log[0]["stream"], true);
    assert_eq!(log[0]["cache_control"], json!({"type":"ephemeral"}));
    assert_eq!(log[0]["output_config"], json!({"effort":"high"}));
    assert_eq!(log[3]["cache_control"], json!({"type":"ephemeral"}));
    assert_eq!(log[2]["messages"][3]["role"], "assistant");
    assert_eq!(log[2]["messages"][4]["role"], "user");
    assert_eq!(log[2]["messages"][4]["content"][0]["type"], "tool_result");
    assert_eq!(log[2]["messages"][4]["content"][0]["tool_use_id"], "tool-1");
    assert_eq!(
        log[2]["messages"][4]["content"][0]["content"],
        "value for \"x\""
    );
    assert!(log[3]["messages"].as_array().unwrap().len() > 4);
    // The observed Claude Code continuation installs the summary as USER
    // context, not as an API system prompt or a fabricated signed block.
    assert_eq!(log[4]["messages"].as_array().unwrap().len(), 1);
    assert_eq!(log[5]["messages"].as_array().unwrap().len(), 1);
    let resumed = log[5]["messages"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(resumed.starts_with("This session is being continued from a previous conversation"));
    assert!(resumed.contains("SUMMARY: user greeting"));
    assert!(resumed.contains("continue"));
    assert!(log[5].get("system").is_none());
    server.abort();
}

#[tokio::test]
async fn failed_compaction_and_cancelled_turn_keep_previous_context() {
    use nanocodex_agent::PromptRequest;
    use tokio::sync::Notify;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let arrived = Arc::new(Notify::new());
    let app = Router::new().route(
        "/v1/messages",
        post({
            let requests = requests.clone();
            let arrived = arrived.clone();
            move |Json(body): Json<Value>| {
                let requests = requests.clone();
                let arrived = arrived.clone();
                async move {
                    let index = {
                        let mut log = requests.lock().unwrap();
                        log.push(body);
                        log.len()
                    };
                    match index {
                        2 => (
                            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                            "synthetic compact failure".to_string(),
                        )
                            .into_response(),
                        4 => {
                            arrived.notify_one();
                            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                            (
                                [("content-type", "text/event-stream")],
                                stream(
                                    vec![json!({"type":"text","text":"do not commit"})],
                                    "end_turn",
                                ),
                            )
                                .into_response()
                        }
                        _ => (
                            [("content-type", "text/event-stream")],
                            stream(
                                vec![json!({"type":"text","text":format!("ok-{index}")})],
                                "end_turn",
                            ),
                        )
                            .into_response(),
                    }
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{addr}/v1/messages"),
        "synthetic",
    );
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .build()
        .unwrap();
    agent.prompt("first").await.unwrap().result().await.unwrap();
    assert!(agent.compact().await.is_err());
    agent
        .prompt("after failed compact")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    let notified = arrived.notified();
    let turn = agent.prompt("cancel me").await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), notified)
        .await
        .unwrap();
    turn.cancel().await.unwrap();
    assert!(turn.result().await.is_err());
    assert!(
        agent
            .prompt(PromptRequest::new("cancel on admission").cancel_on_admission())
            .await
            .unwrap()
            .result()
            .await
            .is_err()
    );
    assert_eq!(
        agent
            .prompt("after cancel")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "ok-5"
    );
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 5);
    assert_eq!(log[2]["messages"][0]["content"][0]["text"], "first");
    assert_eq!(log[4]["messages"].as_array().unwrap().len(), 5);
    assert_eq!(log[4]["messages"][4]["content"][0]["text"], "after cancel");
    server.abort();
}

#[tokio::test]
async fn auto_compacts_at_usage_threshold_before_next_prompt() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let seen = requests.clone();
    let app = Router::new().route(
        "/v1/messages",
        post(move |Json(body): Json<Value>| {
            let seen = seen.clone();
            async move {
                let index = {
                    let mut log = seen.lock().unwrap();
                    log.push(body);
                    log.len()
                };
                let text = match index {
                    1 => "first answer",
                    2 => "carry first answer",
                    _ => "second answer",
                };
                (
                    [("content-type", "text/event-stream")],
                    stream(vec![json!({"type":"text","text":text})], "end_turn"),
                )
                    .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{addr}/v1/messages"),
        "synthetic",
    );
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .context_window_tokens(10)
        .build()
        .unwrap();
    assert_eq!(
        agent
            .prompt("first")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "first answer"
    );
    assert_eq!(
        agent
            .prompt("second")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "second answer"
    );
    let log = requests.lock().unwrap();
    assert_eq!(
        log.len(),
        3,
        "one summary generation before the second prompt"
    );
    assert!(log[1]["messages"].as_array().unwrap().len() >= 3);
    let next = log[2]["messages"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(next.contains("carry first answer"));
    assert!(next.contains("second"));
    assert!(!next.contains("first answer\n\nfirst answer"));
    server.abort();
}

#[tokio::test]
async fn latest_model_sends_opus_5_5_without_legacy_thinking_parameters() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let received = Arc::new(Mutex::new(None::<Value>));
    let captured = received.clone();
    let app = Router::new().route(
        "/v1/messages",
        post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                *captured.lock().unwrap() = Some(body);
                (
                    [("content-type", "text/event-stream")],
                    stream(vec![json!({"type":"text","text":"ok"})], "end_turn"),
                )
                    .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{address}/v1/messages"),
        "synthetic",
    );
    let (agent, _) = Nanocodex::builder(Claude::latest(client)).build().unwrap();
    assert_eq!(
        agent
            .prompt("hello")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "ok"
    );
    let body = received.lock().unwrap().clone().unwrap();
    assert_eq!(body["model"], "claude-opus-5-5");
    assert!(body.get("thinking").is_none());
    assert!(body.get("tool_choice").is_none());
}

#[tokio::test]
async fn latest_model_does_not_compact_at_legacy_200k_window() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let received = Arc::new(AtomicUsize::new(0));
    let count = received.clone();
    let app = Router::new().route(
        "/v1/messages",
        post(move |Json(_): Json<Value>| {
            let count = count.clone();
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                let output = stream(vec![json!({"type":"text","text":"ok"})], "end_turn")
                    .replace("\"input_tokens\":3", "\"input_tokens\":250000");
                ([("content-type", "text/event-stream")], output).into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{address}/v1/messages"),
        "synthetic",
    );
    let (agent, _) = Nanocodex::builder(Claude::latest(client)).build().unwrap();
    let first = agent.prompt("one").await.unwrap().result().await.unwrap();
    assert_eq!(first.usage().unwrap().input_tokens(), 250_000);
    agent.prompt("two").await.unwrap().result().await.unwrap();
    assert_eq!(
        received.load(Ordering::SeqCst),
        2,
        "unexpected early compaction"
    );
}
