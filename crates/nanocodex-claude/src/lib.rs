//! Claude-native Messages protocol and an experimental agent-loop backend.
//!
//! Authentication is supplied by the embedding application (Console API key or
//! explicitly approved headers). The crate never reads Claude Code credentials.
use std::collections::BTreeMap;

use futures_util::{Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Error)]
pub enum ClaudeError {
    #[error("Messages HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("Messages transport: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("Messages JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Messages stream error {kind}: {message}")]
    StreamError { kind: String, message: String },
    #[error("Messages protocol: {0}")]
    Protocol(String),
    #[error("Messages stream ended before message_stop")]
    IncompleteStream,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
    },
    Thinking {
        thinking: String,
        #[serde(default)]
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
}

fn is_false(value: &bool) -> bool {
    !value
}

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    pub fn tool_use(id: impl Into<String>, name: impl Into<String>, input: Value) -> Self {
        Self::ToolUse {
            id: id.into(),
            name: name.into(),
            input,
        }
    }

    pub fn tool_result(id: impl Into<String>, content: impl Into<String>, is_error: bool) -> Self {
        Self::ToolResult {
            tool_use_id: id.into(),
            content: content.into(),
            is_error,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

impl Message {
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        Self {
            role,
            content: vec![ContentBlock::text(text)],
        }
    }

    pub const fn tool_results(content: Vec<ContentBlock>) -> Self {
        Self {
            role: Role::User,
            content,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MessagesRequest {
    pub model: String,
    pub max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    StopSequence,
    ToolUse,
    PauseTurn,
    Refusal,
    ModelContextWindowExceeded,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct MessageResponse {
    pub id: String,
    pub role: Role,
    pub model: String,
    pub content: Vec<ContentBlock>,
    #[serde(default)]
    pub stop_reason: Option<StopReason>,
    pub usage: Usage,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct UsageDelta {
    pub input_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_creation_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentDelta {
    TextDelta {
        text: String,
    },
    InputJsonDelta {
        partial_json: String,
    },
    ThinkingDelta {
        thinking: String,
    },
    SignatureDelta {
        signature: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ApiError {
    #[serde(rename = "type")]
    pub kind: String,
    pub message: String,
}

/// Raw Messages SSE events, without tool execution or orchestration.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    MessageStart {
        message: MessageResponse,
    },
    ContentBlockStart {
        index: usize,
        content_block: ContentBlock,
    },
    ContentBlockDelta {
        index: usize,
        delta: ContentDelta,
    },
    ContentBlockStop {
        index: usize,
    },
    MessageDelta {
        delta: MessageChange,
        usage: UsageDelta,
    },
    MessageStop,
    Ping,
    Error {
        error: ApiError,
    },
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct MessageChange {
    #[serde(default)]
    pub stop_reason: Option<StopReason>,
}

#[derive(Clone)]
enum ClientAuth {
    ApiKey(String),
    Headers(reqwest::header::HeaderMap),
}

#[derive(Clone)]
pub struct ClaudeClient {
    http: reqwest::Client,
    endpoint: String,
    auth: ClientAuth,
}

impl ClaudeClient {
    /// `endpoint` can be the official Console API URL or an explicitly chosen
    /// compatible endpoint, such as a loopback fixture. The key is never logged.
    pub fn new(
        http: reqwest::Client,
        endpoint: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Self {
        Self {
            http,
            endpoint: endpoint.into(),
            auth: ClientAuth::ApiKey(api_key.into()),
        }
    }

    /// Use authentication headers supplied by the embedding application. This
    /// transport does not infer token schemes, read local credentials, or grant
    /// authority to use a particular endpoint. The caller must select an
    /// approved authentication mechanism and trusted endpoint.
    pub fn with_auth_headers(
        http: reqwest::Client,
        endpoint: impl Into<String>,
        headers: reqwest::header::HeaderMap,
    ) -> Self {
        Self {
            http,
            endpoint: endpoint.into(),
            auth: ClientAuth::Headers(headers),
        }
    }

    pub fn official(http: reqwest::Client, api_key: impl Into<String>) -> Self {
        Self::new(http, ANTHROPIC_MESSAGES_URL, api_key)
    }

    async fn post(
        &self,
        request: &MessagesRequest,
        streaming: bool,
    ) -> Result<reqwest::Response, ClaudeError> {
        #[derive(Serialize)]
        struct Body<'a> {
            #[serde(flatten)]
            request: &'a MessagesRequest,
            stream: bool,
        }
        let builder = self
            .http
            .post(&self.endpoint)
            .header("anthropic-version", ANTHROPIC_VERSION);
        let builder = match &self.auth {
            ClientAuth::ApiKey(key) => builder.header("x-api-key", key),
            ClientAuth::Headers(headers) => builder.headers(headers.clone()),
        };
        let response = builder
            .json(&Body {
                request,
                stream: streaming,
            })
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await?;
            return Err(ClaudeError::Http { status, body });
        }
        Ok(response)
    }

    pub async fn create(&self, request: &MessagesRequest) -> Result<MessageResponse, ClaudeError> {
        Ok(self.post(request, false).await?.json().await?)
    }

    pub async fn stream(&self, request: &MessagesRequest) -> Result<ClaudeStream, ClaudeError> {
        let response = self.post(request, true).await?;
        Ok(Box::pin(stream::unfold(
            SseState::new(response),
            |mut state| async move {
                if state.done {
                    return None;
                }
                loop {
                    let line = match state.pop_line() {
                        Ok(line) => line,
                        Err(error) => {
                            state.done = true;
                            return Some((Err(error), state));
                        }
                    };
                    if let Some(line) = line {
                        if line.is_empty() {
                            if let Some(data) = state.take_data() {
                                let parsed = serde_json::from_str::<StreamEvent>(&data)
                                    .map_err(ClaudeError::from);
                                let event = match parsed {
                                    Ok(StreamEvent::Error { error }) => {
                                        Err(ClaudeError::StreamError {
                                            kind: error.kind,
                                            message: error.message,
                                        })
                                    }
                                    other => other,
                                };
                                match event {
                                    Ok(StreamEvent::Other | StreamEvent::Ping) => continue,
                                    Ok(StreamEvent::MessageStop) => {
                                        state.done = true;
                                        return Some((Ok(StreamEvent::MessageStop), state));
                                    }
                                    Err(error) => {
                                        state.done = true;
                                        return Some((Err(error), state));
                                    }
                                    Ok(event) => return Some((Ok(event), state)),
                                }
                            }
                        } else if let Some(data) = line.strip_prefix("data:") {
                            state
                                .data
                                .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
                        }
                        continue;
                    }
                    match state.response.chunk().await {
                        Ok(Some(chunk)) => {
                            state.bytes.extend_from_slice(&chunk);
                            if state.bytes.len() > 32 * 1024 * 1024 {
                                state.done = true;
                                return Some((
                                    Err(ClaudeError::Protocol("SSE frame exceeds 32 MiB".into())),
                                    state,
                                ));
                            }
                        }
                        Ok(None) => {
                            state.done = true;
                            return Some((Err(ClaudeError::IncompleteStream), state));
                        }
                        Err(error) => {
                            state.done = true;
                            return Some((Err(ClaudeError::Transport(error)), state));
                        }
                    }
                }
            },
        )))
    }
}

pub type ClaudeStream =
    std::pin::Pin<Box<dyn Stream<Item = Result<StreamEvent, ClaudeError>> + Send>>;

struct SseState {
    response: reqwest::Response,
    bytes: Vec<u8>,
    data: Vec<String>,
    done: bool,
}

impl SseState {
    const fn new(response: reqwest::Response) -> Self {
        Self {
            response,
            bytes: Vec::new(),
            data: Vec::new(),
            done: false,
        }
    }

    fn pop_line(&mut self) -> Result<Option<String>, ClaudeError> {
        let Some(index) = self.bytes.iter().position(|byte| *byte == b'\n') else {
            return Ok(None);
        };
        let mut line = self.bytes.drain(..=index).collect::<Vec<_>>();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        // SSE is UTF-8; malformed lines must not be silently altered.
        String::from_utf8(line)
            .map(Some)
            .map_err(|_| ClaudeError::Protocol("invalid UTF-8 SSE line".into()))
    }

    fn take_data(&mut self) -> Option<String> {
        if self.data.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.data).join("\n"))
        }
    }
}

#[derive(Debug)]
enum BlockAccumulator {
    Text(String),
    ToolUse {
        id: String,
        name: String,
        initial: Value,
        fragments: String,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
    Other(ContentBlock),
}

/// Assemble streaming deltas into the same typed response as `create`.
/// A partial tool JSON object or a missing terminal event is never returned as
/// a usable tool call.
pub async fn collect_stream<S>(
    first: StreamEvent,
    mut events: S,
) -> Result<MessageResponse, ClaudeError>
where
    S: Stream<Item = Result<StreamEvent, ClaudeError>> + Unpin,
{
    let StreamEvent::MessageStart { mut message } = first else {
        return Err(ClaudeError::Protocol("expected message_start".into()));
    };
    let mut active = BTreeMap::<usize, BlockAccumulator>::new();
    let mut completed = BTreeMap::<usize, ContentBlock>::new();
    while let Some(event) = events.next().await {
        match event? {
            StreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                if active.contains_key(&index) || completed.contains_key(&index) {
                    return Err(ClaudeError::Protocol(format!(
                        "duplicate content block {index}"
                    )));
                }
                let block = match content_block {
                    ContentBlock::Text { text } => BlockAccumulator::Text(text),
                    ContentBlock::ToolUse { id, name, input } => BlockAccumulator::ToolUse {
                        id,
                        name,
                        initial: input,
                        fragments: String::new(),
                    },
                    ContentBlock::Thinking {
                        thinking,
                        signature,
                    } => BlockAccumulator::Thinking {
                        thinking,
                        signature,
                    },
                    other => BlockAccumulator::Other(other),
                };
                active.insert(index, block);
            }
            StreamEvent::ContentBlockDelta { index, delta } => {
                match (active.get_mut(&index), delta) {
                    (
                        Some(BlockAccumulator::Text(text)),
                        ContentDelta::TextDelta { text: chunk },
                    ) => text.push_str(&chunk),
                    (
                        Some(BlockAccumulator::ToolUse { fragments, .. }),
                        ContentDelta::InputJsonDelta { partial_json },
                    ) => fragments.push_str(&partial_json),
                    (
                        Some(BlockAccumulator::Thinking { thinking, .. }),
                        ContentDelta::ThinkingDelta { thinking: chunk },
                    ) => thinking.push_str(&chunk),
                    (
                        Some(BlockAccumulator::Thinking { signature, .. }),
                        ContentDelta::SignatureDelta { signature: chunk },
                    ) => signature.push_str(&chunk),
                    (Some(_), ContentDelta::Other) => {}
                    _ => {
                        return Err(ClaudeError::Protocol(format!(
                            "unexpected delta for content block {index}"
                        )));
                    }
                }
            }
            StreamEvent::ContentBlockStop { index } => {
                let block = active.remove(&index).ok_or_else(|| {
                    ClaudeError::Protocol(format!("unknown content block {index}"))
                })?;
                let block = match block {
                    BlockAccumulator::Text(text) => ContentBlock::text(text),
                    BlockAccumulator::ToolUse {
                        id,
                        name,
                        initial,
                        fragments,
                    } => {
                        let input = if fragments.is_empty() {
                            initial
                        } else {
                            serde_json::from_str(&fragments)?
                        };
                        ContentBlock::tool_use(id, name, input)
                    }
                    BlockAccumulator::Thinking {
                        thinking,
                        signature,
                    } => ContentBlock::Thinking {
                        thinking,
                        signature,
                    },
                    BlockAccumulator::Other(block) => block,
                };
                completed.insert(index, block);
            }
            StreamEvent::MessageDelta { delta, usage } => {
                if let Some(reason) = delta.stop_reason {
                    message.stop_reason = Some(reason);
                }
                if let Some(input) = usage.input_tokens {
                    message.usage.input_tokens = input;
                }
                if let Some(cached) = usage.cache_read_input_tokens {
                    message.usage.cache_read_input_tokens = cached;
                }
                if let Some(created) = usage.cache_creation_input_tokens {
                    message.usage.cache_creation_input_tokens = created;
                }
                if let Some(output) = usage.output_tokens {
                    message.usage.output_tokens = output;
                }
            }
            StreamEvent::MessageStop => {
                if !active.is_empty() {
                    return Err(ClaudeError::IncompleteStream);
                }
                let count = completed.len();
                if completed.keys().copied().ne(0..count) {
                    return Err(ClaudeError::Protocol(
                        "non-contiguous content block indices".into(),
                    ));
                }
                message.content = completed.into_values().collect();
                return Ok(message);
            }
            StreamEvent::Error { error } => {
                return Err(ClaudeError::StreamError {
                    kind: error.kind,
                    message: error.message,
                });
            }
            StreamEvent::MessageStart { .. } => {
                return Err(ClaudeError::Protocol("duplicate message_start".into()));
            }
            StreamEvent::Ping | StreamEvent::Other => {}
        }
    }
    Err(ClaudeError::IncompleteStream)
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompactedHistory {
    pub messages: Vec<Message>,
    pub summary: String,
    pub dropped_messages: usize,
}

impl CompactedHistory {
    /// Caller-supplied summary, appended to the normal system prompt. This
    /// helper intentionally does not summarize via a model or guess tokens.
    pub fn system_context(&self, system: &str) -> String {
        if self.summary.is_empty() {
            return system.to_owned();
        }
        if system.is_empty() {
            return format!("Conversation summary:\n{}", self.summary);
        }
        format!("{system}\n\nConversation summary:\n{}", self.summary)
    }
}

/// Retain recent messages without severing an assistant tool use and its user
/// tool result. Rewind to the beginning of the containing user turn.
pub fn compact_history(
    history: &[Message],
    keep_recent: usize,
    summary: impl Into<String>,
) -> CompactedHistory {
    let mut start = history.len().saturating_sub(keep_recent);
    if start < history.len() && start > 0 {
        while start > 0 && !is_user_turn_start(&history[start]) {
            start -= 1;
        }
    }
    CompactedHistory {
        messages: history[start..].to_vec(),
        summary: summary.into(),
        dropped_messages: start,
    }
}

fn is_user_turn_start(message: &Message) -> bool {
    message.role == Role::User
        && !message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
}

mod agent;
pub use agent::{Claude, ClaudeBuilder};
