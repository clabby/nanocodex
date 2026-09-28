//! The Anthropic-executed tools are not client callbacks and never get user tool_result blocks.
use axum::{Json, Router, response::IntoResponse, routing::post};
use nanocodex_agent::Nanocodex;
use nanocodex_claude::{Claude, ClaudeClient, ServerToolDefinition};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn stream(blocks: Vec<Value>, stop: &str) -> String {
    let mut data = String::new();
    let mut emit = |event: Value| data.push_str(&format!("data: {event}\n\n"));
    emit(
        json!({"type":"message_start","message":{"id":"msg","role":"assistant","model":"test","content":[],"usage":{"input_tokens":8,"output_tokens":0}}}),
    );
    for (index, block) in blocks.into_iter().enumerate() {
        emit(json!({"type":"content_block_start","index":index,"content_block":block}));
        emit(json!({"type":"content_block_stop","index":index}));
    }
    emit(json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":5}}));
    emit(json!({"type":"message_stop"}));
    data
}

#[tokio::test]
async fn server_web_search_results_and_citations_replay_without_client_result() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let received = requests.clone();
    let app = Router::new().route("/v1/messages",post(move |Json(body): Json<Value>| {
        let received = received.clone();
        async move {
            let index = { let mut reqs = received.lock().unwrap(); reqs.push(body); reqs.len() };
            let blocks = if index == 1 {
                vec![
                    json!({"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"example"}}),
                    json!({"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","url":"https://example.org","title":"Example","encrypted_content":"opaque"}]}),
                    json!({"type":"text","text":"An answer","citations":[{"type":"web_search_result_location","url":"https://example.org","encrypted_index":"opaque-index"}]}),
                ]
            } else { vec![json!({"type":"text","text":"next"})] };
            ([ ("content-type","text/event-stream") ], stream(blocks,"end_turn")).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{address}/v1/messages"),
        "synthetic",
    );
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .server_tool(ServerToolDefinition::web_search_basic(2))
        .build()
        .unwrap();
    assert_eq!(
        agent
            .prompt("search")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "An answer"
    );
    agent
        .prompt("followup")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    let reqs = requests.lock().unwrap();
    assert_eq!(
        reqs[0]["tools"][0],
        json!({"type":"web_search_20250305","name":"web_search","max_uses":2})
    );
    assert_eq!(
        reqs[1]["messages"][1]["content"][1]["content"][0]["encrypted_content"],
        "opaque"
    );
    assert_eq!(
        reqs[1]["messages"][1]["content"][2]["citations"][0]["encrypted_index"],
        "opaque-index"
    );
    assert_eq!(reqs[1]["messages"][2]["content"][0]["text"], "followup");
}

#[tokio::test]
async fn pause_turn_resends_server_tools_and_assistant_blocks_without_user_result() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let received = requests.clone();
    let app = Router::new().route("/v1/messages",post(move |Json(body): Json<Value>| {
        let received = received.clone();
        async move {
            let index = { let mut reqs = received.lock().unwrap(); reqs.push(body); reqs.len() };
            let (blocks,stop) = if index == 1 {
                (vec![json!({"type":"server_tool_use","id":"srvtoolu_1","name":"web_fetch","input":{"url":"https://example.org"}})],"pause_turn")
            } else { (vec![json!({"type":"text","text":"fetched"})],"end_turn") };
            ([ ("content-type","text/event-stream") ], stream(blocks,stop)).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{address}/v1/messages"),
        "synthetic",
    );
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .server_tool(ServerToolDefinition::web_fetch_basic(1))
        .build()
        .unwrap();
    assert_eq!(
        agent
            .prompt("fetch")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "fetched"
    );
    let reqs = requests.lock().unwrap();
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[1]["tools"], reqs[0]["tools"]);
    assert_eq!(reqs[1]["messages"].as_array().unwrap().len(), 2);
    assert_eq!(reqs[1]["messages"][1]["content"][0]["id"], "srvtoolu_1");
}
