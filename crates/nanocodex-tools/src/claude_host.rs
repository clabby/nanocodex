//! Opt-in Claude orchestration adapters for embedding-owned capabilities.
//!
//! These adapters validate a bounded subset of Claude Code inputs. They never
//! create a child, answer a question, grant plan approval, switch directories,
//! or synthesize a task receipt. The host owns those effects and their durable
//! lifecycle. See <https://code.claude.com/docs/en/tools-reference>.
//!
//! Register only [`ClaudeHostTools::definitions`] and dispatch each call with
//! its real [`ToolContext`]. A host must persist effect admission and results
//! keyed by session, turn and call identity, authorize resume/task IDs, and
//! reconcile cancellation or restart before accepting another effect. This
//! module has no default host and does not provide full Claude Code parity.

use crate::{ToolContext, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// Maximum serialized arguments admitted at this boundary.
pub const MAX_HOST_INPUT_BYTES: usize = 64 * 1024;

/// Capabilities explicitly installed by an embedding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum HostTool {
    /// Start or resume a host-owned child agent.
    Agent,
    /// Observe or wait for a host-owned background task.
    TaskOutput,
    /// Stop a host-owned background task.
    TaskStop,
    /// Await structured user answers in the host UI.
    AskUserQuestion,
    /// Enter the host's restricted planning mode.
    EnterPlanMode,
    /// Request the host's approval to leave planning mode.
    ExitPlanMode,
    /// Enter an authorized isolated worktree.
    EnterWorktree,
    /// Leave a host-owned worktree.
    ExitWorktree,
}
impl HostTool {
    /// All adapter capabilities; listing one never supplies its implementation.
    pub const ALL: [Self; 8] = [
        Self::Agent,
        Self::TaskOutput,
        Self::TaskStop,
        Self::AskUserQuestion,
        Self::EnterPlanMode,
        Self::ExitPlanMode,
        Self::EnterWorktree,
        Self::ExitWorktree,
    ];

    /// Claude-visible tool name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Agent => "Agent",
            Self::TaskOutput => "TaskOutput",
            Self::TaskStop => "TaskStop",
            Self::AskUserQuestion => "AskUserQuestion",
            Self::EnterPlanMode => "EnterPlanMode",
            Self::ExitPlanMode => "ExitPlanMode",
            Self::EnterWorktree => "EnterWorktree",
            Self::ExitWorktree => "ExitWorktree",
        }
    }
}

/// Validated requests passed to the actual host lifecycle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostRequest {
    /// Start/resume a child. Background requests require output and stop capabilities.
    Agent(AgentRequest),
    /// Retrieve actual task output/status, optionally waiting.
    TaskOutput(TaskOutputRequest),
    /// Stop an actual host task; success must mean the host observed the stop.
    TaskStop(TaskStopRequest),
    /// Await a user response without flattening options or selecting defaults.
    AskUserQuestion(QuestionsRequest),
    /// Enforce host planning restrictions before reporting entry.
    EnterPlanMode,
    /// Await real approval; requested permissions do not grant themselves.
    ExitPlanMode(ExitPlanRequest),
    /// Create/enter and update host execution context before reporting success.
    EnterWorktree(EnterWorktreeRequest),
    /// Return to the original execution context; authorize removals separately.
    ExitWorktree(ExitWorktreeRequest),
}

/// Actual embedding capability, with no permissive or synthetic default.
///
/// Implementations must enforce authorization, input-dependent capability
/// support, capture limits, child/task ownership, and cancellation. In
/// particular, unknown subagent types/models/isolation modes must fail before
/// spawning; questions must remain pending until answered or cancelled; plan
/// approval must come from the user/host policy, never model-supplied fields.
/// The host should reuse its existing agent, task, approval and workspace
/// services. Returning an acknowledgement is not proof an effect completed.
pub trait ClaudeHost: Send + Sync {
    /// Execute once through the host's admitted lifecycle and preserve actual
    /// result/error/media using the shared Nanocodex output contract.
    fn execute(
        &self,
        request: HostRequest,
        context: ToolContext<'_>,
    ) -> impl std::future::Future<Output = Result<ToolOutput, String>> + Send;
}

