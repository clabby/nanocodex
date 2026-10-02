//! Protocol failures are exercised through the HTTP boundary; provider cache hits
//! and billing cannot be established by these synthetic loopback journeys.
use axum::{Json, Router, http::HeaderMap, routing::post};
use nanocodex_agent::Nanocodex;
use nanocodex_claude::{
    CacheControl, Claude, ClaudeClient, ClaudeError, ContentBlock, Message, MessagesRequest, Role,
    ServerToolDefinition,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn request() -> MessagesRequest {
    MessagesRequest {
        model: "test".into(),
        max_tokens: 128,
        cache_control: Some(CacheControl::ephemeral()),
        output_config: None,
        speed: None,
        tool_choice: None,
        thinking: None,
        context_management: None,
        diagnostics: None,
        system: None,
        container: None,
        tools: vec![],
        messages: vec![Message::text(Role::User, "hello")],
    }
}

fn marked(ttl: &str) -> Value {
    json!({"type":"text","text":"stable instructions","cache_control":{"type":"ephemeral","ttl":ttl}})
}

fn block(value: Value) -> ContentBlock {
    serde_json::from_value(value).unwrap()
}

async fn fixture() -> (
    ClaudeClient,
    Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    tokio::task::JoinHandle<()>,
) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let log = Arc::new(Mutex::new(vec![]));
    let captured = log.clone();
    let app = Router::new().route("/v1/messages", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        captured.lock().unwrap().push((headers, body));
        async { Json(json!({"id":"synthetic","role":"assistant","model":"test","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn","usage":{}})) }
    }));
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

// Failure modes: malformed raw controls, >4 total markers, short-before-long
// TTLs, automatic/explicit conflicts, and forbidden signed/empty targets.
#[tokio::test]
async fn invalid_cache_controls_fail_before_http_without_mutating_history() {
    let (client, log, server) = fixture().await;
    let mut invalid = vec![];
    let mut r = request();
    r.system = Some(json!([marked("5m"), marked("1h")]));
    invalid.push(("TTL order", r));
    let mut r = request();
    r.system = Some(json!([
        marked("5m"),
        marked("5m"),
        marked("5m"),
        marked("5m")
    ]));
    invalid.push(("automatic fifth breakpoint", r));
    let mut r = request();
    r.cache_control = None;
    r.system = Some(json!(vec![marked("5m"); 5]));
    invalid.push(("explicit fifth breakpoint", r));
    let mut r = request();
    r.messages[0].content = vec![block(marked("1h"))];
    invalid.push(("last-block automatic TTL conflict", r));
    for value in [
        json!({"type":"text","text":"x","cache_control":{"type":"permanent"}}),
        json!({"type":"text","text":"x","cache_control":{"type":"ephemeral","ttl":"2h"}}),
        json!({"type":"text","text":"x","cache_control":null}),
        json!({"type":"text","text":"","cache_control":{"type":"ephemeral"}}),
        json!({"type":"thinking","thinking":"signed","signature":"opaque","cache_control":{"type":"ephemeral"}}),
        json!({"type":"redacted_thinking","data":"opaque","cache_control":{"type":"ephemeral"}}),
    ] {
        let mut r = request();
        r.messages[0].content = vec![block(value)];
        invalid.push(("malformed or forbidden block control", r));
    }
    let mut r = request();
    let mut tool = ServerToolDefinition::web_search_basic(1);
    tool.options.insert(
        "cache_control".into(),
        json!({"type":"ephemeral","ttl":"5m"}),
    );
    r.tools.push(tool.into());
    r.system = Some(json!([marked("1h")]));
    invalid.push(("tool before system TTL order", r));
    for (label, r) in invalid {
        let before = serde_json::to_value(&r).unwrap();
        let error = client.create(&r).await.expect_err(label);
        assert!(
            matches!(error, ClaudeError::Protocol(_)),
            "{label}: {error}"
        );
        assert_eq!(serde_json::to_value(&r).unwrap(), before, "{label}");
    }
    assert!(
        log.lock().unwrap().is_empty(),
        "invalid cache requests reached HTTP"
    );
    server.abort();
}

