//! Fresh image results across a lost receipt acknowledgement and SQLite reopen.
#![cfg(all(feature = "claude", feature = "sqlite"))]

use axum::{Json, Router, response::IntoResponse, routing::post};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use nanocodex_agent::{Nanocodex, PromptRequest};
use nanocodex_claude::{Claude, ClaudeClient, ToolDefinition};
use nanocodex_durability::{
    DurableAgentExt, DurableSession, OwnedState, OwnerId, OwnerToken, SqliteStore, StateStore,
    StepStatus, StoreError, StoreFuture, StoreRecord,
};
use serde_json::{Value, json};
use std::{
    io::Cursor,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

const STATE_ID: &str = "claude-images-synthetic";

fn sse(blocks: Vec<Value>, stop: &str) -> String {
    let mut frames = vec![json!({"type":"message_start","message":{
        "id":"image-response","role":"assistant","model":"test","content":[],
        "usage":{"input_tokens":10,"output_tokens":0},"container":{"id":"image-container"}
    }})];
    for (index, block) in blocks.into_iter().enumerate() {
        frames.push(json!({"type":"content_block_start","index":index,"content_block":block}));
        frames.push(json!({"type":"content_block_stop","index":index}));
    }
    frames.push(
        json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":5}}),
    );
    frames.push(json!({"type":"message_stop"}));
    frames
        .into_iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect()
}

fn signed(label: &str) -> Vec<Value> {
    vec![
        json!({"type":"thinking","thinking":label,"signature":format!("signature-{label}"),"binding":{"opaque":label}}),
        json!({"type":"redacted_thinking","data":format!("redacted-{label}"),"binding":label}),
        json!({"type":"text","text":format!("text-{label}"),"citations":[]}),
    ]
}

fn tool_round() -> Vec<Value> {
    let mut blocks = signed("before-image");
    blocks.push(
        json!({"type":"tool_use","id":"capture-once","name":"capture",
        "input":{"window":"synthetic"},"caller":{"type":"direct"},"opaque":{"call":"retained"}}),
    );
    blocks
}

fn tool() -> ToolDefinition {
    ToolDefinition {
        name: "capture".into(),
        description: "Capture a synthetic image".into(),
        input_schema: json!({"type":"object"}),
        strict: None,
        defer_loading: false,
    }
}

fn image_block(format: ImageFormat, width: u32, height: u32) -> Value {
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb([17, 93, 201])));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format).unwrap();
    let media_type = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        _ => unreachable!(),
    };
    json!({"type":"image","source":{"type":"base64","media_type":media_type,
        "data":STANDARD.encode(bytes.into_inner())},"opaque":{"image":"retained"}})
}

fn dimensions(block: &Value) -> (u32, u32) {
    let bytes = STANDARD
        .decode(block["source"]["data"].as_str().unwrap())
        .unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    (decoded.width(), decoded.height())
}

fn receipt_images(blocks: &[Value]) -> Vec<Value> {
    blocks
        .iter()
        .filter(|block| block["type"] == "image")
        .cloned()
        .collect()
}

fn wire_receipt(body: &Value) -> &Value {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().unwrap())
        .find(|block| block["type"] == "tool_result")
        .unwrap()
}

async fn server(
    respond: impl Fn(usize) -> String + Send + Sync + 'static,
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
                if std::env::var_os("NANOCLAUDE_DURABILITY_TRACE").is_some() {
                    eprintln!("{}", json!({"request_index":index,"request":body}));
                }
                eprintln!(
                    "claude-images request={index} messages={}",
                    body["messages"].as_array().unwrap().len()
                );
                for message in body["messages"].as_array().unwrap() {
                    for block in message["content"].as_array().unwrap() {
                        if block["type"] == "tool_result"
                            && let Some(content) = block["content"].as_array()
                        {
                            for nested in receipt_images(content) {
                                let (width, height) = dimensions(&nested);
                                eprintln!(
                                    "claude-images request={index} wire_image={width}x{height}"
                                );
                                if width.max(height) > 3000 {
                                    return (
                                        axum::http::StatusCode::BAD_REQUEST,
                                        format!("image limit: {width}x{height}"),
                                    )
                                        .into_response();
                                }
                            }
                        }
                    }
                }
                ([("content-type", "text/event-stream")], respond(index)).into_response()
            }
        }),
    );
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

async fn reopen(path: &Path) -> DurableSession {
    DurableSession::open(SqliteStore::open(path).unwrap(), STATE_ID)
        .await
        .unwrap()
}

struct InterruptedStore {
    inner: SqliteStore,
    armed: Arc<AtomicBool>,
}

impl StateStore for InterruptedStore {
    fn read_record<'a>(
        &'a mut self,
        id: &'a str,
        key: &'a str,
    ) -> StoreFuture<'a, Result<Option<String>, StoreError>> {
        self.inner.read_record(id, key)
    }

    fn acquire<'a>(
        &'a mut self,
        id: &'a str,
        owner: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedState, StoreError>> {
        self.inner.acquire(id, owner)
    }

    fn replace<'a>(
        &'a mut self,
        id: &'a str,
        owner: &'a OwnerToken,
        revision: u64,
        payload: &'a str,
        records: &'a [StoreRecord],
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let revision = self
                .inner
                .replace(id, owner, revision, payload, records)
                .await?;
            if self.armed.swap(false, Ordering::SeqCst) {
                return Err(StoreError::Backend("synthetic lost acknowledgement".into()));
            }
            Ok(revision)
        })
    }
}

