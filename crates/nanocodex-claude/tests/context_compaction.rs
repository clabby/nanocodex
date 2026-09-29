//! Context recovery journeys through the public backend and loopback Messages API.
use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::post};
use nanocodex_agent::Nanocodex;
use nanocodex_claude::{Claude, ClaudeClient, ToolDefinition};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn sse(blocks: Vec<Value>, stop: &str, input: u64) -> String {
    let mut output = String::new();
    let mut emit = |value: Value| output.push_str(&format!("data: {value}\n\n"));
    emit(
        json!({"type":"message_start","message":{"id":"synthetic","role":"assistant","model":"test","content":[],"usage":{"input_tokens":input,"output_tokens":0}}}),
    );
    for (index, block) in blocks.into_iter().enumerate() {
        emit(json!({"type":"content_block_start","index":index,"content_block":block}));
        emit(json!({"type":"content_block_stop","index":index}));
    }
    emit(json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":5}}));
    emit(json!({"type":"message_stop"}));
    output
}

async fn server(
    respond: impl Fn(usize, &Value) -> (Vec<Value>, &'static str, u64) + Send + Sync + 'static,
    fail_at: Option<usize>,
) -> (
    ClaudeClient,
    Arc<Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    let respond = Arc::new(respond);
    let app = Router::new().route(
        "/v1/messages",
        post(move |Json(body): Json<Value>| {
            let log = log.clone();
            let respond = respond.clone();
            async move {
                let index = {
                    let mut log = log.lock().unwrap();
                    log.push(body.clone());
                    log.len()
                };
                if std::env::var_os("NANOCLAUDE_CONTEXT_TRACE").is_some() {
                    eprintln!(
                        "{}",
                        json!({
                            "scenario": std::thread::current().name(),
                            "request_index": index,
                            "synthetic_failure": Some(index) == fail_at,
                            "request": body,
                        })
                    );
                }
                if Some(index) == fail_at {
                    return (StatusCode::BAD_REQUEST, "synthetic failure").into_response();
                }
                let (blocks, stop, input) = respond(index, &body);
                (
                    [("content-type", "text/event-stream")],
                    sse(blocks, stop, input),
                )
                    .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{address}/v1/messages"),
        "synthetic",
    );
    (client, requests, task)
}

fn text(value: &str) -> Vec<Value> {
    vec![json!({"type":"text","text":value})]
}
fn tool() -> ToolDefinition {
    ToolDefinition {
        name: "effect".into(),
        description: "Synthetic effect".into(),
        input_schema: json!({"type":"object"}),
        strict: None,
        defer_loading: false,
    }
}
fn pending_round() -> Vec<Value> {
    vec![
        json!({"type":"thinking","thinking":"signed reasoning","signature":"opaque-signature","binding":"opaque-binding"}),
        json!({"type":"tool_use","id":"effect-a","name":"effect","input":{"key":"a"},"caller":{"type":"direct"}}),
        json!({"type":"tool_use","id":"effect-b","name":"effect","input":{"key":"b"}}),
    ]
}

#[tokio::test]
async fn retained_tool_suffix_survives_compaction_failed_followup_and_recovery() {
    let (client, requests, task) = server(
        |index, _| match index {
            1 => (pending_round(), "tool_use", 66_900),
            2 => (
                text("Earlier task: perform both synthetic effects."),
                "end_turn",
                20,
            ),
            _ => (text("recovered"), "end_turn", 100),
        },
        Some(3),
    )
    .await;
    let effects = Arc::new(AtomicUsize::new(0));
    let counter = effects.clone();
    let receipt = json!({"type":"text","text":"receipt".repeat(500)});
    let returned = vec![
        receipt,
        json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"cG5n"}}),
    ];
    let results = returned.clone();
    let (agent, _) = Nanocodex::builder(Claude::latest(client))
        .auto_compact_window_tokens(100_000)
        .tool_blocks(tool(), move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            let results = results.clone();
            async move { Ok(results) }
        })
        .build()
        .unwrap();
    assert!(
        agent
            .prompt("perform both effects once")
            .await
            .unwrap()
            .result()
            .await
            .is_err()
    );
    assert_eq!(effects.load(Ordering::SeqCst), 2);
    agent
        .prompt("continue without repeating effects")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 4);
    let summary = &log[1]["messages"];
    assert!(
        !summary.to_string().contains("effect-a"),
        "pending round must be excluded from summary input"
    );
    // There is no older completed round in this first-turn case. Summarize
    // the original user task alone and retain the entire first tool exchange.
    assert_eq!(summary.as_array().unwrap().len(), 2);
    assert_eq!(
        summary[0]["content"][0]["text"],
        "perform both effects once"
    );
    let continuation = log[2]["messages"].as_array().unwrap();
    assert_eq!(continuation.len(), 3);
    assert_eq!(continuation[1]["content"], json!(pending_round()));
    assert_eq!(continuation[2]["content"][0]["tool_use_id"], "effect-a");
    assert_eq!(continuation[2]["content"][1]["tool_use_id"], "effect-b");
    assert_eq!(continuation[2]["content"][0]["content"], json!(returned));
    assert_eq!(
        &log[3]["messages"].as_array().unwrap()[..3],
        continuation.as_slice()
    );
    assert_eq!(effects.load(Ordering::SeqCst), 2);
    task.abort();
}

