# Nanoclaude architecture

For current behavior and recovery guarantees, see [runtime](CLAUDE_RUNTIME.md), [tool coverage](CLAUDE_TOOL_MATRIX.md), and [authentication](claude-authentication.md). Dated CLI observations below describe their measured fixtures.

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
| Loop | Responses-specific retained response IDs, Code Mode, tool orchestration | Claude-specific tool loop, cache, usage/cancellation; shared durable admission, checkpoints and effect receipts |
| Compaction | Provider opaque compaction item | Claude Code 2.1.283-style client summary and transcript replacement; never treat an OpenAI encrypted item as a Claude block |

The initial `nanocodex-claude` crate provides `ClaudeClient` and
`Nanocodex::builder(Claude::new(client, model))`: streamed text, caller-
registered JSON function tools with Claude `tool_use` / user `tool_result`
ordering, manual and reserve-aware client-side summarization, cancellation,
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

The request shape supports opt-in top-level automatic `cache_control` (including 1-hour TTL),
`thinking:adaptive`, `output_config.effort`, `context_management` keep-all-thinking with its documented beta, caller-supplied system text blocks and cache markers, strict client tool definitions, and string or nested block arrays for tool results.
The transport assembles SSE text, tool input JSON, signed thinking and cache
usage, validates event names, terminal stop reasons and JSON object tool input,
and limits each SSE frame to 32 MiB. Thinking/redacted-thinking block fields are
preserved for replay. Unknown delta types on a known block fail closed, rather
than returning altered content or executing a partial tool call. Agent handlers can return text or richer Claude content blocks via `.tool_blocks()`. Independent client
functions can opt into concurrent execution via `.parallel_tools(true)`; the
caller must ensure side effects do not conflict. The default is sequential.
Anthropic-executed `web_search_20250305` and `web_fetch_20250910` can be
explicitly selected with `.server_tool(ServerToolDefinition::web_search_basic(n))`
and its fetch counterpart; their calls/results are not executed locally and
never become a fabricated user `tool_result`. Search ciphertext/citations replay,
server/client distinction and `pause_turn` continuation have loopback tests. We have tested this against a
synthetic loopback server, not a live Platform account.


This is **not Claude Code parity**. Native tools remain explicit opt-ins; the
`workspace-files` feature supplies only bounded adapters, not the full CLI. Multi-modal user inputs, automatic instruction reload,
full thinking policy,
steering, core spawn/fork and OpenAI-shaped snapshot APIs
remain unimplemented; unsupported lifecycle operations return errors. The Claude
builder now attaches to the existing durability crate through `.durability(state)`
and restores provider-native checkpoints, tool receipts and compaction state. In
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

`ClaudeSubscription` now implements the native subscription OAuth lifecycle over
host-owned private CAS storage and bounded HTTP. Current client registration,
PKCE/redirects, scopes, token/profile endpoints and refresh behavior were derived
from the public Claude Code 2.1.283 executable and an isolated login probe. The
manager is separate from agent durable state and is attached through
`ClaudeClient::subscription`. API-key and generic bearer-provider paths remain
available. See [authentication](claude-authentication.md) for construction,
persistence, failure handling, measured protocol and live-validation limits.

Native login and rotation are tested with synthetic provider responses, including
composition with the normal tool/compaction/SQLite lifecycle. This does not assert
live provider acceptance, billing, or full Claude Code parity. The implementation
does not discover CLI credential files or install product sign-in UI.

A second isolated CLI probe used the current public `@anthropic-ai/claude-code@2.1.284` npm package with a fake key and localhost-only synthetic SSE. Its published `sdk-tools.d.ts` and captured JSON tool schemas provided 14 conditional CLI client definitions; an older 2.0.76 public package also contains a minified `cli.js` for historical static inspection. See `/brain/outputs/nanoclaude/cli-js-investigation.md`. This is not evidence of live model, OAuth, or web behavior.

Provider-executed tool definitions can explicitly select current web search/fetch (20260318) and code execution (20260521) versions. The Messages collector preserves MCP listing/results and Bash/text-editor code-execution result blocks in assistant history; the code-execution container ID is replayed within a session. Client handlers may return multimodal Claude `tool_result` blocks. Neither provider code execution nor server web results share the local workspace, and no provider calls have validated these synthetic paths.

