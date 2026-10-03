//! Strict, opaque image references shared by edit requests and input content.
use serde::{Deserialize, Serialize};

/// Whether a provider file ID is a bounded, opaque ASCII identifier.
#[must_use]
pub fn valid_image_file_id(file_id: &str) -> bool {
    !file_id.is_empty()
        && file_id.len() <= 512
        && file_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub(crate) fn serialize_file_id<S: serde::Serializer>(
    file_id: &str,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    if !valid_image_file_id(file_id) {
        return Err(serde::ser::Error::custom("invalid image file_id"));
    }
    serializer.serialize_str(file_id)
}

/// Exactly one inline image URL or opaque provider file identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ImageReference {
    /// Existing inline/URL image representation.
    Inline {
        /// Inline data URL or provider-supported image URL.
        image_url: String,
    },
    /// Opaque uploaded file; not a URL or local filesystem path.
    File {
        /// Nonempty ASCII letters, digits, underscores or hyphens, at most 512 bytes.
        #[serde(serialize_with = "serialize_file_id")]
        file_id: String,
    },
}
impl<'de> Deserialize<'de> for ImageReference {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Inline(Inline),
            File(File),
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Inline {
            image_url: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct File {
            file_id: String,
        }
        match Wire::deserialize(deserializer)? {
            Wire::Inline(Inline { image_url }) => Ok(Self::Inline { image_url }),
            Wire::File(File { file_id }) if valid_image_file_id(&file_id) => {
                Ok(Self::File { file_id })
            }
            Wire::File(_) => Err(serde::de::Error::custom("invalid image file_id")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContentItem, FunctionOutputContent, ImageDetail, tools::ToolOutputContent};
    use serde_json::json;

    #[test]
    fn file_id_validation_is_bounded_ascii_and_opaque() {
        for id in ["file-abc_123", "A", &"x".repeat(512)] {
            assert!(valid_image_file_id(id));
        }
        for id in [
            "",
            "file/abc",
            "file.abc",
            "a b",
            "é",
            "https://example.test/a",
            &"x".repeat(513),
        ] {
            assert!(!valid_image_file_id(id), "{id}");
        }
    }

    #[test]
    fn image_references_have_strict_exclusive_object_forms() {
        for value in [
            json!({"image_url":"data:image/png;base64,YQ=="}),
            json!({"file_id":"file-abc_123"}),
        ] {
            let reference: ImageReference = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(reference).unwrap(), value);
        }
        for value in [
            json!({}),
            json!({"image_url":"x","file_id":"file-abc"}),
            json!({"file_id":""}),
            json!({"file_id":null}),
            json!({"file_id":"file/abc"}),
            json!({"file_id":"file-a","extra":1}),
            json!({"image_url":"x","file_id":null}),
        ] {
            assert!(
                serde_json::from_value::<ImageReference>(value.clone()).is_err(),
                "{value}"
            );
        }
        assert!(
            serde_json::to_value(ImageReference::File {
                file_id: "invalid/id".into()
            })
            .is_err()
        );
    }

    #[test]
    fn inline_compatibility_and_file_images_roundtrip_all_content_types() {
        for value in [
            json!({"type":"input_image","image_url":"data:image/png;base64,YQ==","detail":"original"}),
            json!({"type":"input_image","file_id":"file-abc_123","detail":"original"}),
        ] {
            let content: ContentItem = serde_json::from_value(value.clone()).unwrap();
            let function: FunctionOutputContent = serde_json::from_value(value.clone()).unwrap();
            let tool: ToolOutputContent = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(content).unwrap(), value);
            assert_eq!(serde_json::to_value(function).unwrap(), value);
            assert_eq!(serde_json::to_value(tool).unwrap(), value);
        }
        assert_eq!(
            serde_json::to_value(ContentItem::input_image("url")).unwrap(),
            json!({"type":"input_image","image_url":"url"})
        );
        let content: ContentItem =
            serde_json::from_value(json!({"type":"input_image","file_id":"file-a"})).unwrap();
        assert!(matches!(
            content,
            ContentItem::InputImageFile { detail: None, .. }
        ));
        assert!(matches!(
            serde_json::from_value::<ContentItem>(json!({"type":"input_text","text":"x"})).unwrap(),
            ContentItem::InputText { .. }
        ));
        assert!(
            serde_json::to_value(ToolOutputContent::InputImageFile {
                file_id: "bad/id".into(),
                detail: ImageDetail::High
            })
            .is_err()
        );
    }

    #[test]
    fn malformed_input_image_refs_are_rejected_at_each_wire_boundary() {
        for fields in [
            json!({}),
            json!({"image_url":"x","file_id":"file-a"}),
            json!({"image_url":"x","file_id":null}),
            json!({"file_id":""}),
            json!({"file_id":"é"}),
            json!({"file_id":"x".repeat(513)}),
            json!({"file_id":123}),
        ] {
            let mut value = fields;
            value["type"] = json!("input_image");
            value["detail"] = json!("high");
            assert!(
                serde_json::from_value::<ContentItem>(value.clone()).is_err(),
                "{value}"
            );
            assert!(
                serde_json::from_value::<FunctionOutputContent>(value.clone()).is_err(),
                "{value}"
            );
            assert!(
                serde_json::from_value::<ToolOutputContent>(value.clone()).is_err(),
                "{value}"
            );
        }
    }
}
