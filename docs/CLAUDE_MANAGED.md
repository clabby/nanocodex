# Managed Claude subscriptions

The managed platform has an account-scoped Claude subscription connection and a
native Messages execution path. It does not translate Claude through OpenAI
Responses or borrow an installed Claude Code login. The OpenAI and Claude tool
runtimes remain separate.

## Connect privately

In the web account's **Connections** section, choose **Claude → Connect**. Native
clients expose a Claude subscription section in their connection/account settings.
Open the provider sign-in page, approve access, and paste its `code#state` into the
dedicated private authorization-code field. Never paste the code into a chat.

The default uses the provider-registered manual callback. It does not assume a
Nanocodex HTTPS callback is registered for the public provider client. The actual
Rust `ClaudeSubscription` lifecycle owns PKCE, exchange, profile validation,
refresh, continuity, uncertain-exchange fencing and logout; the broker stores its
opaque state encrypted with durable compare-and-swap. Credentials and pending
OAuth material are separate from conversations, tools, checkpoints and logs.

The authenticated account API is:

| Request | Result |
| --- | --- |
| `POST /v1/credentials/claude/login` | Safe pending status, authorization URL and expiry |
| `GET /v1/credentials/claude/login` | Safe lifecycle status |
| `POST /v1/credentials/claude/login/complete` with `{ "code": "code#state" }` | Profile-validated status, or a detail-free failure |
| `DELETE /v1/credentials/claude` | Local connection removed; best-effort provider revocation |
| `GET /v1/credentials` | Safe connection metadata; no credential material |
| `GET /v1/models` | Account-available managed model catalog |

Expiry values are epoch **milliseconds**. Mutations require a persistent account
with full account authority and the normal same-origin checks. Connect grants
cannot connect a provider, obtain its credentials, or start Claude inference.
Native clients submit private form input directly to the account API, not via an
agent prompt.

If exchange or refresh may have consumed its one-use input but the result was
not retained, the manager reports an uncertain exchange. Refresh status and
perform a new explicit sign-in; do not automatically repeat the uncertain POST.
Disconnect fences the local grant before attempting revocation. It does not
claim to undo a previously accepted model request or external action.

## Model availability and session routing

A connected grant is not an entitlement to every model. The server obtains the
provider's authenticated model catalog and intersects it with models supported
by this runtime. A failed catalog lookup is an explicit availability error, not
a fabricated list or an OpenAI fallback. The picker and native clients consume
the authoritative catalog. A Claude-only account can select its catalog default
and start a conversation without first connecting an OpenAI credential.

Claude model and effort are pinned when a session begins execution. Stale,
disconnected or unsupported selections are rejected. Each request resolves its
current private grant through `SessionModelEgress`, which pins the provider
origin and strips host-routing fields before dispatch. Only an explicit provider
401 can trigger bounded credential recovery; ambiguous failures and accepted
streams are not silently replayed.

## Tools, durability and limits

Managed Claude sessions expose native `Bash`, `Read`, `Write`, `Edit` and supported
account/Hand capabilities. Discovery uses `ToolSearch`/`ToolExecute` and
`MCPToolSearch`/`MCPExecute`, not Responses tool-search declarations. Optional
`Task` children use real provider-pinned Claude sessions, durable receipts and
explicit uncertainty after interruption. The session's native prompt describes
these tools rather than instructing Claude to call Codex Code Mode.

Native Messages history, opaque content and completed receipts survive normal
Durable Object reopen in the shared durability store. Events retain streaming
assistant text and tool cards. This does **not** make OpenAI snapshots portable
to Claude. Managed Claude currently accepts text input only. Voice steering,
cross-provider child overrides, snapshot forks and portable import/export are
explicitly unsupported, rather than silently converting or discarding state.
See the [Claude runtime](CLAUDE_RUNTIME.md),
[JavaScript SDK](CLAUDE_JAVASCRIPT.md) and
[tool matrix](CLAUDE_TOOL_MATRIX.md) for the distinct library boundaries.

## Subscription wire compatibility

The subscription profile is explicit and shared by native and managed execution.
It prepares the compatibility system block before durable request freezing, merges
OAuth/feature betas and uses the subscription Messages route. Dispatch preserves
the prepared request; egress adds private authorization without rewriting its
body. Nanocodex retains its own HTTP User-Agent and native tool names.

The pinned [OMP v18.4.4 implementation](https://github.com/can1357/oh-my-pi/blob/v18.4.4/packages/ai/src/providers/anthropic.ts#L634-L709)
adds a different layer: a first-system-block Claude Code version fingerprint and
a `cch` checksum over exact serialized UTF-8 bytes, patched immediately before
OAuth fetch. Its nearby client code also uses Claude Code/JavaScript runtime
identity headers and prefixes custom tool names. Those are not OAuth exchange or
refresh operations, and that third-party implementation is not evidence that the
provider requires them for Nanocodex.

Nanocodex does not manufacture a Claude Code version/runtime identity or add that
billing checksum. The public transport journey checks unchanged wire bytes and
caller content, including Unicode and literal billing-marker text. Consequently,
OMP wire parity is **not** claimed. If a live admission check establishes an
additional protocol requirement, implement it in the shared native client before
request freezing, reconcile durable request identity and test the actual managed
outbound bytes; do not bolt a body rewriter onto managed egress.

## Deployment and acceptance

Build the shared WASM/package first, then deploy the private broker/egress and
managed service dependencies before the account application. A source change or
passing synthetic fixture is not proof of a production rollout. Real workerd
journeys exercise the shipped broker, Rust WASM lifecycle, account API and
SQLite session transport with synthetic upstream provider traffic. A separate,
user-authorized live managed login, catalog and inference smoke is still required
before claiming live provider admission or subscription billing behavior.