The `workspace-files` Cargo feature adds an **explicit** `ClaudeBuilder::workspace_files(Arc<ClaudeWorkspaceFiles>)` registration for `Read`, `Edit`, `Write`, `Glob`, and bounded-regex `Grep`. Construct `ClaudeWorkspaceFiles::new` only for a host-authorized, OS-isolated root; no file or Codex tool registry is installed by default. These are bounded text prototypes, not full Claude Code tool parity or a sandbox. Additional opt-in `.notebook(Arc<ClaudeNotebook>)`, `.tasks(Arc<ClaudeTasks>)`, and `.sandbox_bash(Arc<ClaudeBash<E>>)` builders register Claude-only names; Bash requires a host-provided sandbox executor and does not fall back to the ambient Mac shell. Task state is session-local; NotebookEdit requires a host-isolated root and explicit cell IDs for replacement/deletion. See [the tool implementation matrix](CLAUDE_TOOL_MATRIX.md) for every known family and remaining native executor/permission work.

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

## Authenticated Claude Code 2.1.284 wire follow-up

A controlled live run using the already authenticated Claude Code CLI and a short-lived process-scoped TLS measurement relay confirmed the client-managed compaction exchange, tool-result ordering, deferred tool discovery and the two-layer client `WebSearch` to nested server `web_search_20250305` path. It sampled 20 successful `-p` prompts plus valid persisted continuation and two compactions under an explicit 100k-token auto-compact window. Main subscription requests had four system text blocks (two cached with `ttl:1h`), adaptive thinking `display:updates`, `diagnostics.previous_message_id` on follow-ups and ordinary Claude content-block history. The CLI used an Authorization header, with no value captured.

The draft now has an **opt-in, local** `client_tool_search()` registry (returns Claude client `tool_reference` blocks and advertises discovered functions only afterward), and `.nested_web_search(deferred)` which makes an independent streamed Messages call with Anthropic's basic server search, then converts its result into a bounded string client `tool_result`. One synthetic test covers deferred discovery, nested search, summarization and continuation. To use deferred search, chain `.client_tool_search().nested_web_search(true)`; immediate search is `.nested_web_search(false)`. The interactive trace corrected the nested search's `tool_choice` to `auto`; auxiliary search may incur provider charges. This is distinct from the injected `ApprovedWebProvider` adapter and from adding a server search tool to the main request. Both paths require an explicitly approved provider/credential; neither reads Claude Code's local login.

Context handling now allows caller-supplied cached system blocks (`system_blocks`), 1-hour top-level cache (`cache_one_hour`), opt-in adaptive thinking, documented keep-all-thinking context management and `message_diagnostics()` continuity hints. Compaction remains an ordinary streamed summarization request with the currently available tool catalog and atomic replacement at a completed boundary; its trigger reserves up to 20k output tokens plus 13k margin rather than blindly using 95% on normal windows. This **does not reproduce** the private CLI system prompt, exact text layout, dynamic preflight token accounting, full diagnostics semantics, all context variants, or first-party request-class header. It has only synthetic loopback tests, not a live Nanoclaude subscription call. `ClaudeAuthProvider` remains a seam for the separately approved integration; observed first-party CLI identity headers are not a recipe to impersonate the CLI.

## Interactive TTY correction (actual `claude`, not `-p`)

[Credential-redacted interactive report and trace](research/nanoclaude-interactive-tty.md) supersede extrapolations from print mode. In 14 default interactive synthetic turns and two manual-permission turns, the CLI created an auxiliary Haiku title request, advertised a different initial catalog, handled AskUserQuestion and Edit in native terminal permission UI, spawned a distinct subagent request class with asynchronous handback, and packed additional system-role Messages. Its client `WebFetch` directly fetched the public page and made a *separate Haiku summary request*; it did not invoke the Anthropic server `web_fetch` tool. The documented/public API server search/fetch tools remain available as distinct opt-in capabilities, not substitutes for Claude Code client tools.

`web_fetch_with_source(approved_source, deferred)` (with the `workspace-files` feature) now offers an explicit, **synthetic-tested approximation** of the observed fetch→auxiliary-summary layers. The host must implement `ApprovedWebFetchSource` with permission checks, public DNS and redirect enforcement, byte limits, and no ambient credentials; the adapter itself does not contact websites or replicate the CLI's `/api/web/domain_info` service. It returns one string Claude `tool_result`. `client_tool_search`'s schema now requires both `query` and `max_results` as observed. Neither UI authorization, asynchronous subagents, private prompt packing, exact result formatting, nor the trusted-program OAuth integration is implemented by this prototype. Do not claim full interactive parity from these tests.
