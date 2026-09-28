# Nanoclaude architecture

Nanoclaude is a separate Claude agent-loop backend, **not** a Claude model flag in
Nanocodex's OpenAI Responses loop and not an Anthropic-to-OpenAI proxy. The
common `nanocodex-agent::Nanocodex` handle already erases lifecycle operations
through `BuilderBackend` and `LifecycleBackend`; an external
`nanocodex-claude` crate can own a Claude-specific driver and bind it using
`BackendRuntime`. The existing OpenAI driver stays unchanged.

## Provider boundaries

| Concern | OpenAI backend | Claude backend |
| --- | --- | --- |
| Model wire | Responses items/events | Messages `system`, `messages`, content blocks, SSE events |
| Tools | Responses function/custom calls and function outputs | Claude `tools[].input_schema`, assistant `tool_use`, subsequent **user** `tool_result` with the same ID |
| Loop | Responses-specific retained response IDs, Code Mode, tool orchestration | Claude-specific tool loop, opt-in cache, usage/cancellation; retries and durable effects pending |
| Compaction | Provider opaque compaction item | Claude Code 2.1.283-style client summary and transcript replacement; never treat an OpenAI encrypted item as a Claude block |

The initial `nanocodex-claude` crate provides `ClaudeClient` and
`Nanocodex::builder(Claude::new(client, model))`: streamed text, caller-
registered JSON function tools with Claude `tool_use` / user `tool_result`
ordering, manual and 95%-threshold client-side summarization, cancellation,
usage, and shared lifecycle events. `Claude::latest(client)` currently chooses
`claude-opus-5-5` (September 2026); its default context budget is 1M tokens,
as are the documented Fable 5.1 and Sonnet 5 model IDs. Unknown model IDs
conservatively default to 200K until configured via `.context_window_tokens()`.
The `max_tokens` default remains 4096 and includes adaptive thinking, so callers
should tune it for their workload. Its loopback E2E tests do not use a real
provider credential. The Claude loop is independent of the OpenAI loop.

## Claude Platform API first

The Messages transport speaks `/v1/messages` directly with
`anthropic-version: 2023-06-01`; `ClaudeClient::official(http, api_key)`
accepts an ordinary Console API key supplied by the embedding application.
No Claude Code credential is read. One minimal integration (with a caller-owned
Console key) is:

```rust
let client = nanocodex_claude::ClaudeClient::official(
    reqwest::Client::new(), console_api_key,
);
let (agent, mut events) = nanocodex_agent::Nanocodex::builder(
    nanocodex_claude::Claude::latest(client),
)
.automatic_cache(true) // optional: 5-minute cache writes have different pricing
.max_tokens(8192)
.effort(nanocodex_claude::Effort::Medium)
.build()?;
let result = agent.prompt("Hello").await?.result().await?;
println!("{}", result.final_message());
```

The request shape supports opt-in top-level automatic `cache_control`,
`output_config.effort` for adaptive thinking, strict client tool definitions, and string or nested block arrays for tool results.
The transport assembles SSE text, tool input JSON, signed thinking and cache
usage, validates event names, terminal stop reasons and JSON object tool input,
and limits each SSE frame to 32 MiB. Thinking/redacted-thinking block fields are
preserved for replay. Unknown delta types on a known block fail closed, rather
than returning altered content or executing a partial tool call. The current agent handler itself still returns **text** tool results; richer
result blocks are available only through the protocol API. Independent client
functions can opt into concurrent execution via `.parallel_tools(true)`; the
caller must ensure side effects do not conflict. The default is sequential.
Anthropic-executed `web_search_20250305` and `web_fetch_20250910` can be
explicitly selected with `.server_tool(ServerToolDefinition::web_search_basic(n))`
and its fetch counterpart; their calls/results are not executed locally and
never become a fabricated user `tool_result`. Search ciphertext/citations replay,
server/client distinction and `pause_turn` continuation have loopback tests. We have tested this against a
synthetic loopback server, not a live Platform account.


