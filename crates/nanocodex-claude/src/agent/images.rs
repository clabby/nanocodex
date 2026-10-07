//! Inline client-tool images, prepared before they join request history.
use crate::{ContentBlock, ToolResultContent};
use nanocodex_oai_tools::image::prepare_base64_images;
use serde_json::{Value, json};

/// Long-edge ceiling the direct Messages API enforces once a request carries
/// more than twenty images. Applying it when a result is first admitted keeps
/// earlier image bytes, and therefore the cached prefix, stable as history grows.
const MAX_TOOL_IMAGE_DIMENSION: u32 = 3000;

/// Replaces each base64 image in tool results with its prepared form, or with
/// a text omission when it cannot be processed. The tool result keeps its
/// error status: the tool's effect has already completed. URL and file sources
/// are provider-resolved and left unchanged.
pub(super) async fn prepare_tool_images(results: &mut [ContentBlock]) {
    let mut images: Vec<&mut Value> = results
        .iter_mut()
        .filter_map(|result| match result {
            ContentBlock::ToolResult {
                content: ToolResultContent::Blocks(blocks),
                ..
            } => Some(blocks),
            _ => None,
        })
        .flatten()
        .filter(|block| block["type"] == "image" && block["source"]["type"] == "base64")
        .collect();
    let data = images
        .iter_mut()
        .map(|block| match block["source"]["data"].take() {
            Value::String(data) => data,
            _ => String::new(),
        })
        .collect();
    let prepared = prepare_base64_images(data, MAX_TOOL_IMAGE_DIMENSION).await;
    for (block, prepared) in images.into_iter().zip(prepared) {
        match prepared {
            Ok((data, media_type)) => {
                block["source"]["data"] = data.into();
                block["source"]["media_type"] = media_type.into();
            }
            Err(omission) => *block = json!({"type": "text", "text": omission}),
        }
    }
}
