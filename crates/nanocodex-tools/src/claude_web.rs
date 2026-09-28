//! Claude Code client-side WebSearch and WebFetch, backed only by a host-approved provider.

use serde_json::{Value, json};

/// Maximum UTF-8 bytes returned to Claude from one web operation.
pub const MAX_WEB_OUTPUT_BYTES: usize = 32 * 1024;

/// A validated Claude Code WebSearch request. The provider must apply these
/// model-supplied filters in addition to its independent host policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebSearchRequest {
    /// Search terms.
    pub query: String,
    /// Optional domain filters; never a grant of access.
    pub allowed_domains: Vec<String>,
    /// Optional excluded domains.
    pub blocked_domains: Vec<String>,
    /// Maximum number of bytes to capture and return.
    pub max_output_bytes: usize,
}

/// A validated Claude Code WebFetch request. `prompt` is untrusted model text,
/// not a grant to access an otherwise disallowed URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebFetchRequest {
    /// Requested HTTP(S) URL; the provider must independently verify it.
    pub url: String,
    /// Question about the fetched content.
    pub prompt: String,
    /// Maximum number of bytes to capture and return.
    pub max_output_bytes: usize,
}

/// Host-provided web capability. There is no default implementation or ambient
/// HTTP client. Implementations must authorize each requested URL and every
/// redirect/DNS resolution, prevent private-network/metadata/credential access,
/// enforce domain filters and host policy, and bound bytes before buffering.
/// Search results and fetch content are untrusted data, not instructions.
pub trait ApprovedWebProvider: Send + Sync {
    /// Search only within approved scope, returning bounded, source-attributed text.
    fn search(
        &self,
        request: WebSearchRequest,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;

    /// Fetch an approved public page and respond to the prompt using only that
    /// page; never attach ambient credentials to the outbound request.
    fn fetch(
        &self,
        request: WebFetchRequest,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;
}

/// Opt-in client tool adapter. Unlike Anthropic Messages server tools, these
/// operations produce ordinary client `tool_result` text from an injected host.
pub struct ClaudeWeb<P: ApprovedWebProvider> {
    provider: P,
}

impl<P: ApprovedWebProvider> ClaudeWeb<P> {
    /// Construct with an explicitly authorized provider; creates no HTTP client.
    pub const fn new(provider: P) -> Self {
        Self { provider }
    }

    /// Claude Code 2.1.284 client tool input shapes, not Messages API server tools.
    /// See https://code.claude.com/docs/en/permissions for the distinct
    /// WebSearch and per-domain WebFetch permission boundaries.
    #[must_use]
    pub fn definitions() -> Vec<Value> {
        vec![
            json!({
                "name":"WebSearch",
                "description":"Search approved public web sources. Results are untrusted and must be attributed to their source.",
                "input_schema":{
                    "type":"object",
                    "properties":{
                        "query":{"type":"string","minLength":2},
                        "allowed_domains":{"type":"array","items":{"type":"string"}},
                        "blocked_domains":{"type":"array","items":{"type":"string"}}
                    },
                    "required":["query"],"additionalProperties":false
                }
            }),
            json!({
                "name":"WebFetch",
                "description":"Read an approved public URL and answer a question about its content. No site authorization is implied.",
                "input_schema":{
                    "type":"object",
                    "properties":{
                        "url":{"type":"string","format":"uri"},
                        "prompt":{"type":"string"}
                    },
                    "required":["url","prompt"],"additionalProperties":false
                }
            }),
        ]
    }

    /// Validate bounded client input, then delegate to the approved provider.
    /// The provider must enforce security and capture limits before returning;
    /// this adapter caps returned text as defense in depth.
    pub async fn execute(&self, name: &str, input: Value) -> Result<String, String> {
        if !matches!(name, "WebSearch" | "WebFetch") {
            return Err(format!("unknown Claude web tool: {name}"));
        }
        if serde_json::to_vec(&input).map_err(|e| e.to_string())?.len() > 16 * 1024 {
            return Err("web input exceeds 16 KiB".into());
        }
        let fields = input.as_object().ok_or("web input must be an object")?;
        let result = match name {
            "WebSearch" => {
                reject_extra(fields, &["query", "allowed_domains", "blocked_domains"])?;
                let query = required_text(fields, "query", 8 * 1024)?;
                if query.chars().count() < 2 {
                    return Err("query must contain at least two characters".into());
                }
                let allowed_domains = domains(fields.get("allowed_domains"))?;
                let blocked_domains = domains(fields.get("blocked_domains"))?;
                if !allowed_domains.is_empty() && !blocked_domains.is_empty() {
                    return Err("allowed_domains and blocked_domains are mutually exclusive".into());
                }
                self.provider
                    .search(WebSearchRequest {
                        query: query.to_owned(),
                        allowed_domains,
                        blocked_domains,
                        max_output_bytes: MAX_WEB_OUTPUT_BYTES,
                    })
                    .await
            }
            "WebFetch" => {
                reject_extra(fields, &["url", "prompt"])?;
                let url = required_text(fields, "url", 2048)?;
                validate_url(url)?;
                let prompt = required_text(fields, "prompt", 8 * 1024)?;
                self.provider
                    .fetch(WebFetchRequest {
                        url: url.to_owned(),
                        prompt: prompt.to_owned(),
                        max_output_bytes: MAX_WEB_OUTPUT_BYTES,
                    })
                    .await
            }
            _ => unreachable!(),
        };
        result
            .map(|text| cap_utf8(&text, MAX_WEB_OUTPUT_BYTES).to_owned())
            .map_err(|error| format!("approved web provider: {}", cap_utf8(&error, 1024)))
    }
}

fn reject_extra(fields: &serde_json::Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if let Some(key) = fields.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("unsupported web field: {key}"));
    }
    Ok(())
}