/// Validated Claude inputs backed by an explicitly installed host.
pub struct ClaudeHostTools<H: ClaudeHost> {
    host: H,
    enabled: BTreeSet<HostTool>,
}
impl<H: ClaudeHost> ClaudeHostTools<H> {
    /// Install only capabilities the host actually implements and authorizes.
    pub fn new(host: H, enabled: impl IntoIterator<Item = HostTool>) -> Self {
        Self {
            host,
            enabled: enabled.into_iter().collect(),
        }
    }

    /// Definitions for this host's explicit capability subset. No native Codex
    /// tool definitions are loaded. Unsupported fields fail during execution.
    #[must_use]
    pub fn definitions(&self) -> Vec<Value> {
        self.enabled.iter().map(|tool| definition(*tool)).collect()
    }

    /// Validate all fields before host admission and forward the real context.
    /// No retries or lifecycle receipts are generated by this adapter.
    pub async fn execute(
        &self,
        name: &str,
        input: Value,
        context: ToolContext<'_>,
    ) -> Result<ToolOutput, String> {
        let tool = self
            .enabled
            .iter()
            .find(|tool| tool.name() == name)
            .copied()
            .ok_or_else(|| format!("Claude host tool is unavailable: {name}"))?;
        if context.session_id().is_empty()
            || context.call_id().is_empty()
            || context.turn_id().is_none_or(str::is_empty)
        {
            return Err("host tools require real session, turn and call identities".into());
        }
        if serde_json::to_vec(&input).map_err(|e| e.to_string())?.len() > MAX_HOST_INPUT_BYTES {
            return Err("host tool input exceeds 64 KiB".into());
        }
        let request = match tool {
            HostTool::Agent => {
                let request: AgentRequest = decode(input)?;
                text(&request.prompt, "prompt", 48 * 1024)?;
                text(&request.description, "description", 1024)?;
                text(&request.subagent_type, "subagent_type", 256)?;
                if let Some(resume) = &request.resume {
                    text(resume, "resume", 256)?;
                }
                if request.max_turns.is_some_and(|turns| turns == 0) {
                    return Err("max_turns must be positive".into());
                }
                if request.run_in_background
                    && !(self.enabled.contains(&HostTool::TaskOutput)
                        && self.enabled.contains(&HostTool::TaskStop))
                {
                    return Err(
                        "background Agent requires installed TaskOutput and TaskStop capabilities"
                            .into(),
                    );
                }
                HostRequest::Agent(request)
            }
            HostTool::TaskOutput => {
                let request: TaskOutputRequest = decode(input)?;
                text(&request.task_id, "task_id", 256)?;
                if request.timeout > 600_000 {
                    return Err("timeout must be 0..600000 milliseconds".into());
                }
                HostRequest::TaskOutput(request)
            }
            HostTool::TaskStop => {
                let request: TaskStopRequest = decode(input)?;
                text(&request.task_id, "task_id", 256)?;
                HostRequest::TaskStop(request)
            }
            HostTool::AskUserQuestion => {
                let request: QuestionsRequest = decode(input)?;
                if !(1..=4).contains(&request.questions.len()) {
                    return Err("questions requires 1..4 entries".into());
                }
                let mut questions = BTreeSet::new();
                for question in &request.questions {
                    text(&question.question, "question", 8192)?;
                    text(&question.header, "header", 48)?;
                    if question.header.chars().count() > 12 {
                        return Err("header must contain at most 12 characters".into());
                    }
                    if !questions.insert(&question.question) {
                        return Err("duplicate question".into());
                    }
                    if !(2..=4).contains(&question.options.len()) {
                        return Err("question requires 2..4 options".into());
                    }
                    let mut labels = BTreeSet::new();
                    for option in &question.options {
                        text(&option.label, "label", 1024)?;
                        text(&option.description, "description", 8192)?;
                        if let Some(markdown) = &option.markdown {
                            text(markdown, "markdown", 8192)?;
                        }
                        if !labels.insert(&option.label) {
                            return Err("duplicate option label".into());
                        }
                    }
                }
                HostRequest::AskUserQuestion(request)
            }
            HostTool::EnterPlanMode => {
                let _: EmptyRequest = decode(input)?;
                HostRequest::EnterPlanMode
            }
            HostTool::ExitPlanMode => {
                let request: ExitPlanRequest = decode(input)?;
                if request.allowed_prompts.len() > 32 {
                    return Err("too many allowedPrompts".into());
                }
                for prompt in &request.allowed_prompts {
                    text(&prompt.prompt, "prompt", 8192)?;
                }
                HostRequest::ExitPlanMode(request)
            }
            HostTool::EnterWorktree => {
                let request: EnterWorktreeRequest = decode(input)?;
                if request.name.is_some() && request.path.is_some() {
                    return Err("name and path are mutually exclusive".into());
                }
                if let Some(name) = &request.name {
                    text(name, "name", 256)?;
                }
                if let Some(path) = &request.path {
                    text(path, "path", 4096)?;
                }
                HostRequest::EnterWorktree(request)
            }
            HostTool::ExitWorktree => HostRequest::ExitWorktree(decode(input)?),
        };
        self.host.execute(request, context).await
    }
}
fn decode<T: serde::de::DeserializeOwned>(input: Value) -> Result<T, String> {
    serde_json::from_value(input).map_err(|e| format!("invalid Claude host input: {e}"))
}
fn text(value: &str, field: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        return Err(format!(
            "{field} must be nonblank, NUL-free and at most {max} bytes"
        ));
    }
    Ok(())
}
fn schema<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).expect("JSON schema serialization")
}
fn definition(tool: HostTool) -> Value {
    let (description, input_schema) = match tool {
        HostTool::Agent => (
            "Start or resume an authorized host-owned agent; return its actual result or background task identity.",
            schema::<AgentRequest>(),
        ),
        HostTool::TaskOutput => (
            "Read a host-owned background task's status and output, optionally waiting up to timeout milliseconds.",
            schema::<TaskOutputRequest>(),
        ),
        HostTool::TaskStop => (
            "Stop an authorized host-owned background task and report the host's observed result.",
            schema::<TaskStopRequest>(),
        ),
        HostTool::AskUserQuestion => (
            "Present structured questions and await the user's answers through the host UI.",
            schema::<QuestionsRequest>(),
        ),
        HostTool::EnterPlanMode => (
            "Enter host-enforced planning mode.",
            schema::<EmptyRequest>(),
        ),
        HostTool::ExitPlanMode => (
            "Present the host's current plan for approval; requested prompts are not grants.",
            schema::<ExitPlanRequest>(),
        ),
        HostTool::EnterWorktree => (
            "Create or enter an authorized git worktree and switch the host execution context.",
            schema::<EnterWorktreeRequest>(),
        ),
        HostTool::ExitWorktree => (
            "Leave the current host worktree, keeping it or requesting authorized removal.",
            schema::<ExitWorktreeRequest>(),
        ),
    };
    json!({"name":tool.name(), "description":description, "input_schema":input_schema})
}

