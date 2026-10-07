# Nanoclaude architecture

`nanocodex-claude` implements a Claude Messages backend behind the common
`nanocodex-agent` lifecycle. It owns its provider wire format, streamed content,
tool loop, context management and compaction. The public `nanocodex` facade
exposes it through the `claude` feature. The existing OpenAI driver stays
independent; Claude content is never translated into Responses items.

| Concern | OpenAI backend | Claude backend |
| --- | --- | --- |
| Model wire | Responses items/events | Messages system, messages, content blocks and SSE |
| Client tools | Responses function/custom calls and outputs | Assistant `tool_use`, matching user `tool_result` |
| Compaction | Provider opaque compaction item | Client summary and atomic transcript replacement |
| Persistence | Shared durable admission, checkpoints and effect receipts | The same durability lifecycle with provider-native checkpoints |

## Construction and durability

```rust,ignore
use nanocodex::{Claude, DurableAgentExt, Nanocodex};
use nanocodex::claude::{ClaudeClient, Effort};
use nanocodex::durability::DurableSession;

let client = ClaudeClient::official(reqwest::Client::new(), console_api_key);
let session = DurableSession::open(agent_store, "session-id").await?;
let (agent, events) = Nanocodex::builder(Claude::latest(client))
    .cache_one_hour()
    .max_tokens(8192)
    .effort(Effort::Medium)
    .durability(session).await?
    .build()?;
let result = agent.prompt("Hello").await?.result().await?;
```

The host supplies authentication, the durable store and authorized tool handlers.
The same `.durability(state).await?.build()?` extension restores Claude
conversation, signed and opaque blocks, tool receipts, compaction state,
discovery, container identity and attached tasks. Completed requests replay their
terminal receipt. An unfinished effect without a committed receipt retains the
shared store's at-least-once semantics. Without `.durability(...)`, conversation
and tool replay protection are in memory only.

`Claude::latest(client)` currently selects `claude-opus-5-5`. Known coding models
use their configured context windows; unknown IDs default to 200K unless the
caller supplies `.context_window_tokens()`. The default output limit is 4096,
including adaptive thinking. Explicit `.context_window_tokens()` and
`.max_tokens()` settings should match the selected deployment.

See [runtime and recovery](CLAUDE_RUNTIME.md) for context estimates, cache marker
validation, compaction, cancellation, owner fencing and unfinished-effect
recovery. See [authentication](claude-authentication.md) for Console keys,
caller-owned headers and the Rust subscription OAuth lifecycle, including the
current live acceptance limits.

## Provider and host boundaries

Client tools are explicit registrations with Claude schemas. Server tools are
separate versioned definitions executed by Anthropic; their blocks never become
fabricated client results. Workspace, notebook, task, Bash, web, MCP and host
adapters expose only the capabilities their host supplies. The [tool
matrix](CLAUDE_TOOL_MATRIX.md) records implemented behavior and outstanding
families. OpenAI tool definitions are not implicitly installed in Claude.

The backend preserves signed thinking and opaque provider content, validates
complete SSE responses before dispatch, and fails unsupported lifecycle
operations explicitly. Compaction uses ordinary Messages requests with client
summary replacement, retaining active tool boundaries and omitting thinking
bound to the replaced prefix. It does not reuse an OpenAI encrypted compaction
item or claim the CLI's exact private summarization policy.

The native and WASM Rust libraries share this implementation. WASM compilation
does not establish a JavaScript API, browser/Worker execution, product sign-in,
or deployed host services. Whole JSON checkpoints also do not yet use the
OpenAI path's paged transcript storage. Full Claude Code product parity is not
claimed.

## Protocol evidence

The implementation uses public Messages representations and bounded observations
of the installed CLI. Interactive and print modes expose different, conditional
tool catalogs; a print-mode trace alone does not establish interactive behavior.
The [interactive TTY report](research/nanoclaude-interactive-tty.md) covers
questions, permission UI, subagent handback, client search and fetch. The
[compaction report](research/nanoclaude-auto-compaction-measured.md) describes
observed client summary requests and context replacement.

Those dated measurements establish their individual observed behavior. Current
APIs, supported capabilities and recovery guarantees are documented in the
runtime, authentication and tool matrix pages above. Synthetic HTTP/SQLite
journeys validate the library's failure and restart contracts separately from
provider-backed acceptance.