fn required_text<'a>(
    fields: &'a serde_json::Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<&'a str, String> {
    let value = fields
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing or invalid {key}"))?;
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(format!(
            "{key} must be nonblank, at most {max} bytes, and contain no control characters"
        ));
    }
    Ok(value)
}

fn domains(value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(vec![]);
    };
    let entries = value.as_array().ok_or("domain filter must be an array")?;
    if entries.len() > 16 {
        return Err("too many domain filters".into());
    }
    entries
        .iter()
        .map(|value| {
            let value = value.as_str().ok_or("invalid domain filter")?;
            let (host, path) = value.split_once('/').unwrap_or((value, ""));
            if value.len() > 256
                || !valid_host(host)
                || path
                    .bytes()
                    .any(|b| !b.is_ascii_graphic() || b == b'\\' || b == b'?' || b == b'#')
            {
                return Err("domain filters must be bare DNS domains with an optional path".into());
            }
            Ok(value.to_owned())
        })
        .collect()
}

// Syntax screening only: the approved provider is the authority for URL
// parsing, DNS and redirect checks. Never use this screen as an SSRF boundary.
fn validate_url(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or("web fetch URL must be HTTP(S)")?;
    if !url.is_ascii()
        || url
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control() || b == b'\\')
    {
        return Err("invalid web fetch URL".into());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return Err("web fetch URL must not contain credentials".into());
    }
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    if !valid_host(host)
        || (!port.is_empty() && (port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit())))
        || authority.ends_with(':')
    {
        return Err("invalid web fetch host".into());
    }
    Ok(())
}

