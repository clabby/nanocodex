# Installed upstream CUA runtime

Native Nanocodex, Nanocodex2, local Hands, and the JavaScript desktop runtime
provision OpenAI's CUA provider automatically on macOS and Windows. They expose
its actual MCP catalog, including descriptions, schemas, metadata, and visibility.
Production Code Mode remains QuickJS; the provider uses its own bundled Node.

The lean managed **macOS** launcher enables only the upstream `computer`
surface. Browser windows remain controllable through native UI, but dedicated
browser inventory/Tab/DOM APIs and the official Chrome native-messaging bridge
are not enabled. That bridge contains an app-server proxy and needs a separate
port before it can meet the no-Codex dependency requirement. Hosted browser CDP
and other Hands' screen providers are separate paths and are not changed here.
Mac setup regenerates Nanocodex host assets independently of the cached signed
bundle; a launcher update does not require `--refresh`.

```sh
nanocodex2 computer setup           # provision once or verify/reuse the cache
nanocodex2 computer setup --refresh # check OpenAI's feed and update changed components
# Both commands are also available as nanocodex computer setup.
```

`nanocodex setup` is the guided, resumable path: it signs in to the shared account,
installs CUA, and ensures Hand is connected. On macOS it does not install or offer
the official browser extension, whose native bridge still depends on app-server.
CUA uses the direct MCP host without the official Codex binary or desktop GUI.
The trusted host owns app-access consent; protected-target and OS permission
checks remain native. See [direct MCP host](direct-mcp-host.md).

The macOS updater range-fetches only signed CUA/Node components plus signature
metadata and the tiny signed main executable used only for attestation. The
official `codex` executable, Chrome plugin, Electron, `app.asar`, and frameworks
are excluded. A small Nanocodex MCP/lifecycle host handles explicit native-app
consent and the helper's narrow policy reads. No model, Codex thread, sign-in
state, or general app server is involved. Node, node_repl, and Sky are still
upstream binary dependencies; this is not a Sky-only distribution.

A running Hand retains its provider generation. Installing the new direct host
or reloading a TUI does not replace that configuration in the shared daemon.
Restart the Hand to activate it; existing JavaScript scopes and debugger
attachments do not survive. Old cached bundles containing Codex are not reused
as new direct-host generations or modified beneath running processes.

## Timeout ownership and cancellation

`timeout_ms` belongs to the upstream provider. Nanocodex forwards it unchanged and
awaits the provider result; it does not subtract queueing or startup time, supply
a default execution timeout, or abandon a call based on that argument. The macOS
direct MCP host likewise delegates tool execution timeouts to the upstream
provider while keeping trusted startup and native readiness deadlines. This applies to standalone and managed
bridges. An unresponsive tool remains governed by upstream timeout handling or
caller cancellation.

For direct MCP processes, the Rust adapter gives each provider startup a trusted
120-second cumulative deadline covering initialization and complete catalog
discovery. This applies both to `ComputerTools::connect` and to each conversation's
new provider process. It does not consume or derive from `timeout_ms`, and ends
before tool execution starts. Startup expiry discards that owned transport; a
conversation interrupted during startup requires explicit reset. The managed
macOS launcher also retains its separate phase deadlines.

Genuine caller cancellation discards only the affected conversation's owned
transport and marks its session interrupted. Other conversations retain their
sessions. A successful explicit `js_reset` is required before continuing; a failed
reset leaves the session interrupted. Follow reset with a fresh
observation of the intended surface. Closing the transport or resetting the
session is not proof that upstream/native input stopped. Effects may be uncertain;
never automatically replay that input.

## Browser selection

The lean managed macOS runtime does not expose the dedicated browser surface.
Use `cua.getApp` and the upstream native UI APIs for browser windows. Do not use
`cua.getTab`, `cua.createBrowserTab`, or DOM APIs on that launcher. A custom,
explicit browser-enabled provider may have different dependencies and semantics;
read its actual discovered contract. Enabling it does not establish that it is
free of Codex/app-server.

## Native app recovery

On macOS, the pinned provider's `cua.getApp` launches an app in the background
and includes an initial accessibility observation. It accepts an app name, path,
or bundle ID, not a native window ID. A running process alone does not guarantee
a responsive or usable app window.

If that initial observation fails with a provider timeout, or the caller cancels
the wait, reset the CUA session before continuing. Reset does not establish that
earlier upstream/native operations stopped; inspect fresh state before acting.
Use supported CUA to open the intended app normally from an observed launcher, such as its item in Finder, then select it again. In live Slack testing,
opening the installed app through Finder recovered a stalled initial snapshot;
subsequent background observations, search, channel navigation, and a fresh CUA
session succeeded without opening ChatGPT. This is a verified recovery, not proof
of the upstream stall's root cause or a reason to replay input automatically.

