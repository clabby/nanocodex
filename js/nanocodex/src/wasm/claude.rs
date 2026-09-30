//! Explicit Claude embedding. No Codex model catalog or ambient tools are installed.
//!
//! `create` accepts camelCase JSON: model (required), apiKey OR authHostId,
//! sessionId (optional; durable IDs must match durabilityId), endpoint,
//! subscriptionCompatibility, hostDefinitionId (required with tools),
//! tools (native Claude definitions), serverTools, maxTokens, thinking (effort),
//! adaptiveThinking, keepThinking, cache ("off", "5m", "1h"), autoCompact
//! (false rejects unsupported disabling, true keeps backend policy),
//! autoCompactWindowTokens, contextWindowTokens, instructions, systemBlocks,
//! workspace, parallelTools, clientToolSearch, durabilityHostId, durabilityId,
//! terminalReceiptRetention. Credentials never enter a checkpoint.
//!
//! Host contracts: claudeAuth(authHostId) -> Promise<JSON header map string>;
//! executeClaudeTool(hostDefinitionId, name, inputJson, sessionId, callId, model,
//! turnId) -> Promise<JSON {content: string | block[], isError?: boolean,
//! metadata?: value, structuredResult?: value}>. Host errors are redacted.

use super::{
    Cell, DurableAgentExt, JavaScriptDurabilityStore, JsFuture, JsValue, Prompt, Rc, RefCell,
    RustNanocodex, TurnState, WasmTurn, forward_events, js_error, validate_operation_id,
};
use nanocodex_claude::{
    Claude, ClaudeAuthFuture, ClaudeAuthProvider, ClaudeAuthUnavailable, ClaudeClient,
    ClaudeToolInvocation, ClaudeToolReply, Effort, ServerToolDefinition, ToolDefinition,
    ToolResultContent,
};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, rc::Weak, sync::Arc};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = claudeAuth)]
    fn host_claude_auth(auth_host_id: u32) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = executeClaudeTool)]
    fn host_execute_claude_tool(
        host_definition_id: u32,
        name: &str,
        input: &str,
        session_id: &str,
        call_id: &str,
        model: &str,
        turn_id: &str,
    ) -> Result<js_sys::Promise, JsValue>;
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ClaudeConfig {
    model: String,
    session_id: Option<String>,
    api_key: Option<String>,
    auth_host_id: Option<u32>,
    endpoint: Option<String>,
    #[serde(default)]
    subscription_compatibility: bool,
    host_definition_id: Option<u32>,
    #[serde(default)]
    tools: Vec<ToolDefinition>,
    #[serde(default)]
    server_tools: Vec<ServerToolDefinition>,
    max_tokens: Option<u32>,
    thinking: Option<Effort>,
    #[serde(default)]
    adaptive_thinking: bool,
    #[serde(default)]
    keep_thinking: bool,
    #[serde(default)]
    cache: CachePolicy,
    auto_compact: Option<bool>,
    auto_compact_window_tokens: Option<u64>,
    context_window_tokens: Option<u64>,
    instructions: Option<String>,
    system_blocks: Option<Vec<Value>>,
    workspace: Option<String>,
    #[serde(default)]
    parallel_tools: bool,
    #[serde(default)]
    client_tool_search: bool,
    durability_host_id: Option<String>,
    durability_id: Option<String>,
    terminal_receipt_retention: Option<usize>,
}

#[derive(Default, Deserialize)]
enum CachePolicy {
    #[default]
    #[serde(rename = "off")]
    Off,
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "1h")]
    OneHour,
}

impl ClaudeConfig {
    fn validate(&self) -> Result<(), &'static str> {
        if self.model.trim().is_empty() {
            return Err("Claude model must not be empty");
        }
        if self
            .session_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty())
        {
            return Err("sessionId must not be empty");
        }
        if let (Some(session_id), Some(durability_id)) = (&self.session_id, &self.durability_id)
            && session_id != durability_id
        {
            return Err("durable Claude sessionId must equal durabilityId");
        }
        match (&self.api_key, self.auth_host_id) {
            (Some(key), None) if !key.trim().is_empty() => {}
            (None, Some(_)) => {}
            _ => return Err("supply exactly one nonempty apiKey or authHostId"),
        }
        if !self.tools.is_empty() && self.host_definition_id.is_none() {
            return Err("explicit Claude tools require hostDefinitionId");
        }
        if self.instructions.is_some() && self.system_blocks.is_some() {
            return Err("instructions and systemBlocks are mutually exclusive");
        }
        if self.auto_compact == Some(false) {
            return Err("disabling Claude automatic compaction is unsupported by this backend");
        }
        if self.max_tokens == Some(0)
            || self.context_window_tokens == Some(0)
            || self.auto_compact_window_tokens == Some(0)
        {
            return Err("Claude token limits must be positive");
        }
        match (&self.durability_host_id, &self.durability_id) {
            (None, None) => {
                if self.terminal_receipt_retention.is_some() {
                    return Err("terminalReceiptRetention requires durability");
                }
            }
            (Some(host), Some(id)) if !host.trim().is_empty() && !id.trim().is_empty() => {}
            _ => {
                return Err(
                    "durabilityHostId and durabilityId must be nonempty and supplied together",
                );
            }
        }
        if self
            .terminal_receipt_retention
            .is_some_and(|limit| limit > 4_096)
        {
            return Err("terminalReceiptRetention must be from 0 through 4096");
        }
        if self.endpoint.as_ref().is_some_and(|endpoint| {
            reqwest::Url::parse(endpoint).map_or(true, |url| {
                !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.fragment().is_some()
            })
        }) {
            return Err(
                "endpoint must be an explicit HTTP(S) Messages URL without userinfo or fragment",
            );
        }
        Ok(())
    }
}

