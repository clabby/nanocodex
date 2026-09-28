//! Provider-specific Messages agent loop. No OpenAI transport or CLI credentials.
use crate::{
    ClaudeClient, ClaudeToolSpec, ContentBlock, ContentDelta, Message, MessagesRequest, Role,
    ServerToolDefinition, StopReason, StreamEvent, ToolDefinition, collect_stream,
};
use futures_util::StreamExt;
use nanocodex_agent::{
    AgentEvents, AgentSessionContext, CostStatus, Model, Nanocodex, NanocodexError,
    ReportedTurnUsage, Result, SpawnOptions, Thinking, TurnResult, TurnUsage,
    backend::{
        BackendFuture, BackendPrompt, BackendPromptRoute, BackendRuntime, BackendTurn,
        BackendTurnKey, BuilderBackend, LifecycleBackend,
    },
    events::{AgentEvent, AgentEventKind, AgentEventPublisher},
    input::{Prompt, PromptInput, PromptMessageRole},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::{Mutex, Notify, oneshot};

type Handler = Arc<
    dyn Fn(Value) -> Pin<Box<dyn Future<Output = std::result::Result<String, String>> + Send>>
        + Send
        + Sync,
>;

/// Explicit Claude Messages configuration with caller-owned authentication.
/// Latest documented coding model as of September 2026; callers can pin any model via `new`.
pub const LATEST_MODEL: &str = "claude-opus-5-5";

#[derive(Clone)]
pub struct Claude {
    client: ClaudeClient,
    model: String,
}
impl Claude {
    /// Selects the current documented Opus model, without changing authentication.
    pub fn latest(client: ClaudeClient) -> Self {
        Self::new(client, LATEST_MODEL)
    }
    /// Uses the supplied client and provider-native model identifier.
    pub fn new(client: ClaudeClient, model: impl Into<String>) -> Self {
        Self {
            client,
            model: model.into(),
        }
    }
}
impl BuilderBackend for Claude {
    type Builder = ClaudeBuilder;
    fn into_builder(self) -> ClaudeBuilder {
        ClaudeBuilder::new(self)
    }
}

/// Provider-specific session builder. Custom functions are opt-in, not automatically discovered.
pub struct ClaudeBuilder {
    claude: Claude,
    max_tokens: u32,
    effort: Option<crate::Effort>,
    automatic_cache: bool,
    context_window_tokens: u64,
    system: String,
    workspace: String,
    tools: Vec<(ToolDefinition, Handler)>,
    server_tools: Vec<ServerToolDefinition>,
    parallel_tools: bool,
}
impl ClaudeBuilder {
    fn new(claude: Claude) -> Self {
        let context_window_tokens = match claude.model.as_str() {
            "claude-opus-5-5" | "claude-fable-5-1" | "claude-sonnet-5" => 1_000_000,
            _ => 200_000, // Conservative fallback; override for other models.
        };
        Self {
            claude,
            max_tokens: 4096,
            effort: None,
            automatic_cache: false,
            context_window_tokens,
            system: String::new(),
            workspace: String::new(),
            tools: Vec::new(),
            server_tools: Vec::new(),
            parallel_tools: false,
        }
    }
    /// Sets the Messages output-token limit.
    pub const fn max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }
    /// Sets the model's adaptive-thinking effort using output_config.effort.
    pub const fn effort(mut self, effort: crate::Effort) -> Self {
        self.effort = Some(effort);
        self
    }
    /// Opt in to Claude's automatic prompt caching (cache writes may cost more).
    pub const fn automatic_cache(mut self, enabled: bool) -> Self {
        self.automatic_cache = enabled;
        self
    }
    /// Sets the token window used for Claude-side automatic compaction at 95%.
    pub const fn context_window_tokens(mut self, tokens: u64) -> Self {
        self.context_window_tokens = tokens;
        self
    }
    /// Sets the model's system instruction.
    pub fn system(mut self, system: impl Into<String>) -> Self {
        self.system = system.into();
        self
    }
    /// Labels the session workspace for embeddings; this driver does not execute shell commands.
    pub fn workspace(mut self, workspace: impl Into<String>) -> Self {
        self.workspace = workspace.into();
        self
    }
    /// Opt in only when all registered tool invocations are independent and
    /// safe to overlap. Results remain ordered in one user message.
    pub const fn parallel_tools(mut self, enabled: bool) -> Self {
        self.parallel_tools = enabled;
        self
    }
    /// Registers one named function. Its result becomes exactly one user tool_result.
    pub fn tool<F, Fut>(mut self, definition: ToolDefinition, function: F) -> Self
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = std::result::Result<String, String>> + Send + 'static,
    {
        self.tools
            .push((definition, Arc::new(move |args| Box::pin(function(args)))));
        self
    }
    /// Register only the five Claude-native text file tools (Read, Edit, Write,
    /// Glob, Grep) for a previously host-authorized, OS-isolated workspace.
    /// This is opt-in. In-process path checks are not a sandbox; a hostile
    /// concurrent process can race filesystem operations. No Codex tool name or
    /// definition is ever forwarded to the model.
    #[cfg(feature = "workspace-files")]
    pub fn workspace_files(mut self, files: Arc<nanocodex_tools::ClaudeWorkspaceFiles>) -> Self {
        for schema in nanocodex_tools::ClaudeWorkspaceFiles::definitions() {
            let definition: ToolDefinition = serde_json::from_value(schema)
                .expect("built-in Claude file tool schema must remain valid");
            let name = definition.name.clone();
            let files = files.clone();
            self = self.tool(definition, move |input| {
                let files = files.clone();
                let name = name.clone();
                async move { files.execute(&name, input).await }
            });
        }
        self
    }
    /// Explicitly enable an Anthropic-executed server tool. The backend never
    /// invokes a local client handler for `server_tool_use` blocks.
    pub fn server_tool(mut self, definition: ServerToolDefinition) -> Self {
        self.server_tools.push(definition);
        self
    }
    /// Builds the common lifecycle handle and independent session event stream.
    pub fn build(self) -> Result<(Nanocodex, AgentEvents)> {
        if self.claude.model.trim().is_empty()
            || self.max_tokens == 0
            || self.context_window_tokens == 0
        {
            return Err(unsupported("Claude model and max_tokens must be nonempty"));
        }
        let mut handlers = HashMap::new();
        let mut definitions = Vec::new();
        for (definition, handler) in self.tools {
            if definition.name.trim().is_empty()
                || handlers.insert(definition.name.clone(), handler).is_some()
            {
                return Err(unsupported("duplicate or empty Claude tool name"));
            }
            definitions.push(definition);
        }
        let mut names = handlers.keys().map(String::as_str).collect::<HashSet<_>>();
        for tool in &self.server_tools {
            if tool.kind.is_empty() || tool.name.is_empty() || !names.insert(&tool.name) {
                return Err(unsupported(
                    "duplicate or empty Claude server tool name/type",
                ));
            }
        }
        static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
        let session_id = format!(
            "claude-{}-{}",
            std::process::id(),
            NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
        );
        let (runtime, events) = BackendRuntime::new(session_id);
        let driver = Driver {
            state: Arc::new(State {
                client: self.claude.client,
                model: self.claude.model,
                max_tokens: self.max_tokens,
                effort: self.effort,
                automatic_cache: self.automatic_cache,
                context_window_tokens: self.context_window_tokens,
                workspace: self.workspace,
                system: self.system,
                tools: definitions,
                server_tools: self.server_tools,
                handlers,
                parallel_tools: self.parallel_tools,
                conversation: Mutex::new(Conversation::default()),
                cancellations: Mutex::new(HashMap::new()),
                stopped: AtomicBool::new(false),
                sequence: AtomicU64::new(1),
            }),
        };
        Ok((runtime.bind(driver), events))
    }
}

