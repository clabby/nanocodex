//! Image-bearing client tools exercised through the real streaming HTTP transport.
use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::post};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader};
use nanocodex_agent::Nanocodex;
use nanocodex_claude::{Claude, ClaudeClient, ToolDefinition};
use serde_json::{Value, json};
use std::{
    io::Cursor,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

fn image_block(width: u32, height: u32, format: ImageFormat) -> Value {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(width, height)
        .write_to(&mut bytes, format)
        .unwrap();
    json!({"type":"image","source":{"type":"base64","media_type":format.to_mime_type(),"data":STANDARD.encode(bytes.into_inner())},"cache_control":{"type":"ephemeral"},"opaque":"image metadata"})
}

fn dimensions(block: &Value) -> Option<(u32, u32)> {
    if block["type"] != "image" || block["source"]["type"] != "base64" {
        return None;
    }
    let bytes = STANDARD.decode(block["source"]["data"].as_str()?).ok()?;
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(16 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader.into_decoder().ok()?;
    if decoder.total_bytes() > 16 * 1024 * 1024 {
        return None;
    }
    DynamicImage::from_decoder(decoder)
        .ok()
        .map(|image| image.dimensions())
}

fn images(request: &Value) -> Vec<&Value> {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().unwrap())
        .filter(|block| block["type"] == "tool_result")
        .flat_map(|block| block["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "image")
        .collect()
}

fn reasoning(id: usize) -> Vec<Value> {
    vec![
        json!({"type":"thinking","thinking":"","signature":format!("signature-{id}"),"opaque":"signed metadata"}),
        json!({"type":"redacted_thinking","data":format!("redacted-{id}"),"opaque":"redacted metadata"}),
    ]
}

async fn provider(
    respond: impl Fn(usize) -> (Vec<Value>, &'static str) + Send + Sync + 'static,
) -> (
    ClaudeClient,
    Arc<Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let received = requests.clone();
    let issued = Arc::new(Mutex::new(Vec::<(Value, Vec<Value>)>::new()));
    let respond = Arc::new(respond);
    let app = Router::new().route("/v1/messages", post(move |Json(body): Json<Value>| {
        let received = received.clone();
        let issued = issued.clone();
        let respond = respond.clone();
        async move {
            let index = {
                let mut requests = received.lock().unwrap();
                requests.push(body.clone());
                requests.len()
            };
            let images = images(&body);
            let sizes = images.iter().filter_map(|block| dimensions(block)).collect::<Vec<_>>();
            eprintln!("image admission request={index}, images={}, decoded_dimensions={sizes:?}", images.len());
            for block in &images {
                if block["source"]["type"] != "base64" {
                    continue;
                }
                let Some((width, height)) = dimensions(block) else {
                    return (StatusCode::BAD_REQUEST, "invalid image data").into_response();
                };
                let limit = if images.len() > 20 { 3000 } else { 8000 };
                if width > limit || height > limit {
                    return (StatusCode::BAD_REQUEST, Json(json!({"type":"error","error":{"type":"invalid_request_error","message":"At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels"}}))).into_response();
                }
            }
            let messages = body["messages"].as_array().unwrap();
            let mut issued = issued.lock().unwrap();
            // Compare a replayed block with the actual request that produced it;
            // these append-only journeys must preserve the entire signed prefix.
            for (position, message) in messages.iter().enumerate() {
                let content = message["content"].as_array().unwrap();
                if !content.iter().any(|block| matches!(block["type"].as_str(), Some("thinking" | "redacted_thinking"))) {
                    continue;
                }
                if !issued.iter().any(|(request, response)| {
                    response == content && request["system"] == body["system"]
                        && request["tools"] == body["tools"]
                        && request["messages"].as_array().unwrap() == &messages[..position]
                }) {
                    return (StatusCode::BAD_REQUEST, "changed thinking prefix").into_response();
                }
            }
            let (blocks, stop) = respond(index);
            issued.push((body, blocks.clone()));
            let mut frames = vec![json!({"type":"message_start","message":{"id":format!("response-{index}"),"role":"assistant","model":"test","content":[],"usage":{"input_tokens":10,"output_tokens":0}}})];
            for (index, block) in blocks.into_iter().enumerate() {
                frames.push(json!({"type":"content_block_start","index":index,"content_block":block}));
                frames.push(json!({"type":"content_block_stop","index":index}));
            }
            frames.push(json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":5}}));
            frames.push(json!({"type":"message_stop"}));
            ([("content-type","text/event-stream")], frames.into_iter().map(|frame| format!("data: {frame}\n\n")).collect::<String>()).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/messages", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        ClaudeClient::new(reqwest::Client::new(), endpoint, "synthetic"),
        requests,
        server,
    )
}

fn tool() -> ToolDefinition {
    ToolDefinition {
        name: "images".into(),
        description: "Return images with a completed receipt".into(),
        input_schema: json!({"type":"object"}),
        strict: None,
        defer_loading: false,
    }
}

#[tokio::test]
async fn original_images_stay_stable_when_later_tool_results_cross_twenty() {
    let (client, requests, server) = provider(|index| {
        let mut blocks = reasoning(index);
        if matches!(index, 1 | 3) {
            blocks.push(json!({"type":"tool_use","id":format!("images-{index}"),"name":"images","input":{"batch":index},"opaque":"call metadata"}));
            (blocks, "tool_use")
        } else {
            blocks.push(json!({"type":"text","text":"completed"}));
            (blocks, "end_turn")
        }
    }).await;
    let original = image_block(5008, 650, ImageFormat::Png);
    let original_returned = original.clone();
    let effects = Arc::new(AtomicUsize::new(0));
    let calls = effects.clone();
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .system("Stable instructions")
        .adaptive_thinking()
        .tool_blocks(tool(), move |input| {
            calls.fetch_add(1, Ordering::SeqCst);
            let blocks = if input["batch"] == 1 {
                vec![original_returned.clone()]
            } else {
                vec![image_block(16, 16, ImageFormat::Png); 20]
            };
            async move { Ok(blocks) }
        })
        .build()
        .unwrap();
    for prompt in [
        "View the wide image",
        "View twenty more",
        "Continue from all images",
    ] {
        assert_eq!(
            agent
                .prompt(prompt)
                .await
                .unwrap()
                .result()
                .await
                .unwrap()
                .final_message(),
            "completed"
        );
    }
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        5,
        "no request retry or repeated tool execution"
    );
    assert_eq!(effects.load(Ordering::SeqCst), 2);
    let first = images(&requests[1])[0];
    assert_eq!(
        dimensions(first),
        Some((3000, 389)),
        "native tool images keep the largest supported direct-API size"
    );
    assert_eq!(first["opaque"], original["opaque"]);
    assert_eq!(first["cache_control"], original["cache_control"]);
    for request in &requests[1..] {
        assert_eq!(
            images(request)[0],
            first,
            "normalization happens before the first signed response"
        );
        assert_eq!(request["tools"], requests[0]["tools"]);
    }
    assert_eq!(images(&requests[3]).len(), 21);
    assert_eq!(
        requests[4]["messages"][7]["content"][0],
        reasoning(4)[0],
        "fresh thinking is retained"
    );
    server.abort();
}

fn forged_png(width: u32, height: u32) -> Value {
    let mut block = image_block(1, 1, ImageFormat::Png);
    let mut bytes = STANDARD
        .decode(block["source"]["data"].as_str().unwrap())
        .unwrap();
    bytes[16..20].copy_from_slice(&width.to_be_bytes());
    bytes[20..24].copy_from_slice(&height.to_be_bytes());
    let mut crc = u32::MAX;
    for byte in &bytes[12..29] {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
    block["source"]["data"] = json!(STANDARD.encode(bytes));
    block
}

#[tokio::test]
async fn tool_image_formats_and_unprocessable_data_keep_sibling_receipts() {
    let (client, requests, server) = provider(|index| {
        if index == 1 {
            (
                vec![json!({"type":"tool_use","id":"formats","name":"images","input":{}})],
                "tool_use",
            )
        } else {
            (vec![json!({"type":"text","text":"processed"})], "end_turn")
        }
    })
    .await;
    let mut returned = vec![json!({"type":"text","text":"effect completed once"})];
    for format in [
        ImageFormat::Png,
        ImageFormat::Jpeg,
        ImageFormat::WebP,
        ImageFormat::Gif,
    ] {
        returned.push(image_block(4096, 64, format));
    }
    for data in ["", "not base64", "cG5n", "iVBORw0KGgo="] {
        returned.push(
            json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":data}}),
        );
    }
    returned.push(forged_png(u32::MAX, u32::MAX));
    returned.push(forged_png(0, 1));
    let untouched = vec![
        image_block(32, 24, ImageFormat::Png),
        image_block(32, 24, ImageFormat::Jpeg),
        image_block(32, 24, ImageFormat::WebP),
        json!({"type":"image","source":{"type":"url","url":"https://example.invalid/no-fetch.png"},"opaque":17}),
        json!({"type":"image","source":{"type":"file","file_id":"provider-owned"}}),
        json!({"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"opaque"}}),
        json!({"type":"future_block","opaque":{"type":"image","source":{"type":"base64","data":"do not inspect"}}}),
    ];
    returned.extend(untouched.clone());
    let (agent, _) = Nanocodex::builder(Claude::new(client, "test"))
        .tool_blocks(tool(), move |_| {
            let returned = returned.clone();
            async move { Ok(returned) }
        })
        .build()
        .unwrap();
    assert_eq!(
        agent
            .prompt("inspect formats")
            .await
            .unwrap()
            .result()
            .await
            .unwrap()
            .final_message(),
        "processed"
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let receipt = &requests[1]["messages"][2]["content"][0];
    assert_ne!(
        receipt["is_error"], true,
        "image failure cannot undo a completed side effect"
    );
    let content = receipt["content"].as_array().unwrap();
    assert_eq!(content[0]["text"], "effect completed once");
    for block in &content[1..5] {
        assert_eq!(dimensions(block), Some((3000, 47)));
    }
    for block in &content[5..11] {
        assert_eq!(block["type"], "text");
        assert!(
            block["text"]
                .as_str()
                .unwrap()
                .contains("image content omitted")
        );
        assert!(block["text"].as_str().unwrap().len() < 200);
    }
    assert_eq!(&content[11..], untouched);
    server.abort();
}
