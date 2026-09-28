#![cfg(feature = "workspace-files")]

use axum::{Json, Router, routing::post};
use nanocodex_agent::Nanocodex;
use nanocodex_claude::{Claude, ClaudeClient};
use nanocodex_tools::ClaudeWorkspaceFiles;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn sse(block: Value, stop: &str) -> String {
    let mut out = String::new();
    let mut emit = |v: Value| out.push_str(&format!("data: {v}\n\n"));
    emit(
        json!({"type":"message_start","message":{"id":"msg","role":"assistant","model":"test","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}),
    );
    emit(
        json!({"type":"content_block_start","index":0,"content_block":if block["type"]=="text" { json!({"type":"text","text":""}) } else {json!({"type":"tool_use","id":block["id"],"name":block["name"],"input":{}})}}),
    );
    emit(
        json!({"type":"content_block_delta","index":0,"delta":if block["type"]=="text" { json!({"type":"text_delta","text":block["text"]}) } else { json!({"type":"input_json_delta","partial_json":block["input"].to_string()}) }}),
    );
    emit(json!({"type":"content_block_stop","index":0}));
    emit(json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":4}}));
    emit(json!({"type":"message_stop"}));
    out
}

#[tokio::test]
async fn explicitly_opted_in_claude_tools_never_expose_codex_catalog() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let files = Arc::new(ClaudeWorkspaceFiles::new(dir.path()).unwrap());
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let log = requests.clone();
    let app = Router::new().route("/v1/messages",post(move |Json(body):Json<Value>| {
        let log=log.clone();
        async move {
            let index={let mut l=log.lock().unwrap(); l.push(body); l.len()};
            let (block,reason)=match index {
                1 => (json!({"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"sample.txt","content":"hello Claude\n"}}),"tool_use"),
                2 => (json!({"type":"tool_use","id":"r1","name":"Read","input":{"file_path":"sample.txt"}}),"tool_use"),
                _ => (json!({"type":"text","text":"finished"}),"end_turn"),
            };
            ([("content-type", "text/event-stream")], sse(block,reason))
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
        .workspace_files(files)
        .build()
        .unwrap();
    assert_eq!(
        agent
            .prompt("create and read a file")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "finished"
    );
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 3);
    let names: Vec<_> = log[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Read", "Edit", "Write", "Glob", "Grep"]);
    assert_eq!(
        log[1]["messages"][2]["content"][0]["content"],
        "Wrote sample.txt"
    );
    assert_eq!(
        log[2]["messages"][4]["content"][0]["content"],
        "1\thello Claude\n"
    );
    server.abort();
}

#[tokio::test]
async fn completed_file_write_survives_followup_transport_error_in_session() {
    use axum::{http::StatusCode, response::IntoResponse};
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let files = Arc::new(ClaudeWorkspaceFiles::new(dir.path()).unwrap());
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let log = requests.clone();
    let app = Router::new().route("/v1/messages", post(move |Json(body):Json<Value>| {
        let log=log.clone();
        async move {
            let index={let mut l=log.lock().unwrap();l.push(body);l.len()};
            match index {
                1 => ([ ("content-type","text/event-stream") ],sse(json!({"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"effect.txt","content":"written once"}}),"tool_use")).into_response(),
                2 => (StatusCode::BAD_GATEWAY,"synthetic follow-up failure").into_response(),
                _ => ([ ("content-type","text/event-stream") ],sse(json!({"type":"text","text":"resumed"}),"end_turn")).into_response(),
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
        .workspace_files(files)
        .build()
        .unwrap();
    assert!(agent.prompt("write").await.unwrap().result().await.is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("effect.txt")).unwrap(),
        "written once"
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
        "resumed"
    );
    let r = requests.lock().unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!(r[2]["messages"][1]["content"][0]["name"], "Write");
    assert_eq!(r[2]["messages"][2]["content"][0]["tool_use_id"], "w1");
    server.abort();
}