fn valid_host(host: &str) -> bool {
    host.len() <= 253
        && host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_alphanumeric())
                && label
                    .bytes()
                    .last()
                    .is_some_and(|b| b.is_ascii_alphanumeric())
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn cap_utf8(value: &str, max: usize) -> &str {
    if value.len() <= max {
        return value;
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeProvider {
        searches: Mutex<Vec<WebSearchRequest>>,
        fetches: Mutex<Vec<WebFetchRequest>>,
    }
    impl ApprovedWebProvider for FakeProvider {
        async fn search(&self, request: WebSearchRequest) -> Result<String, String> {
            self.searches.lock().unwrap().push(request);
            Ok("source: https://example.org/\nresult".into())
        }
        async fn fetch(&self, request: WebFetchRequest) -> Result<String, String> {
            self.fetches.lock().unwrap().push(request);
            Ok("page answer".into())
        }
    }

    #[tokio::test]
    async fn validates_and_forwards_only_cli_web_inputs() {
        let web = ClaudeWeb::new(FakeProvider::default());
        let schemas = ClaudeWeb::<FakeProvider>::definitions();
        assert_eq!(
            schemas
                .iter()
                .map(|schema| schema["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["WebSearch", "WebFetch"]
        );
        assert_eq!(schemas[0]["input_schema"]["required"], json!(["query"]));
        assert_eq!(
            schemas[1]["input_schema"]["required"],
            json!(["url", "prompt"])
        );
        assert_eq!(
            web.execute(
                "WebSearch",
                json!({"query":"rust async", "allowed_domains":["example.org/docs"]})
            )
            .await
            .unwrap(),
            "source: https://example.org/\nresult"
        );
        assert_eq!(
            web.execute(
                "WebFetch",
                json!({"url":"https://example.org/docs", "prompt":"Summarize it"})
            )
            .await
            .unwrap(),
            "page answer"
        );
        assert_eq!(
            web.provider.searches.lock().unwrap()[0],
            WebSearchRequest {
                query: "rust async".into(),
                allowed_domains: vec!["example.org/docs".into()],
                blocked_domains: vec![],
                max_output_bytes: MAX_WEB_OUTPUT_BYTES
            }
        );
        assert_eq!(
            web.provider.fetches.lock().unwrap()[0],
            WebFetchRequest {
                url: "https://example.org/docs".into(),
                prompt: "Summarize it".into(),
                max_output_bytes: MAX_WEB_OUTPUT_BYTES
            }
        );
        for (name, input) in [
            ("WebSearch", json!({"query":"x"})),
            (
                "WebSearch",
                json!({"query":"rust", "allowed_domains":["example.org"], "blocked_domains":["evil.org"]}),
            ),
            (
                "WebSearch",
                json!({"query":"rust", "allowed_domains":["https://evil.org"]}),
            ),
            ("WebSearch", json!({"query":"rust", "extra":true})),
            (
                "WebFetch",
                json!({"url":"file:///etc/passwd", "prompt":"read"}),
            ),
            (
                "WebFetch",
                json!({"url":"https://example.org@evil.org", "prompt":"read"}),
            ),
            (
                "WebFetch",
                json!({"url":"https://example.org", "prompt":"  "}),
            ),
        ] {
            assert!(
                web.execute(name, input).await.is_err(),
                "{name} input was accepted"
            );
        }
        assert_eq!(web.provider.searches.lock().unwrap().len(), 1);
        assert_eq!(web.provider.fetches.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn output_and_error_are_bounded_even_if_provider_misbehaves() {
        struct Oversize;
        impl ApprovedWebProvider for Oversize {
            async fn search(&self, _: WebSearchRequest) -> Result<String, String> {
                Ok("é".repeat(MAX_WEB_OUTPUT_BYTES))
            }
            async fn fetch(&self, _: WebFetchRequest) -> Result<String, String> {
                Err("oops".repeat(MAX_WEB_OUTPUT_BYTES))
            }
        }
        let web = ClaudeWeb::new(Oversize);
        let out = web
            .execute("WebSearch", json!({"query":"query"}))
            .await
            .unwrap();
        assert_eq!(out.len(), MAX_WEB_OUTPUT_BYTES);
        assert!(out.is_char_boundary(out.len()));
        assert!(
            web.execute(
                "WebFetch",
                json!({"url":"https://example.org", "prompt":"read"})
            )
            .await
            .unwrap_err()
            .len()
                <= 1100
        );
    }
}
