//! Client-tool image preparation before new results enter provider history.
use crate::{ContentBlock, ToolResultContent};
#[cfg(not(target_family = "wasm"))]
use nanocodex_agent::NanocodexError;
use nanocodex_agent::Result;
use nanocodex_oai_tools::image::{ImageDetail, prepare_base64_image};
use serde_json::{Value, json};
use std::num::NonZeroU32;

/// Dimension ceiling for base64 client-tool images on the direct Claude API.
/// Applying its many-image limit at admission keeps earlier image bytes stable
/// when later turns increase the request's image count beyond twenty.
pub const MAX_TOOL_IMAGE_DIMENSION: NonZeroU32 = NonZeroU32::new(3000).unwrap();

#[allow(clippy::unused_async, reason = "WASM prepares images inline")]
pub(super) async fn prepare(mut results: Vec<ContentBlock>) -> Result<Vec<ContentBlock>> {
    if !results.iter().any(|result| {
        matches!(result, ContentBlock::ToolResult { content: ToolResultContent::Blocks(blocks), .. }
            if blocks.iter().any(is_base64_image))
    }) {
        return Ok(results);
    }
    #[cfg(target_family = "wasm")]
    {
        prepare_results(&mut results);
        Ok(results)
    }
    #[cfg(not(target_family = "wasm"))]
    tokio::task::spawn_blocking(move || {
        prepare_results(&mut results);
        results
    })
    .await
    .map_err(|_| NanocodexError::InvalidRequest("Claude image preparation task failed".into()))
}

fn is_base64_image(block: &Value) -> bool {
    block["type"] == "image" && block["source"]["type"] == "base64"
}

fn prepare_results(results: &mut [ContentBlock]) {
    for result in results {
        let ContentBlock::ToolResult {
            content: ToolResultContent::Blocks(blocks),
            ..
        } = result
        else {
            continue;
        };
        for block in blocks.iter_mut().filter(|block| is_base64_image(block)) {
            match prepare_base64_image(
                block["source"]["data"].as_str().unwrap_or_default(),
                ImageDetail::Original,
                MAX_TOOL_IMAGE_DIMENSION,
            ) {
                Ok((data, media_type)) => {
                    block["source"]["data"] = Value::String(data);
                    block["source"]["media_type"] = Value::String(media_type.into());
                }
                Err(reason) => *block = json!({"type":"text","text":reason}),
            }
        }
    }
}