struct JavaScriptClaudeAuth {
    auth_host_id: u32,
}

impl ClaudeAuthProvider for JavaScriptClaudeAuth {
    fn headers(
        &self,
    ) -> ClaudeAuthFuture<'_, Result<reqwest::header::HeaderMap, ClaudeAuthUnavailable>> {
        Box::pin(async move {
            let promise = host_claude_auth(self.auth_host_id).map_err(|_| ClaudeAuthUnavailable)?;
            let result = JsFuture::from(promise)
                .await
                .map_err(|_| ClaudeAuthUnavailable)?;
            let encoded = result.as_string().ok_or(ClaudeAuthUnavailable)?;
            let headers: BTreeMap<String, String> =
                serde_json::from_str(&encoded).map_err(|_| ClaudeAuthUnavailable)?;
            if headers.is_empty() {
                return Err(ClaudeAuthUnavailable);
            }
            let mut output = reqwest::header::HeaderMap::new();
            for (name, value) in headers {
                let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| ClaudeAuthUnavailable)?;
                let mut value = reqwest::header::HeaderValue::from_str(&value)
                    .map_err(|_| ClaudeAuthUnavailable)?;
                value.set_sensitive(true);
                output.insert(name, value);
            }
            Ok(output)
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HostToolReply {
    content: ToolResultContent,
    #[serde(default)]
    is_error: bool,
    metadata: Option<Value>,
    structured_result: Option<Value>,
}

async fn execute_tool(
    host_definition_id: u32,
    name: &str,
    input: Value,
    invocation: ClaudeToolInvocation,
) -> Result<ClaudeToolReply, String> {
    let promise = host_execute_claude_tool(
        host_definition_id,
        name,
        &input.to_string(),
        &invocation.session_id,
        &invocation.call_id,
        &invocation.model,
        &invocation.turn_id,
    )
    .map_err(|_| "Claude tool host rejected invocation".to_owned())?;
    let response = JsFuture::from(promise)
        .await
        .map_err(|_| "Claude tool host invocation failed".to_owned())?;
    let response = response
        .as_string()
        .ok_or_else(|| "Claude tool host must return a JSON string".to_owned())?;
    let reply: HostToolReply = serde_json::from_str(&response)
        .map_err(|_| "Claude tool host returned an invalid Claude reply".to_owned())?;
    Ok(ClaudeToolReply {
        content: reply.content,
        is_error: reply.is_error,
        metadata: reply.metadata,
        structured_result: reply.structured_result,
    })
}

/// Opt-in Claude-native WASM lifecycle. Authentication remains host-owned.
#[wasm_bindgen(js_name = Nanoclaude)]
pub struct WasmNanoclaude {
    inner: RustNanocodex,
    event_forwarding: Rc<Cell<bool>>,
    turns: RefCell<Vec<Weak<RefCell<TurnState>>>>,
}

#[wasm_bindgen(js_class = Nanoclaude)]
impl WasmNanoclaude {
    /// Creates only explicitly supplied Claude capabilities.
    pub async fn create(config_json: &str) -> Result<Self, JsValue> {
        // Serde errors can include caller-supplied strings; do not echo config secrets.
        let config: ClaudeConfig = serde_json::from_str(config_json)
            .map_err(|_| js_error("invalid Nanoclaude configuration"))?;
        config.validate().map_err(js_error)?;
        let endpoint = config.endpoint.unwrap_or_else(|| {
            if config.subscription_compatibility {
                nanocodex_claude::ANTHROPIC_SUBSCRIPTION_MESSAGES_URL.to_owned()
            } else {
                nanocodex_claude::ANTHROPIC_MESSAGES_URL.to_owned()
            }
        });
        let http = reqwest::Client::new();
        let mut client = match (config.api_key, config.auth_host_id) {
            (Some(key), None) => ClaudeClient::new(http, endpoint, key),
            (None, Some(auth_host_id)) => ClaudeClient::with_auth_provider(
                http,
                endpoint,
                Arc::new(JavaScriptClaudeAuth { auth_host_id }),
            ),
            _ => return Err(js_error("invalid explicit Claude authentication")),
        };
        if config.subscription_compatibility {
            client = client.subscription_compatibility();
        }
        let mut builder = RustNanocodex::builder(Claude::new(client, config.model))
            .parallel_tools(config.parallel_tools);
        if let Some(session_id) = config.session_id {
            builder = builder.session_id(session_id);
        }
        if let Some(tokens) = config.max_tokens {
            builder = builder.max_tokens(tokens);
        }
        if let Some(effort) = config.thinking {
            builder = builder.effort(effort);
        }
        if config.adaptive_thinking {
            builder = builder.adaptive_thinking();
        }
        if config.keep_thinking {
            builder = builder.keep_thinking();
        }
        builder = match config.cache {
            CachePolicy::Off => builder,
            CachePolicy::FiveMinutes => builder.automatic_cache(true),
            CachePolicy::OneHour => builder.cache_one_hour(),
        };
        if let Some(tokens) = config.context_window_tokens {
            builder = builder.context_window_tokens(tokens);
        }
        if let Some(tokens) = config.auto_compact_window_tokens {
            builder = builder.auto_compact_window_tokens(tokens);
        }
        if let Some(instructions) = config.instructions {
            builder = builder.system(instructions);
        }
        if let Some(blocks) = config.system_blocks {
            builder = builder.system_blocks(blocks);
        }
        if let Some(workspace) = config.workspace {
            builder = builder.workspace(workspace);
        }
        if config.client_tool_search {
            builder = builder.client_tool_search();
        }
        for definition in config.tools {
            let host_id = config
                .host_definition_id
                .ok_or_else(|| js_error("explicit Claude tools require hostDefinitionId"))?;
            let name = definition.name.clone();
            builder = builder.tool_with_context(definition, move |input, invocation| {
                let name = name.clone();
                async move { execute_tool(host_id, &name, input, invocation).await }
            });
        }
        for definition in config.server_tools {
            builder = builder.server_tool(definition);
        }
        if let (Some(route_id), Some(state_id)) = (config.durability_host_id, config.durability_id)
        {
            let store = JavaScriptDurabilityStore { route_id };
            let durable = if let Some(limit) = config.terminal_receipt_retention {
                nanocodex::agent::durability::DurableSession::open_with_terminal_receipt_limit(
                    store, state_id, limit,
                )
                .await
            } else {
                nanocodex::agent::durability::DurableSession::open(store, state_id).await
            }
            .map_err(js_error)?;
            builder = builder.durability(durable).await.map_err(js_error)?;
        }
        let (inner, events) = builder.build().map_err(js_error)?;
        let event_forwarding = Rc::new(Cell::new(false));
        forward_events(events, Rc::clone(&event_forwarding));
        Ok(Self {
            inner,
            event_forwarding,
            turns: RefCell::new(Vec::new()),
        })
    }

    #[wasm_bindgen(getter, js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id().to_owned()
    }

    #[wasm_bindgen(getter, js_name = agentId)]
    pub fn agent_id(&self) -> String {
        self.inner.agent_id().to_owned()
    }

    #[wasm_bindgen(js_name = setEventForwarding)]
    pub fn set_event_forwarding(&self, enabled: bool) {
        self.event_forwarding.set(enabled);
    }

    /// Accepts text using the shared Turn/TurnResult and durable request-ID path.
    pub fn prompt(
        &self,
        input: &str,
        request_id: Option<String>,
        cancel_on_admission: Option<bool>,
    ) -> Result<WasmTurn, JsValue> {
        validate_operation_id(request_id.as_deref())?;
        if input.trim().is_empty() {
            return Err(js_error("prompt input must not be empty"));
        }
        let turn = WasmTurn::accept(
            self.inner.clone(),
            Prompt::new(input),
            request_id,
            cancel_on_admission.unwrap_or(false),
        );
        let mut turns = self.turns.borrow_mut();
        turns.retain(|turn| {
            turn.upgrade()
                .is_some_and(|state| state.borrow().completed.is_none())
        });
        turns.push(Rc::downgrade(&turn.state));
        Ok(turn)
    }

    pub async fn compact(&self) -> Result<(), JsValue> {
        self.inner.compact().await.map_err(js_error)
    }

    /// Cancels nonterminal prompts issued by this handle (not an in-flight compact).
    pub async fn cancel(&self) -> Result<(), JsValue> {
        let pending: Vec<_> = self
            .turns
            .borrow()
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|state| state.borrow().completed.is_none())
            .collect();
        for state in pending {
            let turn = WasmTurn { state };
            match turn.control().await {
                Ok(control) => control.cancel().await.map_err(js_error)?,
                Err(error) if turn.state.borrow().completed.is_none() => {
                    return Err(js_error(error));
                }
                Err(_) => {} // Completion can race cancellation.
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), JsValue> {
        self.inner.shutdown().await.map_err(js_error)?;
        self.event_forwarding.set(false);
        Ok(())
    }

    /// Claude checkpoints are stored natively by durability, not OpenAI snapshots.
    pub fn snapshot(&self) -> Result<String, JsValue> {
        Err(js_error(
            "Claude snapshot export is unsupported; reopen the configured durabilityId",
        ))
    }

    pub fn checkpoint(&self) -> Result<String, JsValue> {
        Err(js_error(
            "Claude checkpoint export is unsupported; checkpoints are managed by durability",
        ))
    }
}

impl Drop for WasmNanoclaude {
    fn drop(&mut self) {
        self.event_forwarding.set(false);
    }
}
