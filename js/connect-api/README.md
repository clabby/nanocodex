# Connect API

## Fresh connector status for connected apps

`GET /v1/grants/:grantId/connectors?providers=spotify,soundcloud` returns:

- `account_id`, `agent_id`, and the current `grant` projection;
- `connectors`, containing only the requested API providers and their currently
  connected identities selected by this grant.

Send the grant's opaque bearer token, `x-nanocodex-app-id`, and the registered app
`Origin`, as with other grant routes. The endpoint validates the current grant,
expiry, app binding, and live connector identities on every request. Responses
are `no-store`; consumers must not cache the authorization decision.

`providers` is a required, comma-separated, non-duplicated list of API connector
capabilities. ChatGPT is excluded because its credential status lives in a
separate broker. This endpoint never reads Vault credentials, account balances,
or the account's authorization index. It returns no provider credentials or grant
bearer token. Use account-info when the full account summary is needed.

### Live output checkpoints

`GET /v1/grants/:grantId/agents/:agentId/checkpoints?turn_id=<id>&after=<revision>`
returns the newest complete intermediate output for one retained turn. It requires
`agent.output.final` plus either `agent.output.actions` or `agent.trace.read` on
an active grant. No new grant approval is needed. Cross-grant turns are not visible.

The agent writes immutable files under
`/brain/connect/<grantId>/outputs/<turnId>/checkpoints/r<N>/`, then atomically
writes `checkpoints/latest.json` last:

```json
{"revision":1,"files":[{"path":"r1/model.step","sha256":"<lowercase SHA-256>","size":123}]}
```

A manifest has 1–8 files, at most 1 MB each and 4 MB total. Names are bounded ASCII
basenames with no nested paths. The service verifies size and SHA-256 and atomically
retains one coherent bundle per turn. A partial, invalid, stale, or replayed revision
leaves the last validated bundle available. The JSON response includes `turn_id`,
`revision`, and each file's metadata plus `data_base64`. `204` means no validated
checkpoint yet; `304` means no revision newer than `after`. Responses are `no-store`.

Checkpoints survive observer disconnects and turn archival. They are intermediate
previews, not completion receipts. The final immutable artifact publication excludes
the `checkpoints` directory; agents must still publish the requested final outputs.
Session deletion removes retained snapshots and fences pending reads.

## App-scoped conversations

Apps can explicitly request `urn:nanocodex:agent:threads:app` in the signed
`capabilities.auth.resources` array and set
`capabilities.agent.conversationHistory: true`. Connect displays this permission
as **App conversations**. The resulting grant contains `agent.threads.app` and
`agent.history.read`. This cannot be combined with a single `conversationId`.
Existing grants do not acquire multi-thread authority from history or trace
access alone; they require a fresh approval with the new resource.