#[derive(Default)]
struct Conversation {
    messages: Vec<Message>,
    summary: String,
    active_context_tokens: u64,
}
struct State {
    client: ClaudeClient,
    model: String,
    max_tokens: u32,
    effort: Option<crate::Effort>,
    automatic_cache: bool,
    context_window_tokens: u64,
    workspace: String,
    system: String,
    tools: Vec<ToolDefinition>,
    server_tools: Vec<ServerToolDefinition>,
    handlers: HashMap<String, Handler>,
    parallel_tools: bool,
    conversation: Mutex<Conversation>,
    cancellations: Mutex<HashMap<BackendTurnKey, Arc<Cancellation>>>,
    stopped: AtomicBool,
    sequence: AtomicU64,
}
#[derive(Default)]
struct Cancellation {
    flag: AtomicBool,
    notify: Notify,
}
impl Cancellation {
    fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    async fn cancelled(&self) {
        if self.flag.load(Ordering::SeqCst) {
            return;
        }
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.flag.load(Ordering::SeqCst) {
            notified.await;
        }
    }
}
#[derive(Clone)]
struct Driver {
    state: Arc<State>,
}
fn unsupported(message: &str) -> NanocodexError {
    NanocodexError::InvalidRequest(message.into())
}
fn provider_error(error: impl std::fmt::Display) -> NanocodexError {
    unsupported(&format!("Claude Messages: {error}"))
}
impl State {
    fn emit(&self, events: &AgentEventPublisher, kind: AgentEventKind, payload: Value) {
        let Ok(payload) = serde_json::value::to_raw_value(&payload) else {
            return;
        };
        let _ = events.publish(AgentEvent {
            protocol_version: 1,
            request_id: Arc::from(events.request_id()),
            seq: self.sequence.fetch_add(1, Ordering::SeqCst),
            kind,
            payload: Arc::from(payload),
        });
    }
    async fn response(
        &self,
        messages: Vec<Message>,
        tools: Vec<ClaudeToolSpec>,
        cancel: &Cancellation,
        events: Option<&AgentEventPublisher>,
        index: u32,
    ) -> Result<crate::MessageResponse> {
        let request = MessagesRequest {
            model: self.model.clone(),
            max_tokens: self.max_tokens,
            cache_control: self.automatic_cache.then(crate::CacheControl::ephemeral),
            output_config: self.effort.map(|effort| crate::OutputConfig { effort }),
            system: (!self.system.is_empty()).then(|| self.system.clone()),
            messages,
            tools,
        };
        let mut stream = tokio::select! { result=self.client.stream(&request)=>result.map_err(provider_error)?, ()=cancel.cancelled()=>return Err(NanocodexError::TurnCancelled) };
        let mut captured = Vec::new();
        loop {
            let event = tokio::select! { event=stream.next()=>event, ()=cancel.cancelled()=>return Err(NanocodexError::TurnCancelled) };
            match event {
                Some(Ok(event)) => {
                    if let (
                        Some(events),
                        StreamEvent::ContentBlockDelta {
                            delta: ContentDelta::TextDelta { text },
                            ..
                        },
                    ) = (events, &event)
                    {
                        self.emit(events,AgentEventKind::AssistantDelta,json!({"model_call_index":index,"item_id":null,"phase":null,"text":text}));
                    }
                    let terminal = matches!(event, StreamEvent::MessageStop);
                    captured.push(Ok(event));
                    if terminal {
                        break;
                    }
                }
                Some(Err(error)) => return Err(provider_error(error)),
                None => return Err(provider_error("stream ended without message_stop")),
            }
        }
        let first = captured.remove(0).map_err(provider_error)?;
        collect_stream(first, futures_util::stream::iter(captured))
            .await
            .map_err(provider_error)
    }
    async fn run(&self, request: BackendPrompt, cancel: Arc<Cancellation>) -> Result<TurnResult> {
        let started = Instant::now();
        let mut conversation = self.conversation.lock().await;
        let events = &request.events;
        let reasoning_mode =
            if matches!(self.model.as_str(), "claude-opus-5-5" | "claude-fable-5-1") {
                "adaptive"
            } else {
                "model_default"
            };
        let effort = self
            .effort
            .map(|effort| format!("{effort:?}").to_lowercase())
            .unwrap_or_else(|| "model_default".into());
        self.emit(events,AgentEventKind::RunStarted,json!({"mode":"claude","model":self.model,"reasoning_mode":reasoning_mode,"effort":effort,"transport":"messages_sse","orchestration":"claude","websocket_url":"","workspace":self.workspace,"instruction_bytes":request.prompt.text_bytes()}));
        let result = self.run_locked(&mut conversation, &request, &cancel).await;
        if let Err(error) = &result {
            self.emit(
                events,
                AgentEventKind::RunError,
                json!({"message":error.to_string()}),
            );
        }
        let (status, kind) = match &result {
            Ok(_) => ("completed", AgentEventKind::RunCompleted),
            Err(NanocodexError::TurnCancelled) => ("cancelled", AgentEventKind::RunFailed),
            Err(_) => ("failed", AgentEventKind::RunFailed),
        };
        let ns = started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64;
        self.emit(events,kind,json!({"status":status,"model":self.model,"reasoning_mode":reasoning_mode,"effort":effort,"transport":"messages_sse","orchestration":"claude","duration_ms":ns/1_000_000,"duration_ns":ns,"estimated_cost":null,"cost_usd":null,"cost_status":"other"}));
        result
    }
    async fn compact_locked(
        &self,
        context: &mut Conversation,
        cancel: &Cancellation,
    ) -> Result<()> {
        if context.messages.is_empty() {
            return Err(unsupported("Claude cannot compact empty history"));
        }
        let mut messages = context.messages.clone();
        messages.push(Message::text(Role::User,"CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Summarize the conversation so far, preserving user goals, constraints, decisions and tool results."));
        let response = self.response(messages, Vec::new(), cancel, None, 0).await?;
        if response.stop_reason != Some(StopReason::EndTurn) || response.role != Role::Assistant {
            return Err(provider_error("compaction summary did not end normally"));
        }
        let summary = response
            .content
            .iter()
            .map(|block| match block {
                ContentBlock::Text { text, .. } => Ok(Some(text.as_str())),
                ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. } => Ok(None),
                _ => Err(provider_error("compaction returned a tool block")),
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("");
        if summary.trim().is_empty() {
            return Err(provider_error("compaction returned empty summary"));
        }
        // Replace at one completed model boundary. Errors leave the old state untouched.
        context.messages.clear();
        context.summary = summary;
        context.active_context_tokens = 0;
        Ok(())
    }
    async fn call_tool(
        &self,
        id: &str,
        name: &str,
        input: &Value,
        handler: &Handler,
        events: &AgentEventPublisher,
        index: u32,
    ) -> ContentBlock {
        self.emit(
            events,
            AgentEventKind::ToolCall,
            json!({"call_id":id,"tool":name,"arguments":input,"model_call_index":index}),
        );
        let began = Instant::now();
        let (content, is_error) = match handler(input.clone()).await {
            Ok(content) => (content, false),
            Err(reason) => (reason, true),
        };
        self.emit(events, AgentEventKind::ToolResult, json!({"call_id":id,"tool":name,"status":if is_error {"failed"}else{"completed"},"duration_ns":began.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64,"started_after_ns":null,"result":{"text":content},"structured_result":null,"metadata":null}));
        ContentBlock::tool_result(id, content, is_error)
    }
    async fn run_locked(
        &self,
        conversation: &mut Conversation,
        request: &BackendPrompt,
        cancel: &Cancellation,
    ) -> Result<TurnResult> {
        if request.cancel_on_admission || cancel.flag.load(Ordering::SeqCst) {
            return Err(NanocodexError::TurnCancelled);
        }
        if !conversation.messages.is_empty()
            && u128::from(conversation.active_context_tokens) * 100
                >= u128::from(self.context_window_tokens) * 95
        {
            self.compact_locked(conversation, cancel).await?;
        }
        let mut prompt = prompt_messages(&request.prompt)?;
        let mut pending = conversation.messages.clone();
        if pending.is_empty() && !conversation.summary.is_empty() {
            let Some(Message {
                role: Role::User,
                content,
            }) = prompt.first_mut()
            else {
                return Err(provider_error("invalid summary continuation"));
            };
            let Some(ContentBlock::Text { text, .. }) = content.first_mut() else {
                return Err(provider_error("invalid summary continuation"));
            };
            *text = format!(
                "This session is being continued from a previous conversation. The summary below covers the earlier context:\n\n{}\n\nContinue with the new user request:\n{}",
                conversation.summary, text
            );
        }
        pending.extend(prompt);
        let mut input = 0u64;
        let mut cache_read = 0u64;
        let mut cache_write = 0u64;
        let mut output = 0u64;
        for index in 0..16 {
            let response = self
                .response(
                    pending.clone(),
                    self.tools
                        .iter()
                        .cloned()
                        .map(ClaudeToolSpec::Client)
                        .chain(
                            self.server_tools
                                .iter()
                                .cloned()
                                .map(ClaudeToolSpec::Server),
                        )
                        .collect(),
                    cancel,
                    Some(&request.events),
                    index,
                )
                .await?;
            input = input.saturating_add(response.usage.input_tokens);
            cache_read = cache_read.saturating_add(response.usage.cache_read_input_tokens);
            cache_write = cache_write.saturating_add(response.usage.cache_creation_input_tokens);
            output = output.saturating_add(response.usage.output_tokens);
            if response.role != Role::Assistant {
                return Err(provider_error("response role is not assistant"));
            }
            let mut tool_calls = Vec::new();
            let mut seen_ids = HashSet::new();
            let mut text = String::new();
            for block in &response.content {
                match block {
                    ContentBlock::Text { text: part, .. } => text.push_str(part),
                    ContentBlock::ToolUse {
                        id, name, input, ..
                    } => {
                        if response.stop_reason != Some(StopReason::ToolUse) {
                            return Err(provider_error(
                                "tool_use block without tool_use stop reason",
                            ));
                        }
                        if id.is_empty() || !seen_ids.insert(id.as_str()) {
                            return Err(provider_error("duplicate or empty Claude tool_use id"));
                        }
                        let handler = self.handlers.get(name).ok_or_else(|| {
                            provider_error(format!("unregistered Claude tool {name}"))
                        })?;
                        tool_calls.push((id, name, input, handler));
                    }
                    ContentBlock::Thinking { .. }
                    | ContentBlock::RedactedThinking { .. }
                    | ContentBlock::ServerToolUse { .. }
                    | ContentBlock::WebSearchToolResult { .. }
                    | ContentBlock::WebFetchToolResult { .. }
                    | ContentBlock::ToolSearchToolResult { .. }
                    | ContentBlock::CodeExecutionToolResult { .. } => {}
                    ContentBlock::ToolResult { .. } => {
                        return Err(provider_error("assistant emitted user tool_result"));
                    }
                }
            }
            if response.stop_reason == Some(StopReason::ToolUse) && tool_calls.is_empty() {
                return Err(provider_error("tool_use stop without tool call"));
            }
            if !text.is_empty() {
                self.emit(&request.events,AgentEventKind::AssistantMessage,json!({"model_call_index":index,"item_id":response.id,"phase":null,"text":text}));
            }
            let tool_results = if self.parallel_tools {
                let calls = tool_calls.iter().map(|(id, name, input, handler)| {
                    self.call_tool(id, name, input, handler, &request.events, index)
                });
                tokio::select! {
                    values = futures_util::future::join_all(calls) => values,
                    () = cancel.cancelled() => return Err(NanocodexError::TurnCancelled),
                }
            } else {
                let mut results = Vec::with_capacity(tool_calls.len());
                for (id, name, input, handler) in tool_calls {
                    let result = tokio::select! {
                        value = self.call_tool(id, name, input, handler, &request.events, index) => value,
                        () = cancel.cancelled() => return Err(NanocodexError::TurnCancelled),
                    };
                    results.push(result);
                }
                results
            };
            pending.push(Message {
                role: Role::Assistant,
                content: response.content,
            });
            if response.stop_reason == Some(StopReason::ToolUse) {
                pending.push(Message::tool_results(tool_results));
                // A client tool may already have changed external state. Commit
                // its completed assistant/result pair before attempting the next
                // provider request, so a transport failure or cancellation does
                // not erase the evidence from this in-process session. Hosts
                // still need durable effect receipts across process restarts.
                conversation.messages = pending.clone();
                conversation.summary.clear();
                conversation.active_context_tokens = response
                    .usage
                    .input_tokens
                    .saturating_add(response.usage.cache_read_input_tokens)
                    .saturating_add(response.usage.cache_creation_input_tokens)
                    .saturating_add(response.usage.output_tokens);
                continue;
            }
            if response.stop_reason == Some(StopReason::PauseTurn) {
                // Server tools continue with the same tool array and the paused
                // assistant message, without a fabricated user tool result.
                continue;
            }
            if !tool_results.is_empty() || response.stop_reason != Some(StopReason::EndTurn) {
                return Err(provider_error(format!(
                    "unsupported Claude stop reason: {:?}",
                    response.stop_reason
                )));
            }
            if cancel.flag.load(Ordering::SeqCst) {
                return Err(NanocodexError::TurnCancelled);
            }
            conversation.messages = pending;
            conversation.summary.clear();
            conversation.active_context_tokens = response
                .usage
                .input_tokens
                .saturating_add(response.usage.cache_read_input_tokens)
                .saturating_add(response.usage.cache_creation_input_tokens)
                .saturating_add(response.usage.output_tokens);
            return Ok(TurnResult::from_backend(
                request.request_id.clone(),
                text,
                Some(TurnUsage::from_reported(ReportedTurnUsage {
                    input_tokens: input,
                    cached_input_tokens: cache_read,
                    cache_write_input_tokens: cache_write,
                    output_tokens: output,
                    reasoning_output_tokens: 0,
                    total_tokens: input
                        .saturating_add(cache_read)
                        .saturating_add(cache_write)
                        .saturating_add(output),
                    estimated_cost: None,
                    cost_status: CostStatus::Other,
                })),
            ));
        }
        Err(provider_error("tool continuation limit (16) exceeded"))
    }
}
fn prompt_messages(prompt: &Prompt) -> Result<Vec<Message>> {
    let mut messages = Vec::new();
    for item in prompt.transcript() {
        let role = match item.role() {
            PromptMessageRole::User => Role::User,
            PromptMessageRole::Assistant => Role::Assistant,
        };
        messages.push(Message::text(role, item.content()));
    }
    let PromptInput::Text(text) = &prompt.instruction else {
        return Err(unsupported(
            "Claude driver currently supports text-only prompts",
        ));
    };
    messages.push(Message::text(Role::User, text));
    Ok(messages)
}
impl LifecycleBackend for Driver {
    fn submit(&self, request: BackendPrompt) -> BackendFuture<Result<BackendTurn>> {
        let state = self.state.clone();
        Box::pin(async move {
            if state.stopped.load(Ordering::SeqCst) {
                return Err(NanocodexError::AgentStopped);
            }
            prompt_messages(&request.prompt)?;
            // A request_id is retained as a label, but cannot offer durable idempotency.
            if request.request_id.is_some() {
                return Err(unsupported(
                    "Claude driver does not support durable request_id replay",
                ));
            }
            let key = request.key;
            let cancellation = Arc::new(Cancellation::default());
            state
                .cancellations
                .lock()
                .await
                .insert(key, cancellation.clone());
            let (sender, receiver) = oneshot::channel();
            tokio::spawn(async move {
                let result = state.run(request, cancellation).await;
                state.cancellations.lock().await.remove(&key);
                let _ = sender.send(result);
            });
            Ok(BackendTurn {
                request_id: None,
                result: Box::pin(async move {
                    receiver.await.unwrap_or(Err(NanocodexError::TurnStopped))
                }),
            })
        })
    }
    fn route(&self, _request: BackendPrompt) -> BackendFuture<Result<BackendPromptRoute>> {
        Box::pin(async { Err(unsupported("Claude live route/steering is unsupported")) })
    }
    fn steer(&self, _key: BackendTurnKey, _prompt: Prompt) -> BackendFuture<Result<()>> {
        Box::pin(async { Err(unsupported("Claude steering is unsupported")) })
    }
    fn cancel(&self, key: BackendTurnKey) -> BackendFuture<Result<()>> {
        let state = self.state.clone();
        Box::pin(async move {
            let cancels = state.cancellations.lock().await;
            let cancel = cancels
                .get(&key)
                .ok_or_else(|| unsupported("Claude turn is not active"))?;
            cancel.cancel();
            Ok(())
        })
    }
    fn set_model(&self, _model: Model) -> BackendFuture<Result<()>> {
        Box::pin(async {
            Err(unsupported(
                "Claude model cannot be selected with OpenAI Model enum",
            ))
        })
    }
    fn set_thinking(&self, _thinking: Thinking) -> BackendFuture<Result<()>> {
        Box::pin(async { Err(unsupported("Claude thinking policy is unsupported")) })
    }
    fn set_fast_mode(&self, _enabled: bool) -> BackendFuture<Result<()>> {
        Box::pin(async { Err(unsupported("Claude fast mode is unsupported")) })
    }
    fn compact(&self) -> BackendFuture<Result<()>> {
        let state = self.state.clone();
        Box::pin(async move {
            if state.stopped.load(Ordering::SeqCst) {
                return Err(NanocodexError::AgentStopped);
            }
            let mut context = state.conversation.lock().await;
            let cancel = Cancellation::default();
            state.compact_locked(&mut context, &cancel).await?;
            Ok(())
        })
    }
    fn append_developer_message(
        &self,
        _text: String,
    ) -> BackendFuture<Result<AgentSessionContext>> {
        Box::pin(async {
            Err(unsupported(
                "Claude dynamic developer context is unsupported",
            ))
        })
    }
    fn context(&self) -> BackendFuture<Result<AgentSessionContext>> {
        let state = self.state.clone();
        Box::pin(async move {
            let history = state.conversation.lock().await;
            if !history.messages.is_empty() || !history.summary.is_empty() {
                return Err(unsupported(
                    "Claude context cannot be represented by OpenAI ResponseItem",
                ));
            }
            Ok(AgentSessionContext::from_backend(
                state.workspace.clone(),
                vec![],
            ))
        })
    }
    fn spawn(&self, _options: SpawnOptions) -> BackendFuture<Result<(Nanocodex, AgentEvents)>> {
        Box::pin(async { Err(unsupported("Claude spawn is unsupported")) })
    }
    fn fork(
        &self,
        _completed: Option<TurnResult>,
    ) -> BackendFuture<Result<(Nanocodex, AgentEvents)>> {
        Box::pin(async { Err(unsupported("Claude fork is unsupported")) })
    }
    fn flush(&self) -> BackendFuture<Result<()>> {
        Box::pin(async { Err(unsupported("Claude has no durable persistence to flush")) })
    }
    fn shutdown(&self) -> BackendFuture<Result<()>> {
        let state = self.state.clone();
        Box::pin(async move {
            state.stopped.store(true, Ordering::SeqCst);
            for cancel in state.cancellations.lock().await.values() {
                cancel.cancel()
            }
            Ok(())
        })
    }
}
