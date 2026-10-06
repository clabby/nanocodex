//! Retry journeys through the public agent and a loopback Messages endpoint.
use axum::{Router, body::Body, http::StatusCode, response::IntoResponse, routing::post};
use futures_util::{StreamExt, stream};
use nanocodex_agent::{
    Nanocodex, NanocodexError,
    events::{AgentEventKind, TimedAgentEvent, monotonic_now_ns},
};
use nanocodex_claude::{Claude, ClaudeClient, ServerToolDefinition, ToolDefinition};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

enum Reply {
    Http(u16),
    RateLimited(&'static str),
    Stream(String),
    Disconnected,
    Pending,
}

struct Fixture {
    client: ClaudeClient,
    requests: Arc<Mutex<Vec<String>>>,
    request_times: Arc<Mutex<Vec<u64>>>,
    received: Arc<tokio::sync::Notify>,
    server: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn new(reply: impl Fn(usize) -> Reply + Send + Sync + 'static) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let request_times = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::new(tokio::sync::Notify::new());
        let app = Router::new().route(
            "/v1/messages",
            post({
                let requests = requests.clone();
                let request_times = request_times.clone();
                let received = received.clone();
                let reply = Arc::new(reply);
                move |body: String| {
                    let requests = requests.clone();
                    let request_times = request_times.clone();
                    let received = received.clone();
                    let reply = reply.clone();
                    async move {
                        let index = {
                            let mut log = requests.lock().unwrap();
                            log.push(body);
                            request_times.lock().unwrap().push(monotonic_now_ns());
                            log.len()
                        };
                        received.notify_one();
                        match reply(index) {
                            Reply::RateLimited(delay) => (
                                StatusCode::TOO_MANY_REQUESTS,
                                [("retry-after", delay)],
                                "limited",
                            )
                                .into_response(),
                            Reply::Http(status) => {
                                (StatusCode::from_u16(status).unwrap(), "synthetic failure")
                                    .into_response()
                            }
                            Reply::Stream(body) => {
                                ([("content-type", "text/event-stream")], body).into_response()
                            }
                            Reply::Pending => (
                                [("content-type", "text/event-stream")],
                                Body::from_stream(stream::pending::<Result<String, Infallible>>()),
                            )
                                .into_response(),
                            Reply::Disconnected => (
                                [("content-type", "text/event-stream")],
                                Body::from_stream(stream::iter([Err::<String, _>(
                                    std::io::Error::other("connection interrupted"),
                                )])),
                            )
                                .into_response(),
                        }
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/messages", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            client: ClaudeClient::new(reqwest::Client::new(), endpoint, "synthetic"),
            requests,
            request_times,
            received,
            server,
        }
    }

    async fn wait_requests(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.requests.lock().unwrap().len() < count {
                self.received.notified().await;
            }
        })
        .await
        .unwrap();
    }

    // Emission and loopback receipt share a monotonic clock, so queued event
    // delivery cannot inflate the measured wait.
    fn assert_retry_wait(&self, event: &TimedAgentEvent, first_request: usize) -> Duration {
        let payload: Value = serde_json::from_str(event.event.payload.get()).unwrap();
        let attempt = payload["attempt"].as_u64().unwrap();
        let next_attempt = payload["next_attempt"].as_u64().unwrap();
        assert_eq!(next_attempt, attempt + 1);
        assert_eq!(payload["max_attempts"], 5);
        let delay = Duration::from_nanos(payload["delay_ns"].as_u64().unwrap());
        let scale = 2_u32.pow(u32::try_from(attempt - 1).unwrap());
        assert!(delay >= Duration::from_millis(900) * scale);
        if payload["server_requested_delay"] == false {
            assert!(delay <= Duration::from_millis(1_100) * scale);
        }
        let request_index = first_request + usize::try_from(next_attempt).unwrap() - 1;
        let received_ns = self.request_times.lock().unwrap()[request_index];
        let waited =
            Duration::from_nanos(received_ns.checked_sub(event.timing.emitted_ns).unwrap());
        eprintln!(
            "retry timing: call={}, attempt={attempt}->{next_attempt}, HTTP request={}, emitted_delay={delay:?}, observed_wait={waited:?}",
            payload["model_call_index"],
            request_index + 1,
        );
        assert!(
            waited >= delay,
            "next HTTP attempt arrived after {waited:?}, before emitted delay {delay:?}"
        );
        delay
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn frames(events: Vec<Value>) -> String {
    events
        .into_iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect()
}

fn start(input: u64) -> Value {
    json!({"type":"message_start","message":{"id":"synthetic","role":"assistant","model":"test","content":[],"usage":{"input_tokens":input,"output_tokens":0}}})
}

fn error(kind: &str) -> String {
    frames(vec![
        json!({"type":"error","error":{"type":kind,"message":"synthetic transient"}}),
    ])
}

fn completed(tool: bool) -> String {
    let mut events = vec![start(10)];
    let block = if tool {
        json!({"type":"tool_use","id":"effect-once","name":"effect","input":{}})
    } else {
        json!({"type":"text","text":""})
    };
    events.push(json!({"type":"content_block_start","index":0,"content_block":block}));
    if !tool {
        events.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"completed"}}));
    }
    events.push(json!({"type":"content_block_stop","index":0}));
    events.push(json!({"type":"message_delta","delta":{"stop_reason":if tool { "tool_use" } else { "end_turn" }},"usage":{"output_tokens":5}}));
    events.push(json!({"type":"message_stop"}));
    frames(events)
}

#[tokio::test]
async fn retry_current_request_preserves_prior_effect_and_discards_failed_fragments() {
    let fixture = Fixture::new(|index| match index {
        1 => Reply::Http(503),
        2 => Reply::Stream(completed(true)),
        3 => Reply::Stream(frames(vec![
            start(900),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"discarded","name":"effect","input":{}}}),
            json!({"type":"content_block_stop","index":0}),
        ]) + &error("overloaded_error")),
        4 => Reply::Http(429),
        5 => Reply::Http(529),
        _ => Reply::Stream(completed(false)),
    }).await;
    let effects = Arc::new(AtomicUsize::new(0));
    let counter = effects.clone();
    let (agent, mut events) = Nanocodex::builder(Claude::new(fixture.client.clone(), "test"))
        .tool(
            ToolDefinition {
                name: "effect".into(),
                description: "Synthetic effect".into(),
                input_schema: json!({"type":"object"}),
                strict: None,
                defer_loading: false,
            },
            move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                async { Ok("committed once".into()) }
            },
        )
        .build()
        .unwrap();
    let result = agent
        .prompt("complete the effect")
        .await
        .unwrap()
        .result()
        .await;
    eprintln!(
        "retry journey: requests={}, effects={}, result={result:?}",
        fixture.requests.lock().unwrap().len(),
        effects.load(Ordering::SeqCst)
    );
    let result = result.unwrap();
    assert_eq!(result.final_message(), "completed");
    assert_eq!(result.usage().unwrap().total_tokens(), 30);
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    let log = fixture.requests.lock().unwrap().clone();
    assert_eq!(log.len(), 6);
    assert_eq!(log[0], log[1]);
    assert!(
        log[2..].windows(2).all(|pair| pair[0] == pair[1]),
        "every retry sends the identical current request"
    );
    let request: Value = serde_json::from_str(&log[2]).unwrap();
    assert_eq!(
        request["messages"][2]["content"][0]["content"],
        "committed once"
    );
    assert!(!log[2].contains("discarded"));
    let mut text = String::new();
    let mut attempts = Vec::new();
    let mut retries = 0;
    let mut retry_delays = [Vec::new(), Vec::new()];
    loop {
        let timed = events.recv_timed().await.unwrap();
        let event = &timed.event;
        let payload: Value = serde_json::from_str(event.payload.get()).unwrap();
        match event.kind {
            AgentEventKind::AssistantDelta => text.push_str(payload["text"].as_str().unwrap()),
            AgentEventKind::ModelCallCompleted => {
                attempts.push(payload["attempt"].as_u64().unwrap())
            }
            AgentEventKind::ModelAttemptRetrying => {
                let call = usize::try_from(payload["model_call_index"].as_u64().unwrap()).unwrap();
                assert_eq!(payload["attempt"], retry_delays[call].len() + 1);
                let delay = fixture.assert_retry_wait(&timed, if call == 0 { 0 } else { 2 });
                retry_delays[call].push(delay);
                retries += 1;
            }
            AgentEventKind::RunCompleted => break,
            _ => {}
        }
    }
    assert_eq!(text, "completed");
    assert_eq!(attempts, [2, 4]);
    assert_eq!(retries, 4);
    assert_eq!(retry_delays[0].len(), 1);
    assert_eq!(retry_delays[1].len(), 3);
    assert!(retry_delays[1].windows(2).all(|pair| pair[0] < pair[1]));
    agent.shutdown().await.unwrap();
}

