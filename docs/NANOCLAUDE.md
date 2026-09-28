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
| Loop | Responses-specific retained response IDs, Code Mode, tool orchestration | Claude-specific tool loop and usage/cancellation; prompt-cache and retry policy pending |
| Compaction | Provider opaque compaction item | Claude Code 2.1.283-style client summary and transcript replacement; never treat an OpenAI encrypted item as a Claude block |

The initial `nanocodex-claude` crate now provides `ClaudeClient` and
`Nanocodex::builder(Claude::new(client, model))`: streamed text, caller-
registered JSON function tools with Claude `tool_use` / user `tool_result`
ordering, manual and 95%-threshold client-side summarization, cancellation,
usage, and shared lifecycle events. Its loopback E2E tests do not use a real
subscription credential. The Claude loop is independent of the OpenAI loop.

This is **not Claude Code parity**. Bare CLI 2.1.283 advertises native
`Bash`, `Read`, and `Edit` schemas; this crate currently exposes only explicitly
registered functions, not those built-ins or `nanocodex-tools`. Multi-modal
inputs and tool outputs, automatic instruction reload, full thinking policy,
steering, spawn/fork, snapshots, durability/preservation hooks and live auth
remain unimplemented; unsupported lifecycle operations return errors. In
particular, do not double-execute Claude Code CLI built-ins through an
OpenAI-style dispatcher. A native tool layer needs explicit execution,
permissions, effect receipts and cancellation semantics.

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
integration uses documented Claude Platform API credentials. The account owner
reports access to an Anthropic trusted subscription program for custom agent
clients; that mode requires the program's approved client identity, token
acquisition/refresh protocol, scope, and billing/routing terms before live
traffic is enabled. Do not copy Claude Code's local credentials, fake its
identity, or infer authorization from a working bearer token. The protocol
and agent-loop tests use only a synthetic localhost service.

The official Claude Agent SDK is a distinct subscription-backed alternative,
but that SDK owns the tool/model loop; it is not interchangeable with the
custom Claude backend. Avoid conflating these auth and execution modes.

References: [Claude tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls),
[Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming),
[compaction on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand),
[Claude Code context window](https://code.claude.com/docs/en/context-window),
[subscription and third-party access](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account),
[Agent SDK subscription access](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
