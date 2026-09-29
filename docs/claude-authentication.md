# Claude authentication

`nanocodex-claude` supports Console API keys, caller-supplied header providers,
and a Rust-owned subscription OAuth lifecycle. Authentication lives outside the
agent's durable transcript. Reopening an agent attaches the same subscription
manager and the same `DurableSession`; it does not place credentials in that
session or discover an installed Claude Code login.

## Subscription login

`nanocodex_claude::subscription::ClaudeSubscription` implements
`ClaudeAuthProvider`. The Rust manager owns PKCE, callback validation, token
exchange, expiry, rotation, identity continuity and logout. The embedding supplies
`ClaudeSubscriptionHost`: a private secret store with durable compare-and-swap,
and bounded HTTP. This is the same separation between provider lifecycle and host
capabilities used by the hosted ChatGPT integration.

The defaults were derived from the installed public Claude Code **2.1.283**
executable and checked against an isolated invocation of `claude auth login
--claudeai`. That invocation used an empty configuration, a browser stub and
blocked outbound networking. Extracted public functions were also exercised with
synthetic values. No existing CLI credentials were imported. The measured
protocol is versioned evidence, rather than a claim that these endpoints and
scopes will never change.

| Operation | Observed default |
| --- | --- |
| Subscription authorization | `https://claude.com/cai/oauth/authorize` |
| Public client registration | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| Code exchange and refresh | `https://platform.claude.com/v1/oauth/token`, JSON POST |
| Manual redirect | `https://platform.claude.com/oauth/code/callback` |
| Profile | `https://api.anthropic.com/api/oauth/profile` |
| Messages | `https://api.anthropic.com/v1/messages?beta=true` |
| OAuth request beta | `oauth-2025-04-20` |

Authorization uses independent random 32-byte state and verifier, S256 PKCE,
`response_type=code`, and `code=true`. The current default scopes are
`org:create_api_key user:profile user:inference user:sessions:claude_code
user:mcp_servers user:file_upload user:plugins`. The configuration accepts an
integration's own client registration, endpoints and scopes. These are the current
CLI defaults, not the older `claude.ai` / `console.anthropic.com` endpoints.

Call `begin_login(ClaudeLoginMode::Manual)` and present the returned
`authorization_url` to the account owner. Complete it with the browser's
`code#state` through the application's private input path. For an application-owned
callback, use `ClaudeLoginMode::Callback { redirect_uri }` and pass the callback
URL to `complete_login`. The host supplies the callback listener or route.
Both paths validate state; callback URLs must also match the stored origin and
path. Pending login survives reopening the secret store. Login URLs and codes
must not enter model prompts, tool results or agent history.

After login, construction uses the ordinary agent and durability APIs:

```rust,ignore
use std::sync::Arc;
use nanocodex::{Claude, DurableAgentExt, Nanocodex};
use nanocodex::claude::{ClaudeClient, subscription::*};
use nanocodex::durability::DurableSession;

// `host` implements ClaudeSubscriptionHost using private secret storage and HTTP.
let subscription = Arc::new(ClaudeSubscription::new(
    host, "account-provider-connection", ClaudeSubscriptionConfig::default(),
)?);
let client = ClaudeClient::subscription(reqwest::Client::new(), subscription);
let state = DurableSession::open(agent_store, "agent-session").await?;
let (agent, events) = Nanocodex::builder(Claude::latest(client))
    .cache_one_hour()
    .keep_thinking()
    .durability(state).await?
    .build()?;
```

Enable `claude` on the `nanocodex` facade; its existing default durability feature
includes the Claude adapter. Direct crate users enable `claude` on
`nanocodex-durability`. `ClaudeClient::subscription` selects the observed Messages
route and consumes the manager's headers. It does not inject Claude Code's private
system prompt, billing attribution or product identity. Authentication beta
headers are combined with request feature betas, so context management remains
enabled alongside OAuth. Tools, nested model requests and compaction share that
same authenticated client.

## Credential persistence and failures

The host stores the opaque payload separately from `DurableSession`, encrypted at
rest and scoped to the account/provider connection. Store revisions are monotonic,
including across logout. HTTP must disable redirects and automatic retries,
respect the request deadline, and enforce the response bound while streaming.
Request/response Debug output and errors redact credentials; hosts must keep raw
bodies, authorization headers, codes and storage payloads out of logs.

Token exchange is claimed in the secret store before POST. A successful rotation
is staged durably before the replayable profile GET; a restart can finish profile
validation without repeating the exchange. CAS prevents a late login or refresh
from replacing a newer login or undoing logout. Identity changes are rejected.
If an exchange may have consumed a code or refresh token but its outcome was not
stored, the manager reports an uncertain exchange and requires a fresh login.
It does not guess that the remote POST failed and replay it.

Messages retries once after an explicit HTTP 401. A late rejection of an older
token cannot invalidate its replacement. The client does not automatically replay
403, 429, transport failures or an accepted stream. Refresh scope negotiation
allows one separate POST after a definitive `invalid_scope` rejection, using the
exact previously granted scopes. Expired refresh grants, invalid grants and an
account-on-hold response have explicit lifecycle outcomes. Logout commits its
local fence before best-effort provider revocation. Token exchange and agent
execution have separate recovery rules: uncommitted model/tool effects retain the
shared durability crate's at-least-once semantics.

`status()` returns public lifecycle state and authenticated account/organization
identity, never token values. The credential lifecycle is Rust/WASM portable;
the host remains responsible for storage placement, callback UI and networking.
This library does not install the product's sign-in screen or JavaScript provider
selection.

## API keys and other token sources

`ClaudeClient::official(http, api_key)` uses an explicitly supplied Console API
key. `RefreshingClaudeAuth` and `ClaudeTokenSource` remain available for a host
credential broker such as Workload Identity Federation. That adapter caches
usable tokens, serializes refreshes in one instance and rejects expired or malformed
replacements. The source owns its actual exchange and persistence. See Anthropic's
[API authentication documentation](https://platform.claude.com/docs/en/manage-claude/authentication).

## Verification and support boundary

Run `cargo test -p nanocodex-claude --test subscription --test auth_lifecycle` and
`cargo test -p nanocodex-durability --features claude,sqlite --test claude_subscription`.
The composed journey performs login, a signed tool round, compaction, real SQLite
reopen, 401 recovery and refresh rotation, terminal replay without another model
request, and logout. Provider traffic in these tests is synthetic loopback HTTP.

The CLI probe establishes emitted protocol behavior; it does not establish a
live login, subscription eligibility, billing, or acceptance of the native
backend's request by Anthropic. A fresh end-to-end provider authorization remains
the live integration check. Anthropic documents third-party subscription use under
its applicable approval terms in the [Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview),
and explains the user login paths in [Claude Code authentication](https://code.claude.com/docs/en/authentication).