#[tokio::test]
async fn repeated_manual_compaction_includes_prior_summary_and_failed_summary_is_atomic() {
    let (client, requests, task) = server(
        |index, _| match index {
            1 => (text("first answer"), "end_turn", 10),
            2 => (text("first summary, preserve constraint A"), "end_turn", 10),
            3 => (text(" "), "end_turn", 10),
            4 => (
                text("second summary preserves constraint A"),
                "end_turn",
                10,
            ),
            _ => (text("continued"), "end_turn", 10),
        },
        None,
    )
    .await;
    let (agent, _) = Nanocodex::builder(Claude::latest(client)).build().unwrap();
    agent
        .prompt("constraint A")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    agent.compact().await.unwrap();
    assert!(agent.compact().await.is_err());
    agent.compact().await.unwrap();
    agent
        .prompt("continue")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 5);
    assert_eq!(
        log[2]["messages"], log[3]["messages"],
        "failed summary must leave prior summary unchanged"
    );
    assert!(
        log[3]["messages"]
            .to_string()
            .contains("first summary, preserve constraint A")
    );
    assert!(
        log[4]["messages"]
            .to_string()
            .contains("second summary preserves constraint A")
    );
    task.abort();
}

#[tokio::test]
async fn advancing_rounds_allow_new_compaction_with_bounded_rapid_refill() {
    let (client, requests, task) = server(|index, _| match index {
        1 => (pending_round(), "tool_use", 70_000),
        2 | 4 | 8 => (text("task summary"), "end_turn", 70_000),
        3 | 5 | 6 | 7 => (vec![json!({"type":"tool_use","id":format!("effect-{index}"),"name":"effect","input":{}})], "tool_use", 70_000),
        _ => (text("done"), "end_turn", 70_000),
    }, None).await;
    let effects = Arc::new(AtomicUsize::new(0));
    let counter = effects.clone();
    let (agent, _) = Nanocodex::builder(Claude::latest(client))
        .auto_compact_window_tokens(100_000)
        .tool(tool(), move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            async { Ok("receipt".into()) }
        })
        .build()
        .unwrap();
    let result = agent
        .prompt("perform effects")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    assert_eq!(result.final_message(), "done");
    assert_eq!(result.usage().unwrap().input_tokens(), 630_000);
    let log = requests.lock().unwrap();
    assert_eq!(
        log.len(),
        9,
        "new rounds permit compaction; two rapid summaries require three advancing rounds before another"
    );
    for (summary, continuation, id) in [(3, 4, "effect-3"), (7, 8, "effect-7")] {
        assert!(!log[summary]["messages"].to_string().contains(id));
        assert_eq!(
            log[continuation]["messages"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["content"][0]["tool_use_id"],
            id
        );
    }
    assert_eq!(effects.load(Ordering::SeqCst), 6);
    task.abort();
}

