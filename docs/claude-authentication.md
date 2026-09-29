# Claude authentication

`nanocodex-claude` is a native Messages client. `ClaudeClient::official(http,
api_key)` uses a caller-supplied Console API key. It does not discover credentials
from the environment, Claude Code files, or the operating system keychain.
Credentials are not serialized into agent or durability state.

## Host-managed bearer tokens

For a documented API token source or a separately approved integration, implement
`ClaudeTokenSource::refresh` in the embedding application. Wrap that source in
`Arc<RefreshingClaudeAuth>` and pass it to `ClaudeClient::with_auth_provider` with
an explicitly selected endpoint. Reuse the same auth instance across clients for
one identity.

The host supplies a `ClaudeAccessToken` with a `web_time::SystemTime` absolute
expiration (the standard-library type on native targets). Authentication callbacks
return `ClaudeAuthFuture`: `Send` on native runtimes, isolate-local on WASM so
the host can await browser fetch. The provider
caches it until the configured refresh margin, serializes refreshes within the
instance, rejects unusable replacements, and marks the authorization header
sensitive. A Messages HTTP 401 invalidates only the rejected credential and permits
one retry; a late rejection cannot evict a newer token. Other HTTP failures,
transport failures, and failures after a stream starts are not replayed by the
authentication layer. Existing header providers retain their no-retry behavior
unless they implement `recover_unauthorized`.

The source must enforce account identity, acquire a replacement when called,
persist any rotated refresh credential before returning, and coordinate across
processes when necessary. It also owns exchange timeouts, cancellation safety,
backoff, and terminal revocation. The library deliberately supplies no token
exchange endpoint, client registration, scopes, or refresh-token storage. This
interface is an integration boundary, not an installed OAuth login flow.

Anthropic documents API keys and short-lived Workload Identity Federation tokens
for direct API authentication. A host using WIF can implement the source with its
configured federation rule and identity provider; this library does not configure
that infrastructure. See [API authentication](https://platform.claude.com/docs/en/manage-claude/authentication)
and [API overview](https://platform.claude.com/docs/en/api/overview).

## Subscription support boundary

The native Messages client does not currently provide subscription login.
Anthropic's [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
describes the SDK as running the Claude Code binary and requires prior approval
for third-party products offering Claude.ai login or subscription rate limits.
The [Claude Code authentication terms](https://code.claude.com/docs/en/legal-and-compliance)
allow end users to sign into the unmodified Claude Code binary with their own
subscription, including a hosted binary under the stated conditions. This is a
separate runtime integration, not a documented OAuth token-exchange contract for
a replacement Messages client.

The [subscription SDK article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says in its June 15, 2026 update that the announced billing changes were paused
and SDK, `claude -p`, and third-party app usage still draws from subscription
limits. The older monthly-credit proposal below that update is explicitly marked
as no longer taking effect. That article does not publish a client registration
or token protocol for this native backend.

For a separately approved subscription program, the remaining prerequisite is
its technical integration contract, not another assertion of approval. This
repository does not contain that program-specific contract: client registration,
allowed redirect/PKCE flow, scopes, exchange and refresh endpoints, and routing
requirements. Configure the host source from the approved contract; do not
substitute Claude Code's client identity or private credentials.

## Verification

Run `cargo test -p nanocodex-claude --test auth_lifecycle --test messages`.
The auth journeys use synthetic tokens and loopback HTTP only. They cover
concurrent refresh and a delayed stale 401, bounded repeated rejection, refresh
failure without an unauthenticated retry, unusable tokens before HTTP, and
non-auth failures without replay. No live subscription integration is implied.
