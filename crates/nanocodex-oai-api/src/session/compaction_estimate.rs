//! Model-visible byte accounting from codex-rs 36430b3688 context_manager/history.rs.
//! Transport envelopes, IDs, citations and JSON escaping do not consume model context.
use super::*;
pub(super) fn model_visible_len(item: &ResponseItem) -> usize {
    match item {
        ResponseItem::Message { content, .. } => content
            .iter()
            .map(|part| match part {
                ContentItem::InputText { text } | ContentItem::OutputText { text, .. } => {
                    text.len()
                }
                ContentItem::InputImage { image_url, detail } => image_bytes(image_url, *detail),
                ContentItem::InputImageFile { .. } => RESIZED_IMAGE_BYTES_ESTIMATE,
                ContentItem::InputAudio { audio_url } => audio_bytes(audio_url),
            })
            .fold(0, usize::saturating_add),
        ResponseItem::AgentMessage {
            author,
            recipient,
            content,
            ..
        } => content
            .iter()
            .map(|part| match part {
                crate::responses::AgentMessageContent::InputText { text } => text.len(),
                crate::responses::AgentMessageContent::EncryptedContent { encrypted_content } => {
                    encrypted_content.len().saturating_mul(9).div_ceil(16)
                }
            })
            .fold(
                author.len().saturating_add(recipient.len()),
                usize::saturating_add,
            ),
        ResponseItem::Reasoning {
            encrypted_content: Some(content),
            ..
        }
        | ResponseItem::ContextCompaction {
            encrypted_content: Some(content),
            ..
        }
        | ResponseItem::Compaction {
            encrypted_content: content,
            ..
        } => content
            .len()
            .saturating_mul(3)
            .checked_div(4)
            .unwrap_or(0)
            .saturating_sub(650),
        ResponseItem::FunctionCall {
            name,
            namespace,
            arguments: input,
            ..
        }
        | ResponseItem::CustomToolCall {
            name,
            namespace,
            input,
            ..
        } => name
            .len()
            .saturating_add(namespace.as_deref().unwrap_or("functions").len())
            .saturating_add(input.len()),
        ResponseItem::FunctionCallOutput {
            call_id, output, ..
        } => output_bytes(output).saturating_add(call_id.len()),
        ResponseItem::CustomToolCallOutput {
            call_id,
            name,
            output,
            ..
        } => output_bytes(output)
            .saturating_add(call_id.len())
            .saturating_add(name.as_deref().unwrap_or_default().len()),
        ResponseItem::AdditionalTools { tools, .. } => json_bytes(tools),
        ResponseItem::ToolSearchCall { arguments, .. } => json_bytes(arguments),
        ResponseItem::ToolSearchOutput { tools, .. } => json_bytes(tools),
        ResponseItem::LocalShellCall { action, .. } => json_bytes(action),
        ResponseItem::WebSearchCall { action, .. } => action.as_ref().map_or(0, json_bytes),
        ResponseItem::ImageGenerationCall {
            revised_prompt,
            result,
            ..
        } => revised_prompt
            .as_deref()
            .unwrap_or_default()
            .len()
            .saturating_add(if result.is_empty() {
                0
            } else {
                RESIZED_IMAGE_BYTES_ESTIMATE
            }),
        ResponseItem::Reasoning {
            encrypted_content: None,
            ..
        }
        | ResponseItem::ContextCompaction {
            encrypted_content: None,
            ..
        }
        | ResponseItem::ConfigurationUpdate { .. }
        | ResponseItem::CompactionTrigger { .. }
        | ResponseItem::Other(_) => 0,
    }
}
fn json_bytes(value: &(impl serde::Serialize + ?Sized)) -> usize {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len())
}
fn image_bytes(url: &str, detail: Option<ImageDetail>) -> usize {
    if detail == Some(ImageDetail::Original) {
        original_image_bytes_estimate(url).unwrap_or(RESIZED_IMAGE_BYTES_ESTIMATE)
    } else {
        RESIZED_IMAGE_BYTES_ESTIMATE
    }
}
fn output_bytes(output: &FunctionOutputBody) -> usize {
    match output {
        FunctionOutputBody::Text(text) => text.len(),
        FunctionOutputBody::Content(content) => content
            .iter()
            .map(|part| match part {
                FunctionOutputContent::InputText { text } => text.len(),
                FunctionOutputContent::InputImage { image_url, detail } => {
                    image_bytes(image_url, *detail)
                }
                FunctionOutputContent::InputImageFile { .. } => RESIZED_IMAGE_BYTES_ESTIMATE,
                FunctionOutputContent::InputAudio { audio_url } => audio_bytes(audio_url),
                FunctionOutputContent::EncryptedContent { encrypted_content } => {
                    encrypted_content.len().saturating_mul(9).div_ceil(16)
                }
            })
            .fold(0, usize::saturating_add),
    }
}
/// Mirrors codex `estimate_audio_bytes`: duration tokens times four bytes.
fn audio_bytes(url: &str) -> usize {
    crate::audio::estimate_audio_token_count(url).saturating_mul(APPROX_BYTES_PER_TOKEN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MessageRole;

    #[test]
    fn text_estimates_ignore_transport_framing_ids_and_json_escaping() {
        let mut item =
            ResponseItem::message(MessageRole::User, [ContentItem::input_text("\"\\\n🙂")]);
        assert_eq!(model_visible_len(&item), 7);
        item.set_id(Some("id-that-does-not-consume-context".into()));
        assert_eq!(estimate_item_tokens(&item), 2);
        assert_eq!(model_visible_len(&ResponseItem::compaction_trigger()), 0);
    }

    #[test]
    fn tool_accounting_includes_model_visible_names_and_arguments() {
        let item: ResponseItem = serde_json::from_value(serde_json::json!({
            "type": "function_call", "call_id": "excluded", "name": "exec", "arguments": "{}"
        }))
        .unwrap();
        assert_eq!(model_visible_len(&item), "execfunctions{}".len());
        let output = ResponseItem::custom_tool_output(
            "call".to_owned(),
            Some("exec".to_owned()),
            FunctionOutputBody::Text("result".into()),
        );
        assert_eq!(model_visible_len(&output), "callexecresult".len());
    }

    #[test]
    fn original_images_require_decoding_and_other_images_have_fixed_cost() {
        assert_eq!(
            image_bytes("https://example.test/image", None),
            RESIZED_IMAGE_BYTES_ESTIMATE
        );
        assert_eq!(
            image_bytes("data:image/png;base64,YQ==", Some(ImageDetail::Original)),
            RESIZED_IMAGE_BYTES_ESTIMATE
        );
    }

    /// Same fixture builder as codex-rs `core/src/context_manager/history_tests.rs`
    /// `pcm_wav_data_url`: 8 kHz, mono, 8-bit PCM with `sample_count` frames.
    fn pcm_wav_data_url(sample_count: u32) -> String {
        use base64::Engine;
        let padding = sample_count % 2;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + sample_count + padding).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8_000u32.to_le_bytes());
        bytes.extend_from_slice(&8_000u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&sample_count.to_le_bytes());
        bytes.resize(bytes.len() + (sample_count + padding) as usize, 0);
        format!(
            "data:audio/wav;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    /// Expected values are codex-rs's own (history_tests.rs):
    /// `audio_data_url_payload_does_not_dominate_{message,function_call_output,
    /// custom_tool_call_output}_estimate` and
    /// `malformed_audio_data_url_falls_back_to_whole_url_size_cost`.
    #[test]
    fn audio_estimates_match_codex_duration_and_fallback_scenarios() {
        let message = |audio_url: String| {
            ResponseItem::message(
                MessageRole::User,
                [ContentItem::InputAudio {
                    audio_url: audio_url.into(),
                }],
            )
        };

        // 801 frames at 8 kHz = 0.100125 s -> ceil(1.00125) = 2 tokens.
        assert_eq!(model_visible_len(&message(pcm_wav_data_url(801))), 2 * 4);
        // 800 frames = 0.1 s -> 1 token, plus the model-visible call id.
        let function_output: ResponseItem = serde_json::from_value(serde_json::json!({
            "type": "function_call_output",
            "call_id": "call-audio",
            "output": [{ "type": "input_audio", "audio_url": pcm_wav_data_url(800) }],
        }))
        .unwrap();
        assert_eq!(model_visible_len(&function_output), "call-audio".len() + 4);
        // 80 000 frames = 10 s -> 100 tokens.
        let custom = ResponseItem::custom_tool_output(
            "call-custom-audio".to_owned(),
            None,
            FunctionOutputBody::Content(vec![FunctionOutputContent::InputAudio {
                audio_url: pcm_wav_data_url(80_000).into(),
            }]),
        );
        assert_eq!(model_visible_len(&custom), "call-custom-audio".len() + 400);

        // Undecodable, remote, unsupported and non-base64 audio all charge
        // ceil(url.len() / 4) tokens for the whole URL.
        for url in [
            format!("data:audio/wav;base64,{}", "A".repeat(100_000)),
            "https://example.test/clip.mp3".to_owned(),
            "data:audio/flac;base64,ZkxhQw==".to_owned(),
            "data:audio/wav,not-base64".to_owned(),
        ] {
            let fallback = url.len().div_ceil(4) * 4;
            assert_eq!(model_visible_len(&message(url)), fallback);
        }
    }
    #[test]
    fn file_image_context_cost_is_independent_of_identifier_and_detail() {
        for detail in [None, Some(ImageDetail::Original), Some(ImageDetail::High)] {
            for file_id in ["file-a".to_owned(), "x".repeat(512)] {
                let message = ResponseItem::message(
                    MessageRole::User,
                    [ContentItem::InputImageFile {
                        file_id: file_id.clone().into(),
                        detail,
                    }],
                );
                assert_eq!(model_visible_len(&message), RESIZED_IMAGE_BYTES_ESTIMATE);
                let output = ResponseItem::custom_tool_output(
                    "c".to_owned(),
                    None,
                    FunctionOutputBody::Content(vec![FunctionOutputContent::InputImageFile {
                        file_id: file_id.into(),
                        detail,
                    }]),
                );
                assert_eq!(model_visible_len(&output), RESIZED_IMAGE_BYTES_ESTIMATE + 1);
            }
        }
    }
}