This is **not Claude Code parity**. Bare CLI 2.1.283 advertises native
`Bash`, `Read`, and `Edit` schemas; this crate currently exposes only explicitly
registered functions, not those built-ins or `nanocodex-tools`. Multi-modal user inputs and agent-handler tool outputs, automatic instruction reload,
full thinking policy,
steering, spawn/fork, snapshots, durability/preservation hooks and live auth
remain unimplemented; unsupported lifecycle operations return errors. In
particular, do not double-execute Claude Code CLI built-ins through an
OpenAI-style dispatcher. A native tool layer needs explicit execution,
permissions, effect receipts and cancellation semantics.

## Synthetic CLI 2.1.283 protocol check

An isolated `--bare` CLI run with a fake API key and a 127.0.0.1 SSE service
captured the current request and two synthetic `Read` calls. Its first request
used `claude-sonnet-5`, `thinking: {"type":"adaptive"}`, `max_tokens:64000`,
Claude-native `Bash`/`Edit`/`Read` tool schemas, block-level ephemeral cache
markers, and `clear_thinking_20251015` with `keep:all`. The CLI returned signed
thinking plus two `tool_use` blocks, then one user message containing both
matching `tool_result` blocks; a missing file was represented with
`is_error:true`. This confirms the Claude block ordering, not live billing,
cache hits, or server compaction. Do **not** copy its first-party billing
identity/system prompts, beta headers, or OAuth credentials into Nanoclaude.
The sanitized experiment and invocation are at
`/brain/tmp/claude-cli-probe-agent/README.md` (local scratch, not shipped).

## Observed Claude Code 2.1.283 compaction reference

A synthetic fake-key localhost capture of the current CLI shows `/compact`
performing a **normal** streamed Messages generation. It appended a user
instruction starting `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.`
to the old conversation; the returned text was installed as the summary. The
next request sent a new user message beginning `This session is being continued
from a previous conversation...`, containing that summary and the new prompt,
not the old message list. Its `context_management.edits` contained only
`clear_thinking_20251015`, not `compact_20260112`, and no API `compaction`
parameter or signed block was used in this fixture. The Claude backend should
model this as a client-owned atomic history replacement after a complete
summary, with a retention boundary for unfinished tool uses and durable
preservation before dropping history. This is an observed fixture, not a
promise that every Claude Code version or model follows the same path.

## Subscription/authentication boundary

Authentication is a separately injected transport capability. The ordinary
integration uses documented Claude Platform API credentials. An embedding with
approved subscription authority can implement `ClaudeAuthProvider`, which
resolves fresh request headers at each call and reports an intentionally
redacted failure. This is a transport seam, **not** an OAuth login/refresh
implementation or proof of subscription billing. The account owner
reports access to an Anthropic trusted subscription program for custom agent
clients; that mode requires the program's approved client identity, token
acquisition/refresh protocol, scope, and billing/routing terms before live
traffic is enabled. Anthropic's public SDK guidance says third-party Claude.ai
login/rate limits require prior approval, but does not publish the trusted
program's client-registration/redirect/scope/refresh contract. Obtain that
non-secret integration spec from the program before live traffic. Do not copy
Claude Code's local credentials, fake its identity, or infer authorization from
a working bearer token. The protocol
and agent-loop tests use only a synthetic localhost service.

See [the tool implementation matrix](CLAUDE_TOOL_MATRIX.md) for all known
Claude Code families and the unimplemented native executor/permission work.

The official Claude Agent SDK is a distinct subscription-backed alternative,
but that SDK owns the tool/model loop; it is not interchangeable with the
custom Claude backend. Avoid conflating these auth and execution modes.

References: [Claude tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls),
[Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming),
[prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[Opus 5.5 migration](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide),
[compaction on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand),
[Claude Code context window](https://code.claude.com/docs/en/context-window),
[subscription and third-party access](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account),
[Agent SDK subscription access](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
[third-party approval language](https://code.claude.com/docs/en/agent-sdk/quickstart),
[Claude Code auth guidance](https://code.claude.com/docs/en/legal-and-compliance).
