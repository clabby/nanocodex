//! Reproducible mock HTTP journeys: run `cargo test -p nanocodex-claude --test messages`.
//! No network outside a loopback listener and no real provider credentials.
use std::sync::{Arc, Mutex};

use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::post};
use futures_util::StreamExt;
use nanocodex_claude::{
    ClaudeClient, ClaudeError, ContentBlock, Message, MessagesRequest, Role, StopReason,
    StreamEvent, ToolDefinition, collect_stream, compact_history,
};
use serde_json::{Value, json};

fn http_client() -> reqwest::Client {
    static PROVIDER: std::sync::Once = std::sync::Once::new();
    PROVIDER.call_once(|| {
        rustls::crypto::ring::default_provider()
            .install_default()
            .expect("crypto provider");
    });
    reqwest::Client::new()
}

async fn server(
    handler: impl Fn(Value) -> (StatusCode, &'static str, String) + Send + Sync + 'static,
) -> String {
    let handler = Arc::new(handler);
    let app = Router::new().route(
        "/v1/messages",
        post(move |Json(body): Json<Value>| {
            let handler = handler.clone();
            async move {
                let (status, media_type, response) = handler(body);
                (status, [("content-type", media_type)], response).into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}/v1/messages")
}

fn request() -> MessagesRequest {
    MessagesRequest {
        model: "claude-test".into(),
        max_tokens: 128,
        system: Some("Use tools".into()),
        messages: vec![Message::text(Role::User, "What's the weather?")],
        tools: vec![ToolDefinition {
            name: "weather".into(),
            description: "Find current weather".into(),
            input_schema: json!({"type":"object","properties":{"city":{"type":"string"}}}),
        }],
    }
}

#[tokio::test]
async fn streams_a_tool_call_then_continues_with_matching_result() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let endpoint = server(move |body| {
        captured.lock().unwrap().push(body.clone());
        if body["stream"] == true {
            let frames = [
                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-test\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\n",
                ": heartbeat\n\n",
                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Checking \"}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"now\"}}\n\n",
                "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"weather\",\"input\":{}}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\\\"Athens\\\"}\"}}\n\n",
                "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":12}}\n\n",
                "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
            ];
            (StatusCode::OK, "text/event-stream", frames.concat())
        } else {
            (StatusCode::OK, "application/json", json!({"id":"msg_2","type":"message","role":"assistant","model":"claude-test","content":[{"type":"text","text":"Sunny"}],"stop_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":2}}).to_string())
        }
    }).await;
    let client = ClaudeClient::new(http_client(), endpoint, "synthetic-key");
    let mut initial = request();
    let mut stream = client.stream(&initial).await.unwrap();
    let first = stream.next().await.unwrap().unwrap();
    assert!(matches!(first, StreamEvent::MessageStart { .. }));
    let streamed = collect_stream(first, stream).await.unwrap();
    assert_eq!(streamed.id, "msg_1");
    assert_eq!(streamed.stop_reason, Some(StopReason::ToolUse));
    assert_eq!(streamed.usage.output_tokens, 12);
    assert_eq!(streamed.content[0], ContentBlock::text("Checking now"));
    assert_eq!(
        streamed.content[1],
        ContentBlock::tool_use("toolu_1", "weather", json!({"city":"Athens"}))
    );

    initial.messages.push(Message {
        role: Role::Assistant,
        content: streamed.content,
    });
    initial
        .messages
        .push(Message::tool_results(vec![ContentBlock::tool_result(
            "toolu_1", "Sunny", false,
        )]));
    let final_message = client.create(&initial).await.unwrap();
    assert_eq!(final_message.content, vec![ContentBlock::text("Sunny")]);
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 2);
    assert_eq!(
        captured[0]["tools"][0]["input_schema"]["properties"]["city"]["type"],
        "string"
    );
    assert_eq!(captured[1]["messages"][1]["content"][1]["type"], "tool_use");
    assert_eq!(captured[1]["messages"][2]["role"], "user");
    assert_eq!(
        captured[1]["messages"][2]["content"][0]["tool_use_id"],
        "toolu_1"
    );
    assert_eq!(captured[1]["stream"], false);
}

#[tokio::test]
async fn surfaces_http_and_truncated_stream_failures() {
    let endpoint = server(|body| {
        if body["stream"] == true {
            (StatusCode::OK, "text/event-stream", "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"role\":\"assistant\",\"model\":\"x\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n".into())
        } else {
            (StatusCode::UNAUTHORIZED, "application/json", json!({"type":"error","error":{"type":"authentication_error","message":"invalid key"}}).to_string())
        }
    }).await;
    let client = ClaudeClient::new(http_client(), endpoint, "synthetic-key");
    assert!(matches!(
        client.create(&request()).await,
        Err(ClaudeError::Http { status: 401, .. })
    ));
    let mut stream = client.stream(&request()).await.unwrap();
    assert!(matches!(
        stream.next().await.unwrap(),
        Ok(StreamEvent::MessageStart { .. })
    ));
    assert!(matches!(
        stream.next().await.unwrap(),
        Err(ClaudeError::IncompleteStream)
    ));
}

