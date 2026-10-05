#![cfg(feature = "tools")]
//! Host bridge protocol scenarios: preserve actual session/turn/call identity,
//! await real answers, and retain host failure status in Claude tool results.
//! Defined while the context-aware builder integration was being implemented.

use axum::{Json, Router, routing::post};
use futures_util::StreamExt;
use nanocodex_agent::{Nanocodex, events::AgentEventKind};
use nanocodex_claude::{Claude, ClaudeClient};
use nanocodex_claude_tools::{
    HostContext, ToolOutput,
    host::{ClaudeHost, ClaudeHostTools, HostRequest, HostTool, QuestionsRequest},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

fn stream(block: Value, stop: &str) -> String {
    let is_tool = block["type"] == "tool_use";
    let input_delta = is_tool.then(|| block["input"].to_string());
    let mut events = vec![
        json!({"type":"message_start","message":{"id":"synthetic-message","role":"assistant","model":"test","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":if is_tool {json!({"type":"tool_use","id":block["id"],"name":block["name"],"input":{}})} else {block}}),
    ];
    if let Some(input_delta) = input_delta {
        events.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":input_delta}}));
    }
    events.extend([
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":5}}),
        json!({"type":"message_stop"}),
    ]);
    events
        .into_iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
struct Invocation {
    model: String,
    session: String,
    turn: String,
    call: String,
}
struct QuestionHost {
    questions: mpsc::UnboundedSender<(QuestionsRequest, oneshot::Sender<String>)>,
    invocations: Arc<Mutex<Vec<Invocation>>>,
}
impl ClaudeHost for QuestionHost {
    async fn execute(
        &self,
        request: HostRequest,
        context: HostContext<'_>,
    ) -> Result<ToolOutput, String> {
        self.invocations.lock().unwrap().push(Invocation {
            model: context.model().to_owned(),
            session: context.session_id().to_owned(),
            turn: context.turn_id().expect("real turn identity").to_owned(),
            call: context.call_id().to_owned(),
        });
        match request {
            HostRequest::AskUserQuestion(question) => {
                let (answer, received) = oneshot::channel();
                self.questions
                    .send((question, answer))
                    .map_err(|e| e.to_string())?;
                Ok(ToolOutput::text(received.await.map_err(|e| e.to_string())?))
            }
            HostRequest::TaskOutput(request) => {
                assert_eq!(request.task_id, "host-task-17");
                assert!(!request.block);
                Ok(ToolOutput::error("host task failed")
                    .with_structured_result(json!({"task_id":request.task_id,"status":"failed"}))
                    .with_metadata(json!({"host_receipt":"task-receipt-17"})))
            }
            HostRequest::TaskStop(request) => {
                assert_eq!(request.task_id, "unowned-task");
                Err("task is not owned by this session".into())
            }
            _ => Err("host capability unavailable".into()),
        }
    }
}

fn result_for<'a>(request: &'a Value, call_id: &str) -> &'a Value {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|block| block["type"] == "tool_result" && block["tool_use_id"] == call_id)
        .expect("matching Claude tool result")
}
fn text_content(result: &Value) -> String {
    match &result["content"] {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .map(|block| block["text"].as_str().expect("text block"))
            .collect::<Vec<_>>()
            .join("\n"),
        other => panic!("unexpected content: {other}"),
    }
}

#[tokio::test]
async fn host_bridge_waits_for_user_and_preserves_real_identity_and_failures() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let question = json!({"questions":[{"question":"Which deployment region?","header":"Region","options":[{"label":"North","description":"Northern region","markdown":"**North preview**"},{"label":"South","description":"Southern region"}],"multiSelect":true}]});
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let log = requests.clone();
    let requested_question = question.clone();
    let app = Router::new().route("/v1/messages", post(move |Json(body): Json<Value>| {
        let log = log.clone();
        let question = requested_question.clone();
        async move {
            let index = {let mut requests = log.lock().unwrap(); requests.push(body); requests.len()};
            let (block, stop) = match index {
                1 => (json!({"type":"tool_use","id":"ask-user-1","name":"AskUserQuestion","input":question}), "tool_use"),
                2 => (json!({"type":"tool_use","id":"observe-task-2","name":"TaskOutput","input":{"task_id":"host-task-17","block":false}}), "tool_use"),
                3 => (json!({"type":"tool_use","id":"stop-task-3","name":"TaskStop","input":{"task_id":"unowned-task"}}), "tool_use"),
                _ => (json!({"type":"text","text":"Host results received"}), "end_turn"),
            };
            ([("content-type", "text/event-stream")], stream(block, stop))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (questions, mut received) = mpsc::unbounded_channel();
    let invocations = Arc::new(Mutex::new(vec![]));
    let host = Arc::new(ClaudeHostTools::new(
        QuestionHost {
            questions,
            invocations: invocations.clone(),
        },
        [
            HostTool::AskUserQuestion,
            HostTool::TaskOutput,
            HostTool::TaskStop,
        ],
    ));
    let client = ClaudeClient::new(
        reqwest::Client::new(),
        format!("http://{address}/v1/messages"),
        "synthetic",
    );
    let (agent, mut events) = Nanocodex::builder(Claude::new(client, "test"))
        .host_tools(host)
        .build()
        .unwrap();
    let session_id = agent.session_id().to_string();
    let turn = agent
        .prompt("Ask me, then inspect and stop the specified tasks")
        .await
        .unwrap();
    let turn_id = turn.id().to_owned();
    let pending = turn.result();
    tokio::pin!(pending);
    let (received_question, answer) =
        tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(serde_json::to_value(received_question).unwrap(), question);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut pending)
            .await
            .is_err()
    );
    assert_eq!(
        requests.lock().unwrap().len(),
        1,
        "no continuation while the user has not answered"
    );
    answer.send("North and South".into()).unwrap();
    let completed = tokio::time::timeout(std::time::Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completed.final_message(), "Host results received");
    let mut result_events = Vec::new();
    loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), events.next())
            .await
            .unwrap()
            .unwrap();
        if event.kind == AgentEventKind::ToolResult {
            result_events.push(serde_json::from_str::<Value>(event.payload.get()).unwrap());
        }
        if event.kind == AgentEventKind::RunCompleted {
            break;
        }
    }
    let task_event = result_events
        .iter()
        .find(|event| event["call_id"] == "observe-task-2")
        .unwrap();
    assert_eq!(
        task_event["structured_result"],
        json!({"task_id":"host-task-17","status":"failed"})
    );
    assert_eq!(
        task_event["metadata"],
        json!({"host_receipt":"task-receipt-17"})
    );
    assert_eq!(task_event["status"], "failed");
    let observed = invocations.lock().unwrap();
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 4);
    let mut names = log[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, ["AskUserQuestion", "TaskOutput", "TaskStop"]);
    let answer = result_for(&log[1], "ask-user-1");
    assert_ne!(answer["is_error"], true);
    assert_eq!(text_content(answer), "North and South");
    let failed_output = result_for(&log[2], "observe-task-2");
    assert_eq!(
        failed_output["is_error"], true,
        "Ok(ToolOutput::error) must stay a failure"
    );
    assert_eq!(text_content(failed_output), "host task failed");
    let rejected_stop = result_for(&log[3], "stop-task-3");
    assert_eq!(rejected_stop["is_error"], true);
    assert!(text_content(rejected_stop).contains("task is not owned by this session"));
    let artifact = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../output/claude-host-integration");
    std::fs::create_dir_all(&artifact).unwrap();
    std::fs::write(
        artifact.join("requests.json"),
        serde_json::to_vec_pretty(&*log).unwrap(),
    )
    .unwrap();
    std::fs::write(
        artifact.join("tool-events.json"),
        serde_json::to_vec_pretty(&result_events).unwrap(),
    )
    .unwrap();
    std::fs::write(artifact.join("scenario.txt"), "Command: cargo test -p nanocodex-claude --features tools --test host_tools\nInput: synthetic loopback SSE AskUserQuestion -> TaskOutput -> TaskStop.\nExpected: no continuation before user answer; true session/turn/call identity; answer retained; both host error forms are is_error:true.\n").unwrap();
    std::fs::write(artifact.join("invocations.json"), serde_json::to_vec_pretty(&json!({
        "expected_session":session_id,"expected_turn":turn_id,
        "observed":observed.iter().map(|item| json!({"model":item.model,"session":item.session,"turn":item.turn,"call":item.call})).collect::<Vec<_>>()
    })).unwrap()).unwrap();
    server.abort();
    assert_eq!(
        *observed,
        ["ask-user-1", "observe-task-2", "stop-task-3"]
            .into_iter()
            .map(|call| Invocation {
                model: "test".into(),
                session: session_id.clone(),
                turn: turn_id.clone(),
                call: call.into()
            })
            .collect::<Vec<_>>()
    );
}