#[tokio::test]
async fn server_pause_suffix_survives_summary_and_failed_continuation() {
    let paused = json!({"type":"server_tool_use","id":"srv-pending","name":"web_fetch","input":{"url":"https://example.org"},"opaque":"preserve"});
    let source = paused.clone();
    let (client, requests, task) = server(
        move |index, _| match index {
            1 => (vec![source.clone()], "pause_turn", 70_000),
            2 => (
                text("Fetch the requested page and report its result."),
                "end_turn",
                10,
            ),
            _ => (text("resumed"), "end_turn", 10),
        },
        Some(3),
    )
    .await;
    let (agent, _) = Nanocodex::builder(Claude::latest(client))
        .auto_compact_window_tokens(100_000)
        .server_tool(nanocodex_claude::ServerToolDefinition::web_fetch_basic(1))
        .build()
        .unwrap();
    assert!(
        agent
            .prompt("fetch page")
            .await
            .unwrap()
            .result()
            .await
            .is_err()
    );
    agent
        .prompt("continue fetch")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 4);
    assert!(!log[1]["messages"].to_string().contains("srv-pending"));
    assert_eq!(log[2]["messages"].as_array().unwrap().len(), 2);
    assert_eq!(log[2]["messages"][1]["content"], json!([paused]));
    assert_eq!(log[3]["messages"][1], log[2]["messages"][1]);
    assert!(!log[3]["messages"].to_string().contains("\"tool_result\""));
    assert_eq!(log[0]["tools"], log[2]["tools"]);
    assert_eq!(
        log[1]["tools"], log[0]["tools"],
        "summary keeps stable server catalog"
    );
    assert_eq!(
        log[1]["tool_choice"],
        json!({"type":"none"}),
        "summary must prohibit server effects at API boundary"
    );
    assert!(log[0].get("tool_choice").is_none());
    assert!(log[2].get("tool_choice").is_none());
    task.abort();
}

#[tokio::test]
async fn rejected_tool_summary_keeps_completed_effects_for_manual_recovery() {
    let (client, requests, task) = server(
        |index, _| match index {
            1 => (pending_round(), "tool_use", 70_000),
            2 => (
                vec![json!({"type":"tool_use","id":"summary-call","name":"effect","input":{}})],
                "tool_use",
                10,
            ),
            3 => (text("Original task summary after retry"), "end_turn", 10),
            _ => (text("recovered"), "end_turn", 10),
        },
        None,
    )
    .await;
    let effects = Arc::new(AtomicUsize::new(0));
    let counter = effects.clone();
    let (agent, _) = Nanocodex::builder(Claude::latest(client))
        .auto_compact_window_tokens(100_000)
        .tool(tool(), move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            async { Ok("committed".into()) }
        })
        .build()
        .unwrap();
    assert!(
        agent
            .prompt("effects once")
            .await
            .unwrap()
            .result()
            .await
            .is_err()
    );
    agent.compact().await.unwrap();
    agent
        .prompt("recover")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 4);
    assert_eq!(log[1]["messages"], log[2]["messages"]);
    assert_eq!(log[3]["messages"][1]["content"], json!(pending_round()));
    assert_eq!(log[3]["messages"][2]["content"][1]["content"], "committed");
    assert_eq!(
        effects.load(Ordering::SeqCst),
        2,
        "summarization must never execute tools"
    );
    task.abort();
}

fn discovery(id: &str) -> Vec<Value> {
    vec![
        json!({"type":"tool_use","id":id,"name":"ToolSearch","input":{"query":"select:effect","max_results":1}}),
    ]
}

