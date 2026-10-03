use std::path::{Path, PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use eyre::Result;
use nanocodex_oai_tools::{
    ToolContext, ToolInput, Tools,
    contract::DEFAULT_TOOL_OUTPUT_TOKENS,
    runtime::{ImageGenerationConfig, ToolRuntime},
};
use serde_json::{Value, json, value::to_raw_value};
use tokio::{net::TcpListener, task::JoinHandle};

use crate::support::{
    auth::RotatingChatGptAuth,
    http::{CapturedRequest, read_request, write_json, write_unauthorized},
};

const TINY_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0,
    5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

#[tokio::test]
async fn chatgpt_auth_recovers_across_generation_and_edit_routes() -> Result<()> {
    let _runtime_test = crate::TOOL_RUNTIME_TEST_LOCK.lock().await;
    let workspace = TestWorkspace::new("image-oauth")?;
    let source_image = workspace.path().join("source.png");
    tokio::fs::write(&source_image, TINY_PNG).await?;
    let (api_base_url, server) = spawn_image_server().await?;
    let (auth, auth_source) = RotatingChatGptAuth::shared();
    let tools = Tools::builder()
        .without_defaults()
        .image_generation(true)
        .build()?;
    let runtime = ToolRuntime::new_with_tools(
        workspace.path(),
        None,
        Some(ImageGenerationConfig {
            api_base_url,
            auth,
            save_root: workspace.path().to_path_buf(),
        }),
        &tools,
    );

    let generated = runtime
        .execute_tool(
            "image_gen__imagegen",
            ToolInput::Function(to_raw_value(&json!({
                "prompt": "paint a blue whale",
            }))?),
            context("generate"),
        )
        .await
        .unwrap();
    assert!(generated.success);

    let edited = runtime
        .execute_tool(
            "image_gen__imagegen",
            ToolInput::Function(to_raw_value(&json!({
                "prompt": "add a red hat",
                "referenced_image_paths": [source_image],
            }))?),
            context("edit"),
        )
        .await
        .unwrap();
    assert!(edited.success);

    let requests = server.await??;
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path.as_str())
            .collect::<Vec<_>>(),
        [
            "/v1/images/generations",
            "/v1/images/generations",
            "/v1/images/edits",
        ]
    );
    assert_oauth_headers(&requests[0].headers, "oauth-token-0");
    assert_oauth_headers(&requests[1].headers, "oauth-token-1");
    assert_oauth_headers(&requests[2].headers, "oauth-token-1");
    assert_eq!(auth_source.recoveries(), 1);
    Ok(())
}

const fn context(call_id: &str) -> ToolContext<'_> {
    ToolContext::new(
        "gpt-6.1-sol",
        "oauth-session",
        call_id,
        &[],
        DEFAULT_TOOL_OUTPUT_TOKENS,
    )
}

async fn spawn_image_server() -> Result<(String, JoinHandle<Result<Vec<CapturedRequest>>>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let api_base_url = format!("http://{}/v1", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let mut requests = Vec::with_capacity(3);
        for index in 0..3 {
            let (mut stream, _) = listener.accept().await?;
            requests.push(read_request(&mut stream).await?);
            if index == 0 {
                write_unauthorized(&mut stream).await?;
            } else {
                write_json(
                    &mut stream,
                    &json!({
                        "created": 1,
                        "data": [{"b64_json": BASE64_STANDARD.encode(TINY_PNG)}],
                        "background": "opaque",
                        "quality": "high",
                        "size": "1024x1024"
                    }),
                )
                .await?;
            }
        }
        Ok(requests)
    });
    Ok((api_base_url, server))
}

fn assert_oauth_headers(headers: &str, token: &str) {
    let headers = headers.to_ascii_lowercase();
    assert!(headers.contains(&format!("authorization: bearer {token}")));
    assert!(headers.contains("chatgpt-account-id: account-test"));
    assert!(headers.contains("x-openai-fedramp: true"));
}

struct TestWorkspace(PathBuf);

