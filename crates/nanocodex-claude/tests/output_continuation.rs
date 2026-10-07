//! Output exhaustion through real streaming HTTP, including client effect fences.
use axum::{Json, Router, response::IntoResponse, routing::post};
use nanocodex_agent::Nanocodex;
use nanocodex_claude::{Claude, ClaudeClient, ToolDefinition};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn response(blocks: Vec<Value>, stop: &str) -> String {
    let mut events = vec![
        json!({"type":"message_start","message":{"id":"response","role":"assistant","model":"test","content":[],"usage":{"input_tokens":157334,"output_tokens":0}}}),
    ];
    for (index, block) in blocks.into_iter().enumerate() {
        events.push(json!({"type":"content_block_start","index":index,"content_block":block}));
        events.push(json!({"type":"content_block_stop","index":index}));
    }
    events.push(
        json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":4096}}),
    );
    events.push(json!({"type":"message_stop"}));
    events
        .into_iter()
        .map(|e| format!("data: {e}\n\n"))
        .collect()
}
async fn fixture(
    responses: Vec<String>,
) -> (
    ClaudeClient,
    Arc<Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let log = Arc::new(Mutex::new(Vec::new()));
    let received = log.clone();
    let app = Router::new().route(
        "/v1/messages",
        post(move |Json(body): Json<Value>| {
            let log = received.clone();
            let responses = responses.clone();
            async move {
                let index = {
                    let mut log = log.lock().unwrap();
                    log.push(body.clone());
                    log.len() - 1
                };
                if std::env::var_os("NANOCLAUDE_OUTPUT_TRACE").is_some() {
                    eprintln!("{}", json!({"request_index":index,"request":body}));
                }
                (
                    [("content-type", "text/event-stream")],
                    responses
                        .get(index)
                        .expect("unexpected provider request")
                        .clone(),
                )
                    .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        ClaudeClient::new(
            reqwest::Client::new(),
            format!("http://{address}/v1/messages"),
            "synthetic",
        ),
        log,
        server,
    )
}
fn cut_tool(closed: bool, stop: &str) -> String {
    let mut s = response(
        vec![
            json!({"type":"thinking","thinking":"signed partial reasoning","signature":"opaque-signature"}),
            json!({"type":"text","text":"partial answer"}),
        ],
        stop,
    );
    let tail = s.find("data: {\"delta\"").unwrap();
    let mut tool = format!(
        "data: {}\n\ndata: {}\n\n",
        json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"incomplete","name":"effect","input":{}}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"value\":"}})
    );
    if closed {
        tool += &format!(
            "data: {}\n\n",
            json!({"type":"content_block_stop","index":2})
        );
    }
    s.insert_str(tail, &tool);
    s
}

#[tokio::test]
async fn partial_tool_never_executes_and_signed_content_continues() {
    for (closed, valid_input) in [(false, false), (true, false), (false, true)] {
        let complete =
            json!({"type":"tool_use","id":"complete","name":"effect","input":{"value":1}});
        let (client, log, server) = fixture(vec![
            if valid_input {
                cut_tool(closed, "max_tokens").replace(
                    &json!({"type":"input_json_delta","partial_json":"{\"value\":"}).to_string(),
                    &json!({"type":"input_json_delta","partial_json":"{\"value\":1}"}).to_string(),
                )
            } else {
                cut_tool(closed, "max_tokens")
            },
            response(vec![complete.clone()], "max_tokens"),
            response(vec![json!({"type":"text","text":"done"})], "end_turn"),
        ])
        .await;
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
            .tool(
                ToolDefinition {
                    name: "effect".into(),
                    description: "Synthetic effect".into(),
                    input_schema: json!({"type":"object"}),
                    strict: None,
                    defer_loading: false,
                },
                move |input| {
                    counter.fetch_add(1, Ordering::SeqCst);
                    async move {
                        assert_eq!(input, json!({"value":1}));
                        Ok("receipt committed".to_string())
                    }
                },
            )
            .build()
            .unwrap();
        assert_eq!(
            agent
                .prompt("finish task")
                .await
                .unwrap()
                .result()
                .await
                .unwrap()
                .final_message(),
            "done"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let r = log.lock().unwrap();
        assert_eq!(r.len(), 3);
        let history = r[1]["messages"].to_string();
        assert!(history.contains("opaque-signature"));
        assert!(history.contains("partial answer"));
        assert!(history.contains("was not executed"));
        assert!(!history.contains("\"id\":\"incomplete\""));
        let history = r[2]["messages"].to_string();
        assert!(history.contains("receipt committed"));
        assert!(
            r[2]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["role"] == "assistant" && m["content"] == json!([complete]))
        );
        server.abort();
    }
}
#[tokio::test]
async fn repeated_exhaustion_is_bounded_and_last_partial_is_retained() {
    let responses = (0..4)
        .map(|i| {
            response(
                vec![json!({"type":"text","text":format!("partial-{i}")})],
                "max_tokens",
            )
        })
        .chain([response(
            vec![json!({"type":"text","text":"resumed"})],
            "end_turn",
        )])
        .collect();
    let (client, log, server) = fixture(responses).await;
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .build()
        .unwrap();
    let error = agent
        .prompt("finish task")
        .await
        .unwrap()
        .result()
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("after 3 continuations"), "{error}");
    assert_eq!(log.lock().unwrap().len(), 4);
    agent
        .prompt("resume retained task")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    let r = log.lock().unwrap();
    assert_eq!(r.len(), 5);
    for i in 0..4 {
        assert!(
            r[4]["messages"]
                .to_string()
                .contains(&format!("partial-{i}"))
        );
    }
    server.abort();
}
#[tokio::test]
async fn malformed_terminal_without_token_cutoff_is_still_rejected() {
    let (client, log, server) = fixture(vec![cut_tool(false, "end_turn")]).await;
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .build()
        .unwrap();
    let error = agent
        .prompt("finish task")
        .await
        .unwrap()
        .result()
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("message_stop before content_block_stop"),
        "{error}"
    );
    assert_eq!(log.lock().unwrap().len(), 1);
    server.abort();
}

#[tokio::test]
async fn automatic_compaction_retains_signed_cutoff_and_continuation_instruction() {
    let (client, log, server) = fixture(vec![
        cut_tool(false, "max_tokens"),
        response(
            vec![json!({"type":"text","text":"Retain the original task."})],
            "end_turn",
        ),
        response(
            vec![json!({"type":"text","text":"done after compaction"})],
            "end_turn",
        ),
    ])
    .await;
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .auto_compact_window_tokens(100_000)
        .build()
        .unwrap();
    assert_eq!(
        agent
            .prompt("finish task")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "done after compaction"
    );
    let requests = log.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1]["tool_choice"]["type"], "none");
    let continuation = requests[2]["messages"].as_array().unwrap();
    assert!(
        continuation
            .iter()
            .any(|m| m["role"] == "assistant"
                && m["content"].to_string().contains("opaque-signature"))
    );
    assert_eq!(continuation.last().unwrap()["role"], "user");
    assert!(
        continuation.last().unwrap()["content"]
            .to_string()
            .contains("Continue the current task")
    );
    assert!(
        requests[2]["messages"]
            .to_string()
            .contains("Retain the original task.")
    );
    server.abort();
}