Send the captured grant bearer token, `X-Nanocodex-App-Id`, and exact approved
`Origin`, as for other grant routes. Under `/v1/grants/:grantId`:

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/threads` | — | `{ threads, next_cursor? }` |
| POST | `/threads` | `{ operation_id, title? }` | 201 `{ thread, connection }` |
| GET | `/threads/:threadId` | — | `{ thread, connection }` |
| PATCH | `/threads/:threadId` | `{ title }` | `{ thread }` |
| DELETE | `/threads/:threadId` | — | 204 |

A thread is `{ id, title, created_at, updated_at }`. Its ID is a UUIDv4;
timestamps are epoch milliseconds. Titles contain 1–200 characters and are
trimmed. A missing creation title becomes `New conversation`. Listing returns
at most 100 storage rows per page in ID order; follow `?cursor=next_cursor` until
omitted, including when a page contains no live rows. Deletion tombstones can
occupy a page. `updated_at` records creation, rename, or deletion, not message
activity. Apps may sort the complete list by that timestamp.

`connection` is the normal Connect wire response, preserving the grant ID and
bearer token while selecting `agent_id` and `grant.conversation_id`. The managed
agent ID is distinct from the thread UUID. A client using published SDK 0.6.6 can
call these endpoints through authenticated `client.fetch`, adapt the normal wire
response to `Connection`, and pass that selected connection to
`client.agent.create({ connection, tools })`. Capture that connection and its
token in each agent transport; a mutable global selection must never retarget
an existing agent instance. The initial grant's default agent is not an app
thread: list/open or create a thread before using the app-thread agent API.

The server chooses a persistent namespace from the exact app ID, exact origin,
broker account, and authenticating owner. Wallet addresses are case-normalized;
host owners include issuer, tenant and principal ID. Host sessions are validated
live, while new valid sessions for the same owner can reopen that owner's
threads. Callers cannot provide a namespace, owner, or agent ID when creating a
thread. Different linked wallets or host principals sharing a broker account
remain isolated. Existing private account conversations and legacy Connect
agents are not imported into this namespace.

Every agent relay and WebSocket ticket checks the selected agent's live thread
membership. Ticket redemption checks it again; ongoing grant socket checks
also revalidate membership. SSE relays check before their first event and at most
every five seconds thereafter, including idle streams, and close on token
revocation, expiry, host-session invalidation or deleted membership. Revoking/expiring the grant removes authority without
deleting its owner's conversations. A new explicitly approved grant in the same
scope can reopen conversation history, read agent state, and send new turns.
Reconnect the SDK tool host using the current grant and approved app-tool catalog
before sending those turns. The managed runtime binds each tool-host route to
its grant ID and catalog digest; a socket from the previous grant cannot serve
a new grant's turn. Existing managed-runtime
per-grant fences still apply to idempotent replay, steering/withdrawal receipts,
artifacts and checkpoints from turns issued by another grant; this endpoint does
not substitute an old grant's authority for the active one. Plain turn cancellation
uses the managed runtime's existing authorization behavior. Missing and foreign
IDs both return `404`.

Deletion revokes membership before managed-agent cleanup. A cleanup failure
returns `503 thread_delete_unavailable`; retrying the same DELETE is safe and
completes the cleanup. The hidden thread cannot be reopened or used meanwhile.
Creation requires a client-generated UUIDv4 `operation_id`, retained for the
intended creation until it resolves. Repeat the same ID and original title after
an uncertain result; the operation is reserved durably before provisioning. Only
the first reservation dispatches creation, with a scope-derived managed
idempotency key as an additional fence. A pending or unknown creation returns
`503 thread_creation_unresolved`; replays only check for a published receipt and
never repeat upstream provisioning. If the first dispatch cannot publish its
receipt, the operation remains fenced and requires operator reconciliation;
automatic retries cannot recover it by creating a new operation. Concurrent
retries can return this pending response until the first request publishes. A changed title for
the same operation returns `409 thread_operation_conflict`; retrying creation
after that thread was deleted returns `410 thread_deleted`. Use a fresh operation
only for a new intended thread. Replays return 201 with the same thread and the
current grant's connection wire.

Run `node --test test/appThreadsWorker.test.mjs` from this package (Node 24).
The journey starts an actual local workerd HTTP listener and real Durable Object
storage. Synthetic external identity and managed-agent providers exercise the
Connect trust boundary without live accounts or model calls. HTTP status traces
are emitted as test diagnostics; capture generated evidence under root `output/`.

## Remote MCP with Connect OAuth

The canonical account Worker forwards `/mcp`, `/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server`, and `/oauth/*` to this Worker. The public
origin is preserved throughout discovery, consent, code redemption, and resource
requests. See [client setup and supported tools](../../docs/connect-mcp.md).

`oauthMcp.mts` owns public-client registration, exact redirect binding (with only
RFC 8252's native loopback port exception), S256 PKCE, one-time authorization
codes, resource-bound access tokens, rotating refresh tokens, and RFC 7009
revocation. Registration metadata grants no account authority. The existing
hosted account authorization service must exchange a user-approved code whose
resources include this exact pending request. The user can select a nonempty
subset of requested scopes; the signed resources and issued scope must match.

MCP OAuth tokens are separate from internal Connect grant credentials. Every
resource call resolves the token family and current grant; revocation, expiry,
app/owner binding, and approved capabilities remain live checks. Refresh-token
reuse fences the entire family before revoking its underlying grant. MCP tool
adapters construct managed assertions internally and reuse the connector broker's
provider and selected-identity enforcement. They never forward caller-supplied
internal authorization headers or return the underlying Connect token.

`mcpServer.mts` implements stateless JSON Streamable HTTP for MCP 2025-03-26,
2025-06-18, and 2025-11-25. It advertises only implemented tools, accepts
notifications without executing calls, and returns 405 for GET/DELETE. The
newer 2026 transport and client-ID metadata documents are not advertised.

Run `node --experimental-strip-types --test test/mcpServerWorker.test.mjs` from
this package under Node 24. The journey exercises the shipped Worker on an
actual workerd HTTP listener, real Durable Object storage, and the official
MCP JavaScript client. Only the external account/provider services use synthetic
fixtures. The test emits a bounded HTTP transcript and authorization/dispatch
assertions; keep per-run evidence in ignored `output/`.

## MACH wallet funding

The account site's `/v1/machine-usd/config` and `/v1/machine-usd/orders` routes
use MACH's private `OnrampApi` contract: `GET /v1/config`, `POST /v1/orders`,
and `GET /v1/orders/ord_<32 lowercase hex digits>`. Mercator's public
`/v1/onramp` routes are not an onramp transport.

Configure one transport on the Connect Worker, including each preview environment
that should support funding:

- In the MACH Worker's Cloudflare account, add an optional `MACH_ONRAMP` service
  binding to the MACH Worker with `entrypoint: "OnrampApi"`.
- Across Cloudflare accounts, use MACH's authenticated onramp relay. Configure
  `MACH_ONRAMP_RELAY_URL` as its fixed HTTPS origin (no path, query, or userinfo)
  and provision the same secret of at least 32 characters as
  `MACH_ONRAMP_RELAY_TOKEN` on both Workers using secret management. The relay
  binds to `OnrampApi` inside MACH's account. See
  [MACH relay setup](https://github.com/tempoxyz/mach/blob/main/docs/nanocodex-onramp-relay.md).

The private binding takes precedence. An absent or invalid transport returns
`503 machine_usd_unavailable`; there is no public-endpoint fallback. Adding a
binding name without provisioning its target does not enable funding. Relay
credentials never reach the browser, and account cookies never reach MACH.
Only the three config/order routes cross the relay; redirects are rejected.
A transport failure can mean order creation succeeded. Retain the exact body,
capability and idempotency key when retrying.

The account proxy resolves the persistent account's Worker-owned wallet through
`/v1/me`, overwrites client-supplied recipients, requires the same browser Origin
for creates, and scopes idempotency keys to the wallet. Status requires both the
account session and order capability. Responses must match the wallet, amount,
order ID and canonical MACH amount. Completion requires fulfilled issuance and
a transaction hash, not payment success alone.

The UI retains its account-bound intent in session storage before dispatch,
opens Stripe through an explicit link in a new tab, and polls on the original
Nanocodex page. Reloading or a temporary failure can be recovered by selecting
Add funds again: the existing order is checked and identical create inputs are
replayed when necessary. Closing checkout does not complete or cancel an order.
Polling stops after 15 minutes and retains the intent for recovery. A fulfilled
order refreshes the wallet balance. Hosted checkout's return destination is
controlled by MACH; arbitrary browser return URLs are not forwarded.

Validation (Node 24, installed workspace dependencies):

```sh
node --experimental-strip-types --test js/connect-api/test/machFunding.test.mjs
MACH_RELAY_SOURCE=/absolute/path/to/mach/src/onramp-relay.ts \
  node --experimental-strip-types --test js/connect-api/test/machFunding.test.mjs
WALLET_BROWSER_CHANNEL=chrome node js/account/scripts/wallet-smoke.mjs
```

The HTTP journey bundles the shipped Connect Worker and runs the account handler
over local HTTP, with synthetic account authentication and an external MACH
provider fixture. `MACH_RELAY_SOURCE` adds the actual companion relay to that
journey. The browser journey exercises the production funding hook and card with
synthetic HTTP responses on desktop and mobile. Neither journey charges a card
or deploys a Worker. Logs and browser screenshots belong under ignored `output/`.