#[tokio::test]
async fn valid_mixed_ttls_and_automatic_fallback_preserve_signed_replay() {
    let (client, log, server) = fixture().await;
    let mut r = request();
    r.system = Some(json!([marked("1h"), marked("5m"), marked("5m")]));
    client.create(&r).await.unwrap(); // Three explicit plus automatic.
    let signed = json!({"type":"thinking","thinking":"exact bytes\n","signature":"opaque-signature","binding":"opaque"});
    r.messages = vec![Message {
        role: Role::Assistant,
        content: vec![
            block(marked("5m")),
            block(signed.clone()),
            block(json!({"type":"redacted_thinking","data":"opaque"})),
            ContentBlock::text(""),
        ],
    }];
    r.system = Some(json!([marked("1h"), marked("5m")]));
    let before = serde_json::to_value(&r).unwrap();
    client.create(&r).await.unwrap(); // Automatic falls back and deduplicates equal TTL.
    assert_eq!(serde_json::to_value(&r).unwrap(), before);
    let mut r = request();
    r.cache_control = None;
    r.system = Some(json!([
        marked("5m"),
        marked("5m"),
        marked("5m"),
        marked("5m")
    ]));
    // User data named cache_control is not a protocol marker.
    r.messages[0].content = vec![ContentBlock::tool_use(
        "t",
        "x",
        json!({"cache_control":{"type":"permanent"}}),
    )];
    client.create(&r).await.unwrap();
    let log = log.lock().unwrap();
    assert_eq!(log.len(), 3);
    assert_eq!(log[1].1["messages"][0]["content"][1], signed);
    assert!(
        log.iter()
            .all(|(headers, _)| !headers.contains_key("anthropic-beta"))
    );
    server.abort();
}

// Compaction replaces message history: a stable system marker must already have
// been written on the preceding requests, not invented only after compaction.
#[tokio::test]
async fn automatic_agent_cache_keeps_system_prefix_across_compaction() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let log = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = log.clone();
    let app = Router::new().route("/v1/messages", post(move |Json(body): Json<Value>| {
        captured.lock().unwrap().push(body);
        async { ([("content-type", "text/event-stream")], concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"role\":\"assistant\",\"model\":\"test\",\"content\":[],\"usage\":{}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Summary\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        )) }
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
        .cache_one_hour()
        .system("Stable system")
        .build()
        .unwrap();
    agent.prompt("first").await.unwrap().result().await.unwrap();
    agent.compact().await.unwrap();
    agent
        .prompt("continue")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    let log = log.lock().unwrap();
    assert_eq!(log.len(), 3);
    assert_eq!(
        log[0]["system"],
        json!([{"type":"text","text":"Stable system","cache_control":{"type":"ephemeral","ttl":"1h"}}])
    );
    assert_eq!(log[0]["system"], log[1]["system"]);
    assert_eq!(log[0]["system"], log[2]["system"]);
    assert_eq!(log[0]["tools"], log[2]["tools"]);
    assert_eq!(log[0]["cache_control"], log[2]["cache_control"]);
    assert_ne!(log[0]["messages"], log[2]["messages"]);
    server.abort();
}

#[tokio::test]
async fn stable_prefix_preparation_preserves_caller_policy_and_budget() {
    let (client, log, server) = fixture().await;
    let mut inputs = vec![];
    let mut r = request();
    r.system = Some(json!([{"type":"text","text":"system"}]));
    r.cache_control = None;
    inputs.push(r); // No opt-in: no new marker.
    let mut r = request();
    r.system = Some(json!([marked("1h"),{"type":"text","text":"changing suffix"}]));
    inputs.push(r); // Honor caller-selected stable prefix.
    let mut r = request();
    r.system = Some(json!([{"type":"text","text":"system"}]));
    r.messages[0].content = vec![
        block(marked("1h")),
        block(marked("5m")),
        block(marked("5m")),
        ContentBlock::text("tail"),
    ];
    inputs.push(r); // All four slots already allocated.
    let mut r = request();
    r.system = Some(json!([{"type":"text","text":"system"}]));
    r.messages[0].content = vec![block(marked("1h")), ContentBlock::text("tail")];
    inputs.push(r); // Adding the automatic 5m TTL before the 1h marker is illegal.
    for mut r in inputs {
        let before = serde_json::to_value(&r).unwrap();
        r.cache_system_prefix().unwrap();
        assert_eq!(serde_json::to_value(&r).unwrap(), before);
        client.create(&r).await.unwrap();
    }
    let mut r = request();
    r.system = Some(json!("system"));
    r.cache_system_prefix().unwrap();
    let before = serde_json::to_value(&r).unwrap();
    r.cache_system_prefix().unwrap();
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        before,
        "preparation must be idempotent"
    );
    client.create(&r).await.unwrap();
    assert_eq!(log.lock().unwrap().len(), 5);
    server.abort();
}

#[tokio::test]
async fn explicit_tool_result_breakpoint_survives_replay_and_is_validated() {
    let (client, log, server) = fixture().await;
    let result = json!({"type":"tool_result","tool_use_id":"lookup-1","content":[{"type":"text","text":"found"}],"cache_control":{"type":"ephemeral","ttl":"1h"}});
    let mut r = request();
    r.cache_control = None;
    r.messages[0].content = vec![block(result.clone())];
    client.create(&r).await.unwrap();
    assert_eq!(
        log.lock().unwrap()[0].1["messages"][0]["content"][0],
        result
    );
    r.cache_control = Some(CacheControl::ephemeral());
    assert!(matches!(
        client.create(&r).await,
        Err(ClaudeError::Protocol(_))
    ));
    assert_eq!(log.lock().unwrap().len(), 1);
    server.abort();
}
