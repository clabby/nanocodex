//! Synthetic prefix-binding enforcement over the public streaming Messages API.
use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::post};
use futures_util::StreamExt;
use nanocodex_agent::Nanocodex;
use nanocodex_claude::{
    Claude, ClaudeClient, ContentBlock, Message, MessagesRequest, Role, ToolDefinition,
    collect_stream, compact_history,
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn reasoning(id: &str) -> Vec<Value> {
    vec![
        json!({"type":"thinking","thinking":"","signature":format!("signature-{id}"),"opaque":"signed metadata"}),
        json!({"type":"redacted_thinking","data":format!("redacted-{id}"),"opaque":"redacted metadata"}),
    ]
}

fn tool_round(id: &str) -> Vec<Value> {
    let mut blocks = reasoning(id);
    blocks.push(json!({"type":"tool_use","id":id,"name":"effect","input":{"key":id},"caller":{"type":"direct"},"opaque":"call metadata"}));
    blocks
}

fn answer(id: &str) -> Vec<Value> {
    let mut blocks = reasoning(id);
    blocks.push(json!({"type":"text","text":id}));
    blocks
}

async fn provider(
    respond: impl Fn(usize) -> (Vec<Value>, &'static str, u64) + Send + Sync + 'static,
) -> (
    ClaudeClient,
    Arc<Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let received = requests.clone();
    let responses = Arc::new(Mutex::new(Vec::<(Value, Vec<Value>)>::new()));
    let respond = Arc::new(respond);
    let app = Router::new().route("/v1/messages", post(move |Json(body): Json<Value>| {
        let received = received.clone();
        let responses = responses.clone();
        let respond = respond.clone();
        async move {
            let index = {
                let mut log = received.lock().unwrap();
                log.push(body.clone());
                log.len()
            };
            if std::env::var_os("NANOCLAUDE_THINKING_TRACE").is_some() {
                eprintln!("{}", json!({"request_index":index,"request":body}));
            }
            let messages = body["messages"].as_array().unwrap();
            let mut responses = responses.lock().unwrap();
            // These journeys either replay the full reasoning sequence or remove
            // it at a prefix change. Match each replay to its actual generating
            // request, independently of the client's compaction implementation.
            for (position, message) in messages.iter().enumerate() {
                let blocks = message["content"].as_array().unwrap();
                if blocks.is_empty() {
                    return (StatusCode::BAD_REQUEST, "empty message content").into_response();
                }
                if !blocks.iter().any(|block| matches!(block["type"].as_str(), Some("thinking" | "redacted_thinking"))) {
                    continue;
                }
                if !responses.iter().any(|(request, content)| {
                    content == blocks
                        && request["system"] == body["system"]
                        && request["tools"] == body["tools"]
                        && request["messages"].as_array().unwrap() == &messages[..position]
                }) {
                    return (StatusCode::BAD_REQUEST, Json(json!({"type":"error","error":{"type":"invalid_request_error","message":"Invalid signature in thinking block: bound to a different conversation; prior content missing starting messages.0.content.0"}}))).into_response();
                }
            }
            let (blocks, stop, input) = respond(index);
            responses.push((body, blocks.clone()));
            let mut frames = vec![json!({"type":"message_start","message":{"id":format!("response-{index}"),"role":"assistant","model":"test","content":[],"usage":{"input_tokens":input,"output_tokens":0}}})];
            for (index, block) in blocks.into_iter().enumerate() {
                frames.push(json!({"type":"content_block_start","index":index,"content_block":block}));
                frames.push(json!({"type":"content_block_stop","index":index}));
            }
            frames.push(json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":5}}));
            frames.push(json!({"type":"message_stop"}));
            let stream = frames.into_iter().map(|frame| format!("data: {frame}\n\n")).collect::<String>();
            ([("content-type", "text/event-stream")], stream).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        ClaudeClient::new(
            reqwest::Client::new(),
            format!("http://{address}/v1/messages"),
            "synthetic",
        ),
        requests,
        task,
    )
}

#[tokio::test]
async fn compaction_replaces_stale_thinking_and_preserves_new_reasoning_and_receipts() {
    let (client, requests, server) = provider(|index| match index {
        1 => (tool_round("first-effect"), "tool_use", 10),
        2 => (tool_round("second-effect"), "tool_use", 70_000),
        3 => (
            vec![json!({"type":"text","text":"Both effects were requested."})],
            "end_turn",
            10,
        ),
        _ => (answer("completed"), "end_turn", 10),
    })
    .await;
    let effects = Arc::new(AtomicUsize::new(0));
    let counter = effects.clone();
    let receipt = vec![
        json!({"type":"text","text":"committed receipt"}),
        json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQjD0JAAG6ATiGpB8nAAAAAElFTkSuQmCC"}}),
    ];
    let returned = receipt.clone();
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .system("Stable instructions")
        .adaptive_thinking()
        .auto_compact_window_tokens(100_000)
        .tool_blocks(
            ToolDefinition {
                name: "effect".into(),
                description: "Synthetic effect".into(),
                input_schema: json!({"type":"object"}),
                strict: None,
                defer_loading: false,
            },
            move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                let returned = returned.clone();
                async move { Ok(returned) }
            },
        )
        .build()
        .unwrap();
    for prompt in [
        "Perform both effects once",
        "Continue using the completed receipts",
    ] {
        assert_eq!(
            agent
                .prompt(prompt)
                .await
                .unwrap()
                .result()
                .await
                .unwrap()
                .final_message(),
            "completed"
        );
    }
    let log = requests.lock().unwrap();
    assert_eq!(
        log.len(),
        5,
        "no retry is needed after replacing the prefix"
    );
    assert_eq!(effects.load(Ordering::SeqCst), 2);
    assert_eq!(
        log[1]["messages"][1]["content"],
        json!(tool_round("first-effect")),
        "ordinary continuation preserves even empty signed thinking"
    );
    assert_eq!(
        log[3]["messages"][1]["content"],
        json!([tool_round("second-effect")[2]])
    );
    assert_eq!(
        log[3]["messages"][2]["content"][0]["tool_use_id"],
        "second-effect"
    );
    assert_eq!(
        log[3]["messages"][2]["content"][0]["content"],
        json!(receipt)
    );
    assert_eq!(
        log[4]["messages"][3]["content"],
        json!(answer("completed")),
        "new reasoning remains bound to the summarized prefix"
    );
    assert_eq!(
        &log[4]["messages"].as_array().unwrap()[..3],
        log[3]["messages"].as_array().unwrap()
    );
    server.abort();
}

async fn send(client: &ClaudeClient, request: &MessagesRequest) -> Message {
    let mut stream = client.stream(request).await.unwrap();
    let first = stream.next().await.unwrap().unwrap();
    let response = collect_stream(first, stream).await.unwrap();
    Message {
        role: response.role,
        content: response.content,
    }
}

#[tokio::test]
async fn public_compaction_invalidates_thinking_only_when_the_prefix_changes() {
    for (keep_recent, summary) in [(usize::MAX, "Summarized context"), (1, "")] {
        let (client, requests, server) = provider(|index| match index {
            1 => (reasoning("thinking-only"), "end_turn", 10),
            2 => (tool_round("public-effect"), "tool_use", 10),
            _ => (answer("continued"), "end_turn", 10),
        })
        .await;
        let mut request: MessagesRequest = serde_json::from_value(json!({
            "model":"test", "max_tokens":128, "system":"Stable instructions",
            "messages":[{"role":"user","content":[{"type":"text","text":"Earlier question"}]}]
        }))
        .unwrap();
        request.messages.push(send(&client, &request).await);
        request
            .messages
            .push(Message::text(Role::User, "Perform the effect"));
        request.messages.push(send(&client, &request).await);
        request
            .messages
            .push(Message::tool_results(vec![ContentBlock::tool_result(
                "public-effect",
                "receipt",
                false,
            )]));
        let unchanged = compact_history(&request.messages, usize::MAX, "");
        assert_eq!(unchanged.messages, request.messages);
        assert_eq!(unchanged.dropped_messages, 0);
        let _ = send(&client, &request).await;
        let compacted = compact_history(&request.messages, keep_recent, summary);
        assert_eq!(
            compacted.dropped_messages,
            if summary.is_empty() { 2 } else { 1 }
        );
        request.system = Some(json!(compacted.system_context("Stable instructions")));
        request.messages = compacted.messages;
        request.messages.push(Message::text(Role::User, "Continue"));
        assert_eq!(
            send(&client, &request).await.content.last(),
            Some(&ContentBlock::text("continued"))
        );
        let log = requests.lock().unwrap();
        let messages = log[3]["messages"].as_array().unwrap();
        assert!(
            messages
                .iter()
                .all(|message| !message["content"].as_array().unwrap().is_empty())
        );
        assert!(
            messages
                .iter()
                .any(|message| message["content"] == json!([tool_round("public-effect")[2]]))
        );
        assert!(
            messages
                .iter()
                .any(|message| message["content"][0]["tool_use_id"] == "public-effect")
        );
        server.abort();
    }
}

#[tokio::test]
async fn thinking_only_exhaustion_can_be_compacted_again_after_a_failed_continuation() {
    let (client, requests, server) = provider(|index| match index {
        1 => (reasoning("exhausted"), "model_context_window_exceeded", 10),
        2 | 4 => (
            vec![json!({"type":"text","text":"Preserve the task"})],
            "end_turn",
            10,
        ),
        3 => (
            vec![json!({"type":"text","text":"incomplete"})],
            "max_tokens",
            10,
        ),
        _ => (answer("completed"), "end_turn", 10),
    })
    .await;
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .adaptive_thinking()
        .keep_thinking()
        .build()
        .unwrap();
    let error = agent
        .prompt("Continue the task")
        .await
        .unwrap()
        .result()
        .await
        .unwrap_err();
    assert!(error.to_string().contains("MaxTokens"), "{error}");
    agent.compact().await.unwrap();
    assert_eq!(
        agent
            .prompt("Continue")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "completed"
    );
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 5);
    assert!(
        log[2]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|message| message["role"] == "user")
    );
    assert!(
        log[3]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|message| message["role"] == "user")
    );
    server.abort();
}