#[test]
fn compaction_retains_tool_use_with_result_at_boundary() {
    let history = vec![
        Message::text(Role::User, "old"),
        Message::text(Role::Assistant, "old response"),
        Message::text(Role::User, "find weather"),
        Message {
            role: Role::Assistant,
            content: vec![ContentBlock::tool_use(
                "toolu_1",
                "weather",
                json!({"city":"Athens"}),
            )],
        },
        Message::tool_results(vec![ContentBlock::tool_result("toolu_1", "Sunny", false)]),
        Message::text(Role::Assistant, "Sunny"),
    ];
    let compacted = compact_history(&history, 2, "Earlier query resolved.");
    assert_eq!(compacted.dropped_messages, 2);
    assert_eq!(compacted.messages, history[2..]);
    assert_eq!(compacted.summary, "Earlier query resolved.");
    assert!(
        compacted
            .system_context("Use tools")
            .contains("Earlier query resolved.")
    );
}

#[tokio::test]
async fn reports_in_band_error_and_rejects_malformed_tool_json() {
    let endpoint = server(|body| {
        if body["model"] == "error" {
            (StatusCode::OK, "text/event-stream", "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"try later\"}}\n\n".into())
        } else {
            (StatusCode::OK, "text/event-stream", concat!(
                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"role\":\"assistant\",\"model\":\"x\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu\",\"name\":\"foo\",\"input\":{}}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{broken\"}}\n\n",
                "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
            ).into())
        }
    }).await;
    let client = ClaudeClient::new(http_client(), endpoint, "synthetic-key");
    let mut req = request();
    req.model = "error".into();
    let mut events = client.stream(&req).await.unwrap();
    assert!(matches!(
        events.next().await.unwrap(),
        Err(ClaudeError::StreamError { .. })
    ));
    assert!(events.next().await.is_none());
    req.model = "malformed".into();
    let mut events = client.stream(&req).await.unwrap();
    let first = events.next().await.unwrap().unwrap();
    assert!(collect_stream(first, events).await.is_err());
}

#[tokio::test]
async fn sets_console_api_headers_without_exposing_key_in_request_body() {
    use axum::http::HeaderMap;
    let app = Router::new().route("/v1/messages", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
        assert_eq!(headers.get("x-api-key").unwrap(), "synthetic-key");
        assert_eq!(headers.get("anthropic-version").unwrap(), "2023-06-01");
        assert!(body.get("api_key").is_none());
        Json(json!({"id":"msg","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        http_client(),
        format!("http://{address}/v1/messages"),
        "synthetic-key",
    );
    assert_eq!(client.create(&request()).await.unwrap().id, "msg");
}

#[tokio::test]
async fn accepts_caller_supplied_auth_headers_without_forcing_api_key() {
    use axum::http::HeaderMap;
    let app = Router::new().route(
        "/v1/messages",
        post(|headers: HeaderMap| async move {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer synthetic-token");
            assert!(headers.get("x-api-key").is_none());
            Json(json!({"id":"msg","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::AUTHORIZATION,
        "Bearer synthetic-token".parse().unwrap(),
    );
    let client = ClaudeClient::with_auth_headers(
        http_client(),
        format!("http://{address}/v1/messages"),
        headers,
    );
    assert_eq!(client.create(&request()).await.unwrap().id, "msg");
}

#[tokio::test]
async fn preserves_signed_thinking_and_cache_usage_across_stream_and_replay() {
    let endpoint = server(|_| {
        (StatusCode::OK, "text/event-stream", [
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_t\",\"role\":\"assistant\",\"model\":\"test\",\"content\":[],\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":5,\"cache_creation_input_tokens\":3,\"output_tokens\":0}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"check\",\"signature\":\"\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\" result\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"signed-payload\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"opaque-data\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        ].concat())
    }).await;
    let client = ClaudeClient::new(http_client(), endpoint, "synthetic-key");
    let mut events = client.stream(&request()).await.unwrap();
    let first = events.next().await.unwrap().unwrap();
    let completed = collect_stream(first, events).await.unwrap();
    assert_eq!(completed.usage.cache_read_input_tokens, 5);
    assert_eq!(completed.usage.cache_creation_input_tokens, 3);
    assert_eq!(completed.usage.output_tokens, 4);
    assert_eq!(
        serde_json::to_value(&completed.content).unwrap(),
        json!([
            {"type":"thinking","thinking":"check result","signature":"signed-payload"},
            {"type":"redacted_thinking","data":"opaque-data"}
        ])
    );
    let replay = Message {
        role: Role::Assistant,
        content: completed.content,
    };
    assert_eq!(
        serde_json::to_value(replay).unwrap()["content"][0]["signature"],
        "signed-payload"
    );
}
