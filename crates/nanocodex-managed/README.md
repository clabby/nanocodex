# nanocodex-managed

Native account-managed lifecycle backend for Nanocodex. The crate owns the
authenticated managed HTTP service, resumable durable event stream, and
optional reverse attachment of a caller-owned `Tools` recipe. The cloud owns
model execution and retained history; this crate never reads provider
tokens or application environment variables.

`Managed::create` and `create_live` resolve the authenticated account catalog
default when no explicit `with_settings` policy is supplied.
`ManagedClient::create_with_settings` sets the initial model policy atomically.
The existing `set_model`, `set_thinking`, `set_reasoning_mode`, and
`set_fast_mode` methods patch individual fields for subsequent turns.

Managed model policy uses `ManagedModel`: native Responses identities convert
through `From<Model>`, while Claude identities remain managed-only. Use
`AgentSettings::new(model)` for a standard policy with model-specific default
effort. Existing native `set_model(Model::...)` calls remain supported; explicit
settings struct literals now use `model: Model::Sol.into()`. The common native
agent handle still has its Responses-only model setter; use the managed client
or initial managed settings to select Claude.

`ManagedClient::models()` reads authenticated `GET /v1/models`. Its catalog is
authoritative for account availability; known local identities are not proof
that a subscription is connected. Claude models support only the returned
low/medium/high efforts, standard reasoning, and no fast mode. The catalog also
projects `partial` and public provider `availability`: an unavailable Claude
catalog does not hide healthy OAI entries, but an explicitly selected Claude
model is never coerced into a healthy OAI fallback.

Direct-account subscription sign-in uses `claude_login_start`,
`claude_login_status`, `claude_login_complete`, and `claude_disconnect`.
The caller must obtain explicit user authorization and collect completion input
privately using `ClaudeLoginCode`, never from a prompt or agent tool. Pending
`ClaudeLogin` URLs include private state: they are for a private browser, not
logs or retained conversation data. Both types redact Debug; completion input
zeroizes on drop. Auth responses and errors expose only bounded public states,
not provider payloads or tokens. Auth writes are single-shot, including protocol
failures; inspect status after an unknown outcome rather than replaying a code.
Authorization destinations must match the registered native manual flow: exact
`https://claude.com/cai/oauth/authorize`, public `code=true`, registered client
and manual redirect, response type, scopes, state, and S256 PKCE parameters.
Callback codes are not permitted in the destination URL.
Expiration timestamps are Unix milliseconds. Connect grants cannot manage
subscription credentials.

`ManagedClient::compact(agent_id)` and the common `agent.compact()` handle post
an empty authenticated body to `/v1/agents/{id}/compact` and validate synchronous
`{compacted:true}` acknowledgement. Compaction is never automatically replayed;
inspect retained history after an uncertain outcome. The server requires full
account authority and an idle session.

`ManagedClient::fork(parent_agent_id, idempotency_key)` posts an empty body to
`/v1/agents/{parent_agent_id}/forks`. The service returns a child `AgentReceipt`
from the parent's latest committed model boundary. Reuse the same key to
reconcile uncertain admission; no transcript or side prompt is submitted to the
parent.

Durable schedules are exposed through `triggers`, `trigger`, `put_trigger`,
and `delete_trigger`. `CronTriggerConfig` contains the complete cron expression,
timezone, prompt, enabled state, and `CronSessionMode` (`New` or `Continue`).
The client validates identifiers and input bounds; the managed service validates
schedule syntax and timezone semantics. `put_trigger` replaces a named schedule
using PUT. Schedule receipts include delivery timestamps and the last agent/turn.