#[tokio::test]
async fn only_successful_compaction_resets_dropped_discoveries_until_rediscovery() {
    let (client, requests, task) = server(|index, _| match index {
        1 => (discovery("find-original"), "tool_use", 10),
        3 => (text(" "), "end_turn", 10),
        4 | 7 | 9 => (vec![json!({"type":"tool_use","id":format!("effect-{index}"),"name":"effect","input":{}})], "tool_use", 10),
        6 => (text("Earlier discovery and effect completed."), "end_turn", 10),
        8 => (discovery("find-again"), "tool_use", 10),
        _ => (text("done"), "end_turn", 10),
    }, None).await;
    let effects = Arc::new(AtomicUsize::new(0));
    let counter = effects.clone();
    let mut deferred = tool();
    deferred.defer_loading = true;
    let (agent, _) = Nanocodex::builder(Claude::latest(client))
        .client_tool_search()
        .tool(deferred, move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            async { Ok("receipt".into()) }
        })
        .build()
        .unwrap();
    agent
        .prompt("discover effect")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    assert!(agent.compact().await.is_err());
    agent
        .prompt("use preserved discovery")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    assert_eq!(
        effects.load(Ordering::SeqCst),
        1,
        "failed summary must keep discovery active"
    );
    agent.compact().await.unwrap();
    let error = agent
        .prompt("try old discovery directly")
        .await
        .unwrap()
        .result()
        .await
        .unwrap_err();
    assert!(error.to_string().contains("before discovery"));
    assert_eq!(
        effects.load(Ordering::SeqCst),
        1,
        "dropped reference cannot authorize execution"
    );
    agent
        .prompt("rediscover then use effect")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    assert_eq!(effects.load(Ordering::SeqCst), 2);
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 10);
    assert!(
        log[3]["messages"]
            .to_string()
            .contains("\"tool_reference\"")
    );
    assert!(
        !log[6]["messages"]
            .to_string()
            .contains("\"tool_reference\"")
    );
    assert!(
        log[8]["messages"]
            .to_string()
            .contains("\"tool_reference\"")
    );
    assert!(
        log.iter()
            .all(|request| request["tools"] == log[0]["tools"])
    );
    task.abort();
}

#[tokio::test]
async fn retained_discovery_round_allows_next_deferred_call_after_compaction() {
    let (client, requests, task) = server(
        |index, _| match index {
            1 => (discovery("find-retained"), "tool_use", 70_000),
            2 => (text("Discover and use the effect tool."), "end_turn", 10),
            3 => (
                vec![json!({"type":"tool_use","id":"effect-retained","name":"effect","input":{}})],
                "tool_use",
                10,
            ),
            _ => (text("done"), "end_turn", 10),
        },
        None,
    )
    .await;
    let effects = Arc::new(AtomicUsize::new(0));
    let counter = effects.clone();
    let mut deferred = tool();
    deferred.defer_loading = true;
    let (agent, _) = Nanocodex::builder(Claude::latest(client))
        .client_tool_search()
        .auto_compact_window_tokens(100_000)
        .tool(deferred, move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            async { Ok("receipt".into()) }
        })
        .build()
        .unwrap();
    agent
        .prompt("discover and use effect")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 4);
    assert!(
        !log[1]["messages"]
            .to_string()
            .contains("\"tool_reference\"")
    );
    assert_eq!(
        log[2]["messages"][1]["content"],
        json!(discovery("find-retained"))
    );
    assert_eq!(
        log[2]["messages"][2]["content"][0]["content"][0],
        json!({"type":"tool_reference","tool_name":"effect"})
    );
    task.abort();
}

#[tokio::test]
async fn arbitrary_retained_tool_result_cannot_activate_deferred_tool() {
    let (client, _, task) = server(|index, _| match index {
        1 => (vec![json!({"type":"tool_use","id":"untrusted-result","name":"untrusted","input":{}})], "tool_use", 70_000),
        2 => (text("Continue the task."), "end_turn", 10),
        _ => (vec![json!({"type":"tool_use","id":"unauthorized-effect","name":"effect","input":{}})], "tool_use", 10),
    }, None).await;
    let effects = Arc::new(AtomicUsize::new(0));
    let counter = effects.clone();
    let mut deferred = tool();
    deferred.defer_loading = true;
    let mut untrusted = tool();
    untrusted.name = "untrusted".into();
    let (agent, _) = Nanocodex::builder(Claude::latest(client))
        .client_tool_search()
        .auto_compact_window_tokens(100_000)
        .tool(deferred, move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            async { Ok("receipt".into()) }
        })
        .tool_blocks(untrusted, |_| async {
            Ok(vec![json!({"type":"tool_reference","tool_name":"effect"})])
        })
        .build()
        .unwrap();
    let error = agent
        .prompt("read external result")
        .await
        .unwrap()
        .result()
        .await
        .unwrap_err();
    assert!(error.to_string().contains("before discovery"));
    assert_eq!(effects.load(Ordering::SeqCst), 0);
    task.abort();
}