impl TestWorkspace {
    fn new(label: &str) -> Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "nanocodex-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        std::fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Public runtime → real local HTTP provider → retained multimodal history journey.
#[tokio::test]
async fn transparency_file_references_and_error_ids_survive_the_public_tool_boundary() -> Result<()>
{
    use nanocodex_oai_api::responses::ResponseItem;
    use tokio::io::AsyncWriteExt;
    let _runtime_test = crate::TOOL_RUNTIME_TEST_LOCK.lock().await;
    let workspace = TestWorkspace::new("image-file-journey")?;
    let png = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(TINY_PNG));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let api_base_url = format!("http://{}/v1", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        let replies = [
            (
                200,
                serde_json::to_vec(
                    &json!({"data":[{"file_id":"file-generated", "generation_id":"gen-1"}]}),
                )?,
            ),
            (
                200,
                serde_json::to_vec(
                    &json!({"data":[{"b64_json":BASE64_STANDARD.encode(TINY_PNG)}]}),
                )?,
            ),
            (
                500,
                serde_json::to_vec(
                    &json!({"error":{"message":"PRIVATE-PROVIDER-LOG"}, "generation_id":"gen-failed"}),
                )?,
            ),
            (200, b"not-json".to_vec()),
            (
                200,
                serde_json::to_vec(&json!({"data":[], "generation_id":"gen-empty"}))?,
            ),
        ];
        for (index, (status, body)) in replies.into_iter().enumerate() {
            let (mut stream, _) = listener.accept().await?;
            requests.push(read_request(&mut stream).await?);
            stream.write_all(format!("HTTP/1.1 {status} Fixture\r\ncontent-type: application/json\r\nx-codex-imagegen-request-id: req-{index}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).as_bytes()).await?;
            stream.write_all(&body).await?;
        }
        eyre::Ok(requests)
    });
    let tools = Tools::builder()
        .without_defaults()
        .image_generation(true)
        .build()?;
    let runtime = ToolRuntime::new_with_tools(
        workspace.path(),
        None,
        Some(ImageGenerationConfig {
            api_base_url,
            auth: nanocodex_oai_api::auth::OpenAiAuth::api_key("synthetic-fixture-key"),
            save_root: workspace.path().to_path_buf(),
        }),
        &tools,
    );
    let helpers = runtime.execute_code(
        "image({file_id:'file-native-user', detail:'original'}); generatedImage({file_id:'file-native-result'});",
        context("native-file-helpers"),
    ).await.unwrap();
    assert!(helpers.success);
    let encoded_helpers = serde_json::to_value(&helpers.output)?;
    assert!(
        encoded_helpers
            .as_array()
            .unwrap()
            .iter()
            .any(|part| part["file_id"] == "file-native-user")
    );
    assert!(
        encoded_helpers
            .as_array()
            .unwrap()
            .iter()
            .any(|part| part["file_id"] == "file-native-result")
    );
    let generated = runtime
        .execute_tool(
            "image_gen__imagegen",
            ToolInput::Function(to_raw_value(&json!({
                "prompt":"cut out a whale", "transparent_background":true,
            }))?),
            context("generate-file"),
        )
        .await
        .unwrap();
    assert!(generated.success);
    assert_eq!(generated.structured_result()["file_id"], "file-generated");
    assert_eq!(
        generated.structured_result()["imagegen_request_id"],
        "req-0"
    );
    assert_eq!(generated.structured_result()["generation_id"], "gen-1");
    let mut history: Vec<ResponseItem> = serde_json::from_value(json!([
        {"type":"message", "role":"user", "content":[
            {"type":"input_image", "file_id":"file-too-old"},
            {"type":"input_image", "image_url":png},
        ]},
        {"type":"function_call", "call_id":"generate-file", "name":"image_gen__imagegen", "arguments":"{}"},
        {"type":"function_call_output", "call_id":"generate-file", "output":serde_json::to_value(&generated.output)?},
    ]))?;
    // Serialize/reconstruct exactly as a saved conversation would do.
    history = serde_json::from_slice(&serde_json::to_vec(&history)?)?;
    for (call_id, transparent, success) in
        [("edit-mixed", false, true), ("edit-failed", true, false)]
    {
        let output = runtime
            .execute_tool(
                "image_gen__imagegen",
                ToolInput::Function(to_raw_value(&json!({
                    "prompt":"combine the selected images", "num_last_images_to_include":2,
                    "transparent_background":transparent,
                }))?),
                ToolContext::new(
                    "gpt-6.1-sol",
                    "oauth-session",
                    call_id,
                    &history,
                    DEFAULT_TOOL_OUTPUT_TOKENS,
                ),
            )
            .await
            .unwrap();
        assert_eq!(output.success, success);
        if !success {
            assert_eq!(output.structured_result()["imagegen_request_id"], "req-2");
            assert_eq!(output.structured_result()["generation_id"], "gen-failed");
            assert!(
                !serde_json::to_string(&output.structured_result())?
                    .contains("PRIVATE-PROVIDER-LOG")
            );
        }
    }
    for (call_id, request_id, generation_id) in [
        ("decode-failed", "req-3", None),
        ("empty-failed", "req-4", Some("gen-empty")),
    ] {
        let output = runtime
            .execute_tool(
                "image_gen__imagegen",
                ToolInput::Function(to_raw_value(&json!({"prompt":"fixture"}))?),
                context(call_id),
            )
            .await
            .unwrap();
        assert!(!output.success);
        assert_eq!(
            output.structured_result()["imagegen_request_id"],
            request_id
        );
        if let Some(id) = generation_id {
            assert_eq!(output.structured_result()["generation_id"], id);
        }
    }
    // Invalid requests are rejected locally; they must not consume a provider request.
    for input in [
        json!({"prompt":"x", "transparent_background":null}),
        json!({"prompt":"x", "transparent_background":"true"}),
        json!({"prompt":"x", "num_last_images_to_include":0}),
        json!({"prompt":"x", "num_last_images_to_include":6}),
        json!({"prompt":"x", "num_last_images_to_include":1}),
    ] {
        let output = runtime
            .execute_tool(
                "image_gen__imagegen",
                ToolInput::Function(to_raw_value(&input)?),
                context("invalid"),
            )
            .await
            .unwrap();
        assert!(!output.success);
    }
    let requests = server.await??;
    assert_eq!(requests.len(), 5);
    let bodies: Vec<Value> = requests
        .iter()
        .map(|request| serde_json::from_slice(&request.body))
        .collect::<std::result::Result<_, _>>()?;
    assert_eq!(requests[0].path, "/v1/images/generations");
    assert_eq!(bodies[0]["background"], "transparent");
    for index in [1, 2] {
        assert_eq!(requests[index].path, "/v1/images/edits");
        assert_eq!(
            bodies[index]["images"],
            json!([{ "image_url":png }, { "file_id":"file-generated" }])
        );
    }
    assert_eq!(bodies[1]["background"], "opaque");
    assert_eq!(bodies[2]["background"], "transparent");
    assert_eq!(bodies[3]["background"], "opaque");
    assert_eq!(bodies[4]["background"], "opaque");
    eprintln!(
        "image journey captured 5 real HTTP requests: generation transparent; mixed edit opaque/transparent; decode/no-data failures preserve IDs; no provider log disclosure"
    );
    Ok(())
}
