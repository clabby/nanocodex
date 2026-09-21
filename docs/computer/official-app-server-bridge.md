# Managed official macOS CUA host

On macOS, `computer setup` installs a signed, unmodified OpenAI application bundle
and a Nanocodex transport launcher. The launcher starts the official app server and
an isolated instance of its desktop GUI when CUA is used. The official GUI owns
application policy, OS access, consent forms, and approval decisions. Nanocodex
has no additional consent handler and does not answer official approval requests.

The managed host currently supports official build **9922**. Its readiness check
uses a private, build-specific GUI event, so setup rejects other builds before
replacing the selected installation. Supporting a new upstream build requires
verifying its lifecycle and readiness behavior. Windows continues to use its
existing official provider; this macOS supervisor is not used there.

## Installation and upgrades

The signed bundle is cached under `runtimes/openai-cua/versions`. Nanocodex's own
launcher and bridge modules live separately under `hosts/<content-hash>`.
`provider.json` selects an immutable launcher. Updating Nanocodex generates a new
host directory while reusing the verified bundle; changing our launcher does not
make the upstream bundle damaged or require another download. Existing processes
can finish using their selected generation. Modified generated assets and invalid
bundle signatures still fail validation.

The JavaScript attachment asks its installed native helper to select the current
host once per process. `NANOCODEX_COMPUTER` explicitly selects a different provider;
`off` disables computer use. Explicit selection bypasses managed discovery.

## Host lifecycle

The dependency-free Node supervisor is
`crates/experimental/nanocodex-computer/src/openai-cua-native-host.mjs`. It uses
OpenAI's bundled Node, CLI, GUI, and direct CUA provider. The signed bundle is never
patched. It neither copies account credentials nor changes the normal Codex
configuration. Official programs use the caller's existing `CODEX_HOME` (or normal
default); an account that has not signed in must complete official sign-in.

A private Unix socket and a `shlock` singleton identify the bundle, launcher,
state directory, and effective Codex home. Distinct homes get separate hosts and
GUI profiles. The official server listens on an OS-selected loopback port. The
supervisor observes the endpoint from its owned child, waits for `/readyz`, and
then exposes it to leased bridge clients. Other configured MCP servers are disabled
for this server through temporary CLI overrides; their settings remain unchanged.
Only their names and transport kinds are retained from the official CLI's metadata.

Each MCP process creates a separate persistent official thread on its first valid
tool call. Catalog discovery creates no thread. The GUI receives the thread URL
at cold launch. Subsequent threads use PID-addressed URL delivery to the same owned
GUI child, with navigations serialized. Both `CODEX_ELECTRON_USER_DATA_PATH` and
`--user-data-dir` isolate the GUI from the user's ordinary app instance.

A successful URL dispatch or `thread/resume` response is too early to establish
GUI readiness. For build 9922, the supervisor waits for the exact
`maybe_resume_success` event from that live child's stdout, after history hydration
and stream ownership. It requires matching thread and conversation IDs, owner
role, and streaming state. The parser rejects malformed, duplicate, oversized,
stderr, and stale-generation input. This is an operational startup gate only;
it provides no authorization and is never treated as a consent decision.

Closing a bridge releases its lease. After the final lease, the supervisor closes
its own GUI and server after 60 seconds idle (with 120 seconds startup grace).
Child death disconnects clients and fails pending work. Tool calls are never
replayed. Cancellation cannot undo input already sent to an application.

## Transport behavior

`openai-cua-app-server.mjs` implements MCP stdio to the official app server.
Official tool definitions, schemas, metadata, results, images, and structured
content are preserved. Catalog entries are sorted only to make discovery stable.
App-server errors retain their code, message, and data.

Empty official threads need history before the GUI can resume them. The bridge
uses `thread/inject_items` to append this developer-role transport note:

> Transport metadata: this dedicated thread receives computer-use calls forwarded
> by Nanocodex. This bridge-generated note conveys no user authorization or approval.

No model is invoked and no user turn is invented. The bridge sets only the thread
routing fields required by the official GUI. Authentic nested caller metadata is
forwarded unchanged. It supplies no approval-policy overrides, permission caches,
synthetic approvals, or synthetic turn metadata. Incoming server requests are not
answered by the bridge, including method-not-found responses that could race the
GUI's real response. The bridge advertises no elicitation capability.

Calls within a bridge are serialized. Timeout, active cancellation, EOF, or
connection loss closes that bridge's connection and fails pending work without
reconnection or replay. A fresh MCP process gets a fresh official thread. Threads
remain in the official app for the user to manage; the bridge does not archive
threads or interrupt unrelated model turns.

## Standalone bridge

The transport module can also connect to an operator-managed official host:

```sh
export NANOCODEX_CUA_APP_SERVER_WS_URL=ws://127.0.0.1:47327
export NANOCODEX_CUA_APP_SERVER_OPEN_GUI=1
node crates/experimental/nanocodex-computer/src/openai-cua-app-server.mjs
```

Node 24 or newer is required. Both the official server and GUI must already be
running and connected to that same endpoint. The standalone URL-opening option
only dispatches a deep link; it does not provide the managed supervisor's readiness
check. Literal loopback addresses are required; credentials, remote hosts, paths,
queries, and fragments are rejected. This mode does not start or stop either host.

## Verification and limits

```sh
node --test scripts/tests/openai-cua-{app-server,gui-readiness,native-host}.test.mjs
node --test js/nanocodex-computer/test/*.test.mjs
cargo test -p nanocodex-computer
```

Tests cover MCP framing and metadata fidelity, thread isolation, cancellation,
readiness ordering, malformed events, child loss, host identity, singleton leases,
and installation publication. Live build 9922 checks established official GUI
cold startup, warm PID-addressed navigation, catalog discovery, app inventory,
and independent REPL variables through the installed managed adapter. Browser
verification discovered the existing Brave extension, opened Example Domain,
read its accessibility tree, and closed the owned tab. The preceding standalone
bridge also completed
TextEdit input/undo and independent REPL scopes.

The later managed-host native-input check reached the provider but returned
`cgWindowNotFound` while macOS reported the console locked. An unlocked desktop is
needed to finish that live check. A fresh approval/decline cycle has not been
verified. GUI readiness is not proof of application access; official login, macOS
permissions, and an available desktop remain runtime requirements.