// A real one-pixel PNG; no provider credentials or external URLs are used.
const PIXEL: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQjD0JAAG6ATiGpB8nAAAAAElFTkSuQmCC";
struct MediaHost;
impl ClaudeHost for MediaHost {
    async fn execute(
        &self,
        request: HostRequest,
        _: HostContext<'_>,
    ) -> Result<ToolOutput, String> {
        let HostRequest::TaskOutput(request) = request else {
            return Err("unavailable".into());
        };
        use nanocodex_claude_tools::{ImageSource, ToolResultBlock};
        let content = match request.task_id.as_str() {
            "image-task" => vec![
                ToolResultBlock::Text {
                    text: "Rendered task output".into(),
                },
                ToolResultBlock::Image {
                    source: ImageSource::Base64 {
                        media_type: "image/png".into(),
                        data: PIXEL.into(),
                    },
                },
            ],
            "audio-task" => vec![ToolResultBlock::UnsupportedMedia {
                media_type: "audio/wav".into(),
            }],
            _ => return Err("unknown task".into()),
        };
        Ok(ToolOutput::content(content))
    }
}

#[tokio::test]
async fn host_image_is_claude_content_and_unsupported_audio_is_an_explicit_error() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let log = requests.clone();
    let app = Router::new().route("/v1/messages", post(move |Json(body): Json<Value>| {
        let log = log.clone();
        async move {
            let index = { let mut log = log.lock().unwrap(); log.push(body); log.len() };
            let (block, stop) = match index {
                1 => (json!({"type":"tool_use","id":"media-image","name":"TaskOutput","input":{"task_id":"image-task","block":false}}), "tool_use"),
                2 => (json!({"type":"tool_use","id":"media-audio","name":"TaskOutput","input":{"task_id":"audio-task","block":false}}), "tool_use"),
                _ => (json!({"type":"text","text":"Media handled"}), "end_turn"),
            };
            ([("content-type", "text/event-stream")], stream(block, stop))
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
        .host_tools(Arc::new(ClaudeHostTools::new(
            MediaHost,
            [HostTool::TaskOutput],
        )))
        .build()
        .unwrap();
    let turn = agent.prompt("Inspect task output").await.unwrap();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(5), turn.result())
            .await
            .unwrap()
            .unwrap()
            .final_message(),
        "Media handled"
    );
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 3);
    let image = result_for(&log[1], "media-image");
    assert_ne!(image["is_error"], true);
    assert_eq!(
        image["content"],
        json!([
            {"type":"text","text":"Rendered task output"},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":PIXEL}}
        ])
    );
    let unsupported = result_for(&log[2], "media-audio");
    assert_eq!(unsupported["is_error"], true);
    assert!(text_content(unsupported).contains("unsupported"));
    assert!(!text_content(unsupported).contains("UklGRg=="));
    let artifact = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../output/claude-host-integration");
    std::fs::create_dir_all(&artifact).unwrap();
    std::fs::write(
        artifact.join("media-requests.json"),
        serde_json::to_vec_pretty(&*log).unwrap(),
    )
    .unwrap();
    server.abort();
}