#[tokio::test]
async fn transient_classification_and_exhaustion_are_bounded() {
    for status in [429, 500, 502, 503, 504, 529] {
        let fixture = Fixture::new(move |index| {
            if index == 1 {
                Reply::Http(status)
            } else {
                Reply::Stream(completed(false))
            }
        })
        .await;
        let (agent, _) = Nanocodex::builder(Claude::new(fixture.client.clone(), "test"))
            .build()
            .unwrap();
        assert_eq!(
            agent
                .prompt("retry transient")
                .await
                .unwrap()
                .result()
                .await
                .unwrap()
                .final_message(),
            "completed",
            "HTTP {status}"
        );
        assert_eq!(fixture.requests.lock().unwrap().len(), 2);
        agent.shutdown().await.unwrap();
    }
    for kind in [
        "overloaded_error",
        "api_error",
        "rate_limit_error",
        "timeout_error",
        "truncated",
        "disconnected",
    ] {
        let fixture = Fixture::new(move |index| {
            if index == 1 && kind == "disconnected" {
                return Reply::Disconnected;
            }
            Reply::Stream(if index > 1 {
                completed(false)
            } else if kind == "truncated" {
                frames(vec![start(900)])
            } else {
                error(kind)
            })
        })
        .await;
        let (agent, _) = Nanocodex::builder(Claude::new(fixture.client.clone(), "test"))
            .build()
            .unwrap();
        assert_eq!(
            agent
                .prompt("retry stream")
                .await
                .unwrap()
                .result()
                .await
                .unwrap()
                .final_message(),
            "completed",
            "{kind}"
        );
        assert_eq!(fixture.requests.lock().unwrap().len(), 2);
        agent.shutdown().await.unwrap();
    }
    let fixture = Fixture::new(|_| Reply::Stream(error("overloaded_error"))).await;
    let (agent, mut events) = Nanocodex::builder(Claude::new(fixture.client.clone(), "test"))
        .build()
        .unwrap();
    let turn = agent.prompt("exhaust retries").await.unwrap();
    let error = tokio::time::timeout(Duration::from_secs(20), turn.result())
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("overloaded_error"));
    assert_eq!(fixture.requests.lock().unwrap().len(), 5);
    let mut delays = Vec::new();
    loop {
        let timed = events.recv_timed().await.unwrap();
        match timed.event.kind {
            AgentEventKind::ModelAttemptRetrying => {
                let payload: Value = serde_json::from_str(timed.event.payload.get()).unwrap();
                assert_eq!(payload["model_call_index"], 0);
                assert_eq!(payload["attempt"], delays.len() + 1);
                delays.push(fixture.assert_retry_wait(&timed, 0));
            }
            AgentEventKind::RunFailed => break,
            _ => {}
        }
    }
    assert_eq!(delays.len(), 4);
    assert!(delays.windows(2).all(|pair| pair[0] < pair[1]));
    eprintln!(
        "transient HTTP/SSE/truncation recover; persistent overload stops after 5 attempts: {error}"
    );
    agent.shutdown().await.unwrap();
}