/// Supported Agent request subset. Team/bypass/fork options are rejected.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentRequest {
    /// Complete task instructions, preserved as text.
    pub prompt: String,
    /// Short purpose shown by the host.
    pub description: String,
    /// A host-configured agent type; the host validates availability.
    pub subagent_type: String,
    /// Optional model choice; the host must reject unavailable models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<AgentModel>,
    /// Existing authorized host agent ID to resume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    /// Return a real task identity while execution continues in the host.
    #[serde(default)]
    pub run_in_background: bool,
    /// Optional positive turn limit enforced by the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    /// Request isolated worktree execution; never silently ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation: Option<AgentIsolation>,
}
/// Recognized Claude model selectors; availability belongs to the host.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentModel {
    /// Host-configured Sonnet model.
    Sonnet,
    /// Host-configured Opus model.
    Opus,
    /// Host-configured Haiku model.
    Haiku,
}
/// Supported child isolation request.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentIsolation {
    /// A separate host-authorized worktree.
    Worktree,
}
/// Background output request; timeout bounds waiting, not the task lifetime.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TaskOutputRequest {
    /// Host task identity, scoped and authorized by the host.
    pub task_id: String,
    /// Wait for completion if true; poll if false.
    #[serde(default = "default_block")]
    pub block: bool,
    /// Maximum wait in milliseconds, from zero through 600000.
    #[serde(default = "default_timeout")]
    pub timeout: u64,
}
const fn default_block() -> bool {
    true
}
const fn default_timeout() -> u64 {
    30_000
}
/// Stop a task by its actual host identity.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TaskStopRequest {
    /// Task/agent identity accepted by the host; never a local checklist ID.
    pub task_id: String,
}
/// Questions displayed together, with no model-supplied answers accepted.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct QuestionsRequest {
    /// One to four distinct questions.
    pub questions: Vec<UserQuestion>,
}
/// A structured host UI question.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UserQuestion {
    /// Full question text.
    pub question: String,
    /// Short UI label, at most twelve characters.
    pub header: String,
    /// Two to four distinct answer choices.
    pub options: Vec<QuestionOption>,
    /// Whether the user may select multiple options.
    #[serde(rename = "multiSelect")]
    pub multi_select: bool,
}
/// A question choice, retained without flattening.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption {
    /// Displayed choice label.
    pub label: String,
    /// Explanation of the choice.
    pub description: String,
    /// Optional preview content, untrusted UI data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}