After a transient menu or window closes, `cgWindowNotFound` can refer to that
vanished window. Select the same app again and inspect its fresh state before
acting. This recovered Finder's desktop target in live testing. For window-based
input, use an actual app window. These recovery notes accompany workdir-only
discovery separately from the unchanged provider tool definitions.

## Distribution

On macOS, setup uses the official versioned, architecture-specific archives from
the desktop appcast. Setup probes the immutable archive with bounded HTTP ranges,
rebuilds a ZIP containing only the CUA Node runtime, signature anchor, and
signature metadata, and rejects archives that do not honor exact ranges. The
minimal bundle is verified against Apple's signature chain, OpenAI team
`2DC432GLL2`, bundle identity `com.openai.codex`, and every selected `files2`
SHA-256 seal. Compatibility is based on required signed components, not a hardcoded
desktop build. The user's installed desktop app is never read or replaced.

On Windows, setup obtains Store product `9PLM9XGG6VKS` through winget, as identified
by [upstream's Windows installer](https://github.com/openai/codex/blob/36430b36881cf5c289cb48e671cfc9e8b542ae7b/codex-rs/cli/src/desktop_app/windows.rs).
This installs the official ChatGPT/Codex desktop package for the current Windows
user and accepts the standard Store/package installation agreements. Setup checks
its Store signature, package family, and health. Store-owned executables cannot
be launched directly by an unpackaged Hand, so setup copies the complete CUA tree,
native host executables, and notices into a private cache. Every copied file is
compared with its Store source using SHA-256. The matching bundled Node handles
long Windows paths; no extra Node or Python installation is needed. Windows
requires Microsoft App Installer/winget and Store access for initial download.

Windows setup also writes a Nanocodex-owned host script outside the verified
OpenAI resources tree. It starts the packaged `WindowsHelperTransport` and signed
helper through the upstream native-pipe integration, then starts the official
MCP provider with that pipe. `CODEX_CLI_PATH` and the provider sandbox remain in
place. The host forwards authentic turn metadata and the SDK's
`requestComputerUseApproval` messages between the native helper and official
provider. This bridge carries upstream protocol messages; it supplies no consent
UI, permission cache, or approval decision. The Nanocodex MCP client does not
support host elicitation, so an upstream request that requires it fails explicitly.
Timeout, cancellation, disconnect, reset, and turn completion close pending
requests and the native helper. Each receipt retains its own host script so
replacing the selected runtime does not overwrite a running host.


Linux and Linux VM/container guests require an explicitly configured upstream
MCP provider. No custom CUA runtime, background-input plugin, or legacy fallback
is bundled. Automatic `computer setup` currently supports macOS and Windows;
without a provider, guests use their native controllable screen action contract
through the workdir-routed CUA entry point. This fallback does not emulate or
claim to install OpenAI's JavaScript provider.

## Selection and updates

The cache lives under `${NANOCODEX_DIR:-$HOME/.nanocodex}/runtimes/openai-cua`
(`USERPROFILE` is the Windows fallback). Version directories are immutable after
installation. Only a complete verified runtime is selected; a failed download or
copy preserves the previous selection. Old versions remain available to running
processes. Cached corruption produces an actionable error rather than silently
selecting a different backend. Run setup with `--refresh` to repair it.

The native and JS desktop hosts select the managed MCP provider automatically.
An explicit `NANOCODEX_COMPUTER` still wins; `off`, `none`, or `0` disables CUA and
its automatic download. Custom external MCP commands continue to use
`NANOCODEX_COMPUTER_TRANSPORT=mcp`. No versions are spoofed and no provider binaries
are committed to this repository or redistributed in Nanocodex release assets.

The older `scripts/install-upstream-cua.py` remains an explicit development-only
copy helper. Normal installations use the shared native provisioning command.

## Provider permissions and validation

The outer Rust/JavaScript adapters advertise no MCP elicitation and reject
unsupported incoming requests with method-not-found (`-32601`). On managed
macOS, the direct host is the upstream provider's internal MCP client. It
advertises form support and supplies empty native application-access consent
from trusted `NANOCODEX_CUA_APP_CONSENT=allow` policy (the managed launcher's
default). A trusted host can set `deny`; tool arguments cannot override it.
Audio, data-bearing forms, unknown connectors, and requests outside active JS
are not automatically approved. Native protected-target checks, OS permissions,
and caller authorization continue to apply. Known enforced local/MDM policy
sources fail closed pending a real policy integration; no enterprise Codex
identity is fabricated. See [native Hand computer access](native-hand-consent.md).

Validation covers transport fidelity, cancellation and cleanup, installer
migration, attestation, and the isolated no-Codex macOS MCP/native-observation
smoke. Arithmetic/catalog success alone is not proof of native CUA. Windows and
the opt-in Linux Sky host retain their existing Codex CLI dependencies; this
macOS change does not convert those paths or establish input acceptance on them.

The Windows native-pipe contract was verified against Store build 26.915.4065.0
and Codex Desktop 9922. A separate protocol probe returned app inventory,
forwarded a Calculator approval form, preserved a deliberate denial, and completed
`turn_ended`. That probe supplies its own decline-only response handler; it does
not represent the Nanocodex adapter, which rejects unsupported host requests.
It establishes transport and denial handling, not human approval UI, screen
capture, or input acceptance. The diagnostic fixture is
`crates/experimental/nanocodex-computer/tests/windows-sky/live-probe.mjs` (place it
beside the host script and run with the verified bundled Node on Windows). Its
responses to every elicitation are declines. Transport fixtures run with
`node --test crates/experimental/nanocodex-computer/tests/windows-sky/host.test.mjs`.

## Linux native host

A configured Linux provider must launch the native Sky service outside the model
sandbox so it can reach the desktop X server. `linux_sky_host.mjs` hosts the
unchanged `@oai/sky/service` in a disposable desktop-user process. Its trusted
proxy uses the upstream NodeREPL `nativePipe` bridge; ordinary model JavaScript
keeps the Codex sandbox and has no nativePipe capability. MCP tool definitions,
descriptions and results still come from the official provider.

For an already installed, compatible upstream Linux runtime, create a separate
host installation from this checkout:

```sh
python3 scripts/install-linux-sky-host.py \
  --runtime /path/to/cua_node \
  --codex-cli /path/to/codex \
  --destination "$HOME/.local/share/nanocodex/sky-host-version"
```

Set `NANOCODEX_COMPUTER` to the printed launcher path and
`NANOCODEX_COMPUTER_TRANSPORT=mcp`. Run the Hand/provider as the desktop user with
its real DISPLAY and session bus. Keep the host modules outside model-writable
workspaces. A system administrator can install the same modules in a protected
system directory and wrap the launcher with the desktop-session environment.
The script does not obtain or authenticate an upstream Linux distribution;
automatic `computer setup` remains limited to macOS and Windows.

For a Linux VM, add `--register-managed` to publish the launcher selection under
`$NANOCODEX_DIR/runtimes/openai-cua/provider.json` (or
`$HOME/.nanocodex/runtimes/openai-cua/provider.json`). The guest runtime discovers
this receipt at Hand startup. Install it in the guest, not on the VM host, and
restart the guest Hand to refresh its tool catalog. Host and guest binaries must
use the same VM tool protocol; an older factory binary can advertise tools yet
fail when forwarding a call to a newer guest.

OpenAI's Linux distribution includes both `x86_64` and `aarch64` packages. The
26.915.31945 ARM64 package is published at
`https://persistent.oaistatic.com/codex-app-prod/linux/arch/26.915.31945/aarch64/chatgpt-bin-26.915.31945-1-aarch64.pkg.tar.zst`.
Use the package's matching `resources/codex` and complete `resources/cua_node`
together, and verify the package signature against the fingerprint published in
the upstream installer. This version contains `sky_linux_arm64`; the x86 package
contains `sky_linux_x64`. A macOS ARM64 bundle is not a Linux ARM64 bundle.
Bundled Node and the native Linux Sky executable require glibc, so a bare Alpine
image needs a compatible userspace before this runtime can start. None of these
installation steps require changing Sky's input behavior.

The host serializes native calls, bounds frames and queues, and owns a private
Unix socket. Disconnect, cancellation, reset and turn completion reject queued
work, release tracked drags through upstream `drag_end`, and terminate the
service/helper process group after bounded cleanup. An in-flight input operation
can have partial effects before cancellation; cancellation is never a rollback.

The installed Linux Sky target controls X11/Xwayland windows. This transport does
not make native Wayland windows visible to that target. Application-level input
filters still apply (for example, xterm rejects synthetic SendEvent input by
default). Browser control remains the separate official browser surface.

Transport tests: `node --test crates/experimental/nanocodex-computer/tests/linux-sky/host.test.mjs`.
Live verification used the unmodified Linux service: inventory, a GTK X11 test
window screenshot, exact text plus Enter received by that app, and reconnect after
turn completion. The model process retained NoNewPrivs/Seccomp and had no nativePipe.