#[tokio::test]
async fn raw_image_receipt_replays_once_and_prepares_provider_history_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("admission.sqlite");
    let armed = Arc::new(AtomicBool::new(false));
    let callbacks = Arc::new(AtomicUsize::new(0));
    let unchanged = vec![
        image_block(ImageFormat::Png, 7, 3),
        image_block(ImageFormat::Jpeg, 9, 4),
        image_block(ImageFormat::WebP, 4, 5),
    ];
    let mut receipt =
        vec![json!({"type":"text","text":"capture committed","opaque":{"receipt":1}})];
    receipt.extend(unchanged.clone());
    receipt.extend([
        image_block(ImageFormat::Png, 9001, 1),
        image_block(ImageFormat::Jpeg, 1, 9001),
        image_block(ImageFormat::Gif, 4001, 3),
        image_block(ImageFormat::WebP, 3, 4001),
    ]);
    let (client, requests, server) = server(|index| {
        if index == 1 {
            sse(tool_round(), "tool_use")
        } else {
            sse(signed("fresh"), "end_turn")
        }
    })
    .await;
    let state = DurableSession::open(
        InterruptedStore {
            inner: SqliteStore::open(&path).unwrap(),
            armed: armed.clone(),
        },
        STATE_ID,
    )
    .await
    .unwrap();
    let counter = callbacks.clone();
    let returned = receipt.clone();
    let (agent, events) = Nanocodex::builder(Claude::new(client.clone(), "test"))
        .tool_blocks(tool(), move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            armed.store(true, Ordering::SeqCst);
            let returned = returned.clone();
            async move { Ok(returned) }
        })
        .durability(state)
        .await
        .unwrap()
        .build()
        .unwrap();
    let prompt = || PromptRequest::new("capture once").request_id("capture");
    let error = agent
        .prompt(prompt())
        .await
        .unwrap()
        .result()
        .await
        .unwrap_err();
    assert!(
        error.execution_policy_disposition().is_some(),
        "must stop at the receipt commit: {error}"
    );
    assert_eq!(
        requests.lock().unwrap().len(),
        1,
        "cursor must not advance past the committed receipt"
    );
    let _ = agent.shutdown().await;
    drop((agent, events));

    let state = reopen(&path).await;
    let retained = state.state().await.unwrap();
    let operation = retained.operation("capture").unwrap();
    let StepStatus::Completed(output) = &operation.steps["tool-0-capture-once"].status else {
        panic!("the image receipt must have committed before interruption");
    };
    let durable_receipt: Value = state.resolve(output).await.unwrap().decode().unwrap();
    let durable_blocks = durable_receipt["result"]["content"].as_array().unwrap();
    assert_eq!(
        durable_blocks, &receipt,
        "the authoritative effect receipt retains the handler's exact output"
    );
    let counter = callbacks.clone();
    let (agent, events) = Nanocodex::builder(Claude::new(client, "test"))
        .tool_blocks(tool(), move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            async {
                Ok(vec![
                    json!({"type":"text","text":"unexpected repeated callback"}),
                ])
            }
        })
        .durability(state)
        .await
        .unwrap()
        .build()
        .unwrap();
    let result = agent
        .prompt(prompt())
        .await
        .unwrap()
        .result()
        .await
        .unwrap();
    assert_eq!(result.final_message(), "text-fresh");
    assert_eq!(callbacks.load(Ordering::SeqCst), 1);
    let log = requests.lock().unwrap().clone();
    assert_eq!(log.len(), 2, "the original model receipt must also replay");
    let prepared_receipt = wire_receipt(&log[1]);
    assert_eq!(
        prepared_receipt["tool_use_id"],
        durable_receipt["result"]["tool_use_id"]
    );
    let prepared_blocks = prepared_receipt["content"].as_array().unwrap();
    assert_eq!(prepared_blocks[0], receipt[0]);
    let admitted = receipt_images(prepared_blocks);
    assert_eq!(
        admitted.len(),
        7,
        "admission must retain every returned image"
    );
    assert_eq!(
        &admitted[..3],
        &unchanged,
        "valid small images must remain byte-exact in provider history"
    );
    for block in &admitted[3..] {
        let (width, height) = dimensions(block);
        assert!(
            width > 0 && height > 0 && width.max(height) == 3000,
            "provider image dimensions: {width}x{height}"
        );
        assert_eq!(block["opaque"], json!({"image":"retained"}));
    }
    assert_eq!(
        log[1]["messages"][1]["content"],
        json!(tool_round()),
        "admission must preserve the signed pre-image round"
    );
    eprintln!(
        "claude-images raw_receipt_images=7 callback_count=1 http_requests=2 normalized_max_dimension=3000 signed_prefix_preserved=true"
    );
    agent.shutdown().await.unwrap();
    drop((agent, events));
    server.abort();
}