/// Exit planning with permissions requested for host review, not preapproved.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExitPlanRequest {
    /// Requested actions to present with the host's stored plan.
    #[serde(default, rename = "allowedPrompts")]
    pub allowed_prompts: Vec<PlanPrompt>,
}
/// One action whose permission the host must decide.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlanPrompt {
    /// Currently supported permission-request target.
    pub tool: PlanTool,
    /// Natural-language description of the requested action.
    pub prompt: String,
}
/// Supported tool named in a plan permission request.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum PlanTool {
    /// Shell action; this adapter never executes the prompt as a command.
    Bash,
}
/// Create a worktree or enter an existing path; authorization is host-owned.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EnterWorktreeRequest {
    /// Optional new worktree name; mutually exclusive with path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Optional existing worktree location, verified by the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}
/// Leave a host-owned worktree; a remove request is not removal approval.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExitWorktreeRequest {
    /// Explicit preservation/removal choice; no destructive default.
    pub action: WorktreeAction,
}
/// What to do with the worktree after leaving it.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeAction {
    /// Preserve the worktree and its changes.
    Keep,
    /// Ask the host to remove it subject to its own authorization policy.
    Remove,
}

/// Claude view over Nanocodex's existing dynamic MCP provider.
///
/// The same provider retains connections, discovery, OAuth and remote execution.
/// Query definitions at each model request boundary; do not freeze a startup
/// snapshot. This bridge never exposes the provider's Responses tool_search.
/// MCP resource listing/reading and WaitForMcpServers are not implemented here.
#[cfg(feature = "native")]
pub struct ClaudeMcp<P: crate::runtime::DynamicToolProvider + ?Sized> {
    provider: std::sync::Arc<P>,
}
#[cfg(feature = "native")]
impl<P: crate::runtime::DynamicToolProvider + ?Sized> ClaudeMcp<P> {
    /// Wrap an explicitly authorized existing provider without connecting yet.
    #[must_use]
    pub const fn new(provider: std::sync::Arc<P>) -> Self {
        Self { provider }
    }

    /// Start the existing provider's idempotent discovery lifecycle.
    pub fn start(&self) {
        self.provider.start();
    }

    /// Snapshot currently discovered MCP tools with their exact input schemas.
    /// Reject duplicate names, non-MCP entries and non-function tools instead
    /// of fabricating schemas or leaking unrelated host capabilities.
    pub fn definitions(&self) -> Result<Vec<Value>, String> {
        let mut names = BTreeSet::new();
        self.provider.available_definitions().into_iter().map(|definition| {
            let name = definition.name();
            if !name.starts_with("mcp__") || !names.insert(name.to_owned()) {
                return Err(format!("invalid or duplicate MCP tool name: {name}"));
            }
            let schema = definition.parameters().ok_or("MCP tool must have a function schema")?.as_value();
            if !schema.is_object() { return Err("MCP input schema must be an object".into()); }
            Ok(json!({"name":name,"description":definition.description(),"input_schema":schema}))
        }).collect()
    }

    /// Execute only a currently discovered tool via its original provider.
    /// Remote validation remains authoritative: input is passed intact, never
    /// stripped/coerced against a guessed schema. Removed tools fail closed.
    /// The caller must preserve success, structured results and media while
    /// converting the shared output into a Claude tool_result.
    pub async fn execute(
        &self,
        name: &str,
        input: Value,
        context: ToolContext<'_>,
    ) -> Result<ToolOutput, String> {
        if !self
            .definitions()?
            .iter()
            .any(|definition| definition["name"].as_str() == Some(name))
        {
            return Err(format!("MCP tool is no longer available: {name}"));
        }
        if !input.is_object() {
            return Err("MCP input must be an object".into());
        }
        self.provider
            .execute(name, input, context)
            .await
            .ok_or_else(|| format!("MCP tool became unavailable: {name}"))
    }
}

#[cfg(test)]
#[path = "claude_host_tests.rs"]
mod tests;
