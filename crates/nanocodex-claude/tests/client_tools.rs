//! Claude Code-style client discovery and its independent server-backed web call.
use axum::{Json, Router, response::IntoResponse, routing::post};
use nanocodex_agent::Nanocodex;
use nanocodex_claude::{Claude, ClaudeClient};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn stream(blocks: Vec<Value>, stop: &str) -> String {
    let mut out = String::new();
    let mut emit = |event: Value| out.push_str(&format!("data: {event}\n\n"));
    emit(
        json!({"type":"message_start","message":{"id":"msg","role":"assistant","model":"test","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}),
    );
    for (index, block) in blocks.into_iter().enumerate() {
        if block["type"] == "tool_use" {
            emit(
                json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":block["id"],"name":block["name"],"input":{}}}),
            );
            emit(
                json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":block["input"].to_string()}}),
            );
        } else {
            emit(json!({"type":"content_block_start","index":index,"content_block":block}));
        }
        emit(json!({"type":"content_block_stop","index":index}));
    }
    emit(json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":5}}));
    emit(json!({"type":"message_stop"}));
    out
}

#[tokio::test]
async fn client_tool_search_then_nested_web_search_then_compaction() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let log = requests.clone();
    let app = Router::new().route("/v1/messages", post(move |Json(body): Json<Value>| {
        let log = log.clone();
        async move {
            let index = { let mut r = log.lock().unwrap(); r.push(body); r.len() };
            let (blocks, stop) = match index {
                1 => (vec![json!({"type":"tool_use","id":"find","name":"ToolSearch","input":{"query":"select:WebSearch","max_results":1}})],"tool_use"),
                2 => (vec![json!({"type":"tool_use","id":"search","name":"WebSearch","input":{"query":"latest example","allowed_domains":["example.org"]}})],"tool_use"),
                3 => (vec![
                    json!({"type":"server_tool_use","id":"srv","name":"web_search","input":{"query":"latest example"}}),
                    json!({"type":"web_search_tool_result","tool_use_id":"srv","content":[{"type":"web_search_result","url":"https://example.org/a","title":"Example source","encrypted_content":"opaque"}]}),
                    json!({"type":"text","text":"An answer.","citations":[{"type":"web_search_result_location","url":"https://example.org/a","encrypted_index":"opaque"}]}),
                ],"end_turn"),
                4 => (vec![json!({"type":"text","text":"Done"})],"end_turn"),
                5 => (vec![json!({"type":"text","text":"Summary of research"})],"end_turn"),
                _ => (vec![json!({"type":"text","text":"Again"})],"end_turn"),
            };
            ([ ("content-type","text/event-stream") ], stream(blocks,stop)).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{address}/v1/messages"),
        "synthetic",
    );
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .client_tool_search()
        .message_diagnostics()
        .nested_web_search(true)
        .build()
        .unwrap();
    assert_eq!(
        agent
            .prompt("Research example")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "Done"
    );
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
        "Again"
    );
    let r = requests.lock().unwrap();
    assert_eq!(r.len(), 6);
    assert_eq!(r[0]["diagnostics"], json!({"previous_message_id":null}));
    assert_eq!(r[1]["diagnostics"], json!({"previous_message_id":"msg"}));
    assert_eq!(
        r[2].get("diagnostics"),
        None,
        "nested search is an independent request"
    );
    assert_eq!(r[5]["diagnostics"], json!({"previous_message_id":"msg"}));
    assert_eq!(r[0]["tools"].as_array().unwrap().len(), 2);
    assert_eq!(r[0]["tools"][0]["name"], "ToolSearch");
    assert!(
        r[1]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "WebSearch")
    );
    assert!(
        r[1]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t.get("defer_loading").is_none())
    );
    assert_eq!(
        r[1]["messages"][2]["content"][0]["content"][0],
        json!({"type":"tool_reference","tool_name":"WebSearch"})
    );
    assert_eq!(
        r[1]["messages"][2]["content"][0]["content"][1]["type"],
        "text"
    );
    assert!(
        r[1]["messages"][2]["content"][0]["content"][1]["text"]
            .as_str()
            .unwrap()
            .contains("WebSearch")
    );
    assert_eq!(
        r[2]["tools"],
        json!([{"type":"web_search_20250305","name":"web_search","max_uses":3,"allowed_domains":["example.org"]}])
    );
    assert_eq!(r[2]["tool_choice"], json!({"type":"auto"}));
    assert_eq!(r[2]["messages"].as_array().unwrap().len(), 1);
    assert_eq!(r[2]["messages"][0]["content"][0]["text"], "latest example");
    let result = r[3]["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(result["content"][0]["tool_use_id"], "search");
    assert!(
        result["content"][0]["content"]
            .as_str()
            .unwrap()
            .contains("https://example.org/a")
    );
    assert!(
        r[4]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "WebSearch")
    );
    assert!(
        r[5]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "WebSearch")
    );
    assert!(
        r[5]["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Summary of research")
    );
    server.abort();
}

#[tokio::test]
async fn optional_context_profile_and_invalid_web_filters_are_bounded() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let received = Arc::new(Mutex::new(Vec::<(Value, Option<String>)>::new()));
    let log = received.clone();
    let app=Router::new().route("/v1/messages",post(move |headers:axum::http::HeaderMap,Json(body):Json<Value>| {
        let log=log.clone();
        async move {
            let index={let mut r=log.lock().unwrap();r.push((body,headers.get("anthropic-beta").and_then(|v|v.to_str().ok()).map(str::to_owned)));r.len()};
            let (blocks,stop)=match index {
                1=>(vec![json!({"type":"tool_use","id":"search","name":"WebSearch","input":{"query":"demo","allowed_domains":["example.org"],"blocked_domains":["else.org"]}})],"tool_use"),
                _=>(vec![json!({"type":"text","text":"Handled"})],"end_turn")
            };
            ([ ("content-type","text/event-stream") ],stream(blocks,stop)).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{addr}/v1/messages"),
        "synthetic",
    );
    let (agent,_)=Nanocodex::builder(Claude::new(client,"test"))
        .nested_web_search(false).adaptive_thinking().keep_thinking().cache_one_hour()
        .system_blocks(vec![json!({"type":"text","text":"Authorized system","cache_control":{"type":"ephemeral","ttl":"1h"}})])
        .build().unwrap();
    assert_eq!(
        agent
            .prompt("query")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "Handled"
    );
    let r = received.lock().unwrap();
    assert_eq!(
        r.len(),
        2,
        "invalid filters must not make a nested provider call"
    );
    assert_eq!(r[0].0["thinking"], json!({"type":"adaptive"}));
    assert_eq!(
        r[0].0["context_management"],
        json!({"edits":[{"type":"clear_thinking_20251015","keep":"all"}]})
    );
    assert_eq!(r[0].0["cache_control"]["ttl"], "1h");
    assert_eq!(r[0].0["system"][0]["text"], "Authorized system");
    assert_eq!(r[0].1.as_deref(), Some("context-management-2025-06-27"));
    assert_eq!(r[1].0["messages"][2]["content"][0]["is_error"], true);
    server.abort();
}

#[tokio::test]
async fn failed_nested_search_yields_one_error_result_without_retrying_it() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = seen.clone();
    let app=Router::new().route("/v1/messages",post(move |Json(body):Json<Value>| {
        let captured=captured.clone();
        async move {
            let index={let mut r=captured.lock().unwrap();r.push(body);r.len()};
            match index {
                1=>([("content-type","text/event-stream")],stream(vec![json!({"type":"tool_use","id":"failed","name":"WebSearch","input":{"query":"test failure"}})],"tool_use")).into_response(),
                2=>(axum::http::StatusCode::BAD_GATEWAY,"Synthetic upstream failure".to_owned()).into_response(),
                _=>([("content-type","text/event-stream")],stream(vec![json!({"type":"text","text":"Reported failure"})],"end_turn")).into_response(),
            }
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{addr}/v1/messages"),
        "synthetic",
    );
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .nested_web_search(false)
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
        "Reported failure"
    );
    let r = seen.lock().unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!(r[2]["messages"][2]["content"][0]["is_error"], true);
    assert_eq!(
        r[2]["messages"][2]["content"][0]["content"],
        "nested search request failed"
    );
    server.abort();
}

#[cfg(feature = "workspace-files")]
#[tokio::test]
async fn web_fetch_uses_approved_page_then_auxiliary_haiku_not_server_fetch() {
    use nanocodex_tools::claude_web::{ApprovedPage, ApprovedWebFetchSource, WebFetchRequest};
    struct FixtureSource(Arc<Mutex<Vec<WebFetchRequest>>>);
    impl ApprovedWebFetchSource for FixtureSource {
        async fn fetch_source(&self, request: WebFetchRequest) -> Result<ApprovedPage, String> {
            self.0.lock().unwrap().push(request);
            Ok(ApprovedPage {
                final_url: "https://example.org/final".into(),
                content: "<h1>Fixture title</h1>".into(),
            })
        }
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let log = requests.clone();
    let app=Router::new().route("/v1/messages",post(move |Json(body):Json<Value>| {
        let log=log.clone();
        async move {
            let index={let mut r=log.lock().unwrap();r.push(body);r.len()};
            let (blocks,stop)=match index {
                1=>(vec![json!({"type":"tool_use","id":"fetch","name":"WebFetch","input":{"url":"https://example.org/start","prompt":"What is its title?"}})],"tool_use"),
                2=>(vec![json!({"type":"text","text":"Fixture title"})],"end_turn"),
                _=>(vec![json!({"type":"text","text":"Fetched"})],"end_turn"),
            };
            ([ ("content-type","text/event-stream") ],stream(blocks,stop)).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{addr}/v1/messages"),
        "synthetic",
    );
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .web_fetch_with_source(Arc::new(FixtureSource(calls.clone())), false)
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
        "Fetched"
    );
    let call = calls.lock().unwrap();
    assert_eq!(call.len(), 1);
    assert_eq!(call[0].max_output_bytes, 128 * 1024);
    let r = requests.lock().unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!(r[0]["tools"][0]["name"], "WebFetch");
    assert!(
        r[0]["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("fetch")
    );
    assert_eq!(r[1]["model"], "claude-haiku-4-5-20251001");
    assert_eq!(r[1]["thinking"], json!({"type":"disabled"}));
    assert!(r[1].get("tools").is_none());
    assert!(
        r[1]["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Fixture title")
    );
    assert!(
        r[2]["messages"][2]["content"][0]["content"]
            .as_str()
            .unwrap()
            .contains("https://example.org/final")
    );
    assert!(
        r[2]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["name"] != "web_fetch")
    );
    server.abort();
}