#[tokio::test]
async fn permanent_malformed_and_published_output_failures_do_not_retry() {
    for scenario in 0..9 {
        let fixture = Fixture::new(move |index| {
            if index > 1 { return Reply::Stream(completed(false)); }
            match scenario {
                0 => Reply::Http(400),
                1 => Reply::Http(401),
                2 => Reply::Http(403),
                3 => Reply::Http(409),
                4 => Reply::Stream(error("invalid_request_error")),
                5 => Reply::Stream(error("authentication_error")),
                6 => Reply::Stream("data: {malformed}\n\n".into()),
                7 => Reply::Stream(frames(vec![json!({"type":"message_stop"})])),
                _ => Reply::Stream(frames(vec![start(10),
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"published once"}}),
                ]) + &error("overloaded_error")),
            }
        }).await;
        let (agent, mut events) = Nanocodex::builder(Claude::new(fixture.client.clone(), "test"))
            .build()
            .unwrap();
        assert!(
            agent
                .prompt("fail safely")
                .await
                .unwrap()
                .result()
                .await
                .is_err(),
            "scenario={scenario}"
        );
        assert_eq!(
            fixture.requests.lock().unwrap().len(),
            1,
            "scenario={scenario}"
        );
        let mut text = String::new();
        loop {
            let event = events.next().await.unwrap();
            if event.kind == AgentEventKind::AssistantDelta {
                let payload: Value = serde_json::from_str(event.payload.get()).unwrap();
                text.push_str(payload["text"].as_str().unwrap());
            }
            assert_ne!(event.kind, AgentEventKind::ModelCallCompleted);
            if event.kind == AgentEventKind::RunFailed {
                break;
            }
        }
        assert_eq!(text, if scenario == 8 { "published once" } else { "" });
        agent.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn unobserved_server_effects_block_retry_but_http_rejection_can_retry() {
    for scenario in 0..4 {
        let fixture = Fixture::new(move |index| {
            if index > 1 {
                return Reply::Stream(completed(false));
            }
            match scenario {
                0 => Reply::Stream(error("overloaded_error")),
                1 => Reply::Http(529),
                2 => Reply::Stream(frames(vec![start(10)])),
                _ => Reply::Http(429),
            }
        })
        .await;
        let (agent, _) = Nanocodex::builder(Claude::new(fixture.client.clone(), "test"))
            .server_tool(ServerToolDefinition::code_execution_current())
            .build()
            .unwrap();
        let result = agent.prompt("server work").await.unwrap().result().await;
        if scenario == 3 {
            assert_eq!(result.unwrap().final_message(), "completed");
            let log = fixture.requests.lock().unwrap();
            assert_eq!(log.len(), 2);
            assert_eq!(log[0], log[1]);
        } else {
            assert!(result.is_err());
            assert_eq!(fixture.requests.lock().unwrap().len(), 1);
            agent
                .prompt("reconcile")
                .await
                .unwrap()
                .result()
                .await
                .unwrap();
            let log = fixture.requests.lock().unwrap();
            assert_eq!(log.len(), 2);
            assert!(
                log[1].contains("outcome unknown"),
                "execution may precede all observed blocks"
            );
        }
        agent.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_stops_backoff_and_pending_retry() {
    for during_request in [false, true] {
        let fixture = Fixture::new(|index| {
            if index == 1 {
                Reply::Stream(error("overloaded_error"))
            } else {
                Reply::Pending
            }
        })
        .await;
        let (agent, mut events) = Nanocodex::builder(Claude::new(fixture.client.clone(), "test"))
            .build()
            .unwrap();
        let turn = agent.prompt("cancel retry").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if events.next().await.unwrap().kind == AgentEventKind::ModelAttemptRetrying {
                    break;
                }
            }
        })
        .await
        .unwrap();
        if during_request {
            fixture.wait_requests(2).await;
        }
        turn.cancel().await.unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), turn.result())
                .await
                .unwrap(),
            Err(NanocodexError::TurnCancelled)
        ));
        assert_eq!(
            fixture.requests.lock().unwrap().len(),
            if during_request { 2 } else { 1 }
        );
        agent.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn retry_after_is_respected_cancellable_and_bounded() {
    for hint in [
        "0",
        "1",
        "2",
        "60",
        "61",
        "184467440737095516160",
        "Fri, 01 Jan 2100 00:00:00 GMT",
    ] {
        let fixture = Fixture::new(move |index| {
            if index == 1 {
                Reply::RateLimited(hint)
            } else {
                Reply::Stream(completed(false))
            }
        })
        .await;
        let (agent, mut events) = Nanocodex::builder(Claude::new(fixture.client.clone(), "test"))
            .build()
            .unwrap();
        let turn = agent.prompt("respect server delay").await.unwrap();
        if hint == "60" {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let event = events.next().await.unwrap();
                    if event.kind == AgentEventKind::ModelAttemptRetrying {
                        let payload: Value = serde_json::from_str(event.payload.get()).unwrap();
                        assert_eq!(payload["delay_ns"], 60_000_000_000u64);
                        break;
                    }
                }
            })
            .await
            .unwrap();
            turn.cancel().await.unwrap();
        }
        let result = tokio::time::timeout(Duration::from_secs(3), turn.result())
            .await
            .unwrap();
        if matches!(hint, "0" | "1" | "2") {
            assert_eq!(result.unwrap().final_message(), "completed");
            assert_eq!(fixture.requests.lock().unwrap().len(), 2);
            let mut retries = 0;
            loop {
                let timed = events.recv_timed().await.unwrap();
                match timed.event.kind {
                    AgentEventKind::ModelAttemptRetrying => {
                        let payload: Value =
                            serde_json::from_str(timed.event.payload.get()).unwrap();
                        assert_eq!(payload["server_requested_delay"], true);
                        assert!(
                            fixture.assert_retry_wait(&timed, 0)
                                >= Duration::from_secs(hint.parse().unwrap())
                        );
                        retries += 1;
                    }
                    AgentEventKind::RunCompleted => break,
                    _ => {}
                }
            }
            assert_eq!(retries, 1);
        } else {
            assert!(result.is_err());
            assert_eq!(
                fixture.requests.lock().unwrap().len(),
                1,
                "long hints must not be shortened into an early retry"
            );
        }
        agent.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn compaction_has_its_own_three_attempt_budget() {
    let fixture = Fixture::new(|index| {
        Reply::Stream(if index == 1 {
            completed(false)
        } else {
            error("overloaded_error")
        })
    })
    .await;
    let (agent, _) = Nanocodex::builder(Claude::new(fixture.client.clone(), "test"))
        .server_tool(ServerToolDefinition::code_execution_current())
        .build()
        .unwrap();
    agent
        .prompt("remember this")
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    assert!(agent.compact().await.is_err());
    let log = fixture.requests.lock().unwrap().clone();
    assert_eq!(log.len(), 4);
    assert!(log[1..].windows(2).all(|pair| pair[0] == pair[1]));
    agent.shutdown().await.unwrap();
}
