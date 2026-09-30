# Windows upstream helper: no-Codex verification blocked

Automatic Windows upstream CUA setup and production Windows Sky launch are
unsupported. They fail before installation, copying files, reading a cached
provider receipt, or starting a provider/native helper. Rust Windows setup and
refresh return a structured `unsupported` receipt without launching PowerShell;
the standalone PowerShell installer also refuses execution. No browser APIs are
advertised. Rust automatic discovery refuses managed Windows generations before
reading cached receipts, including old immutable Windows host scripts. Explicit
host-owned custom MCP provider selection (including off) is preserved, and the
generic MCP process transport has no blanket Windows ban. An explicitly selected
external provider is the embedding host's responsibility, not a claim that the
managed Windows native helper supports no-Codex operation. With no explicit
provider, discovery returns no upstream provider, allowing an independently
available native screen capability to be reported honestly, not as upstream
JavaScript/MCP. The Windows framing and approval-relay fixture remains testable;
fixture success does **not** establish native Windows support.

## Local evidence

The locally installed macOS desktop package contains `@oai/sky` version `0.7.1`
and its Windows JavaScript transport at:

`cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/helper_transport.js`

That transport directly spawns the supplied `helperCommand` with `helperArgs`;
when supplied, `helperEnv` is merged into the host environment. Its native stdio
protocol uses newline-delimited `{id, method, params, meta}` requests and
`{id, ok, result}` / error / `approvalRequest` responses. The JavaScript transport
contains no `CODEX_CLI_PATH`, `config/read`, or `configRequirements/read` dependency.
Approval requests are routed through `createElicitation`; decline and audio
approval are not converted into application consent. Turn metadata, Escape-stop
tracking, and helper lifecycle remain upstream transport responsibilities.

The companion `computer_use_client.js` selects
`bin/windows/codex-computer-use.exe` or
`bin/windows/codex-computer-use-arm64.exe`, adding `--parent-pid`. However, the
local macOS package's `@oai/sky/bin` directory is empty; neither Windows binary nor
its native source was available locally for this verification. The registered
Windows Hand (`WIN-DBL5PB2T2HR`) was offline on 2026-09-30.

Therefore absence of a CLI call in the **JavaScript** layer cannot establish the
native helper's no-Codex policy contract. No Windows policy adapter is invented,
no Mac app-server reply shape is assumed to apply to Windows, and no authentication
or unknown app-server endpoint is emulated.

## Removed unsupported path

The previous `provision_windows.ps1` installed the full Store desktop package,
copied every top-level `.exe` (including `codex.exe`), required that executable,
and published `browser,computer` plus `CODEX_CLI_PATH`. The previous Windows host
required and forwarded that variable to the native helper. That does not satisfy
a no-official-Codex Hand contract and is no longer offered. Legacy live probes
also refuse to launch cached providers.

Re-enabling Windows requires local signed native helper evidence establishing
its dependency and policy contract, plus native Windows proof of real upstream
MCP initialize/catalog, inventory/screenshot/input and denial/cleanup behavior
without an official Codex CLI/app-server process. Explicit owner consent does not
permit protected-target, administrator, locked-computer, audio, or data-policy
bypass. Only computer surfaces may be enabled by default; any browser host with
a real Codex dependency remains unsupported.

## Cross-platform fixtures

Run from the repository root:

```sh
node --test crates/experimental/nanocodex-computer/tests/windows-sky/*.test.mjs
cargo test -p nanocodex-computer windows_provision_tests --lib
```

These cover length-prefixed framing, unchanged metadata, denial, approval timeout,
turn completion, disconnect cleanup, cross-client approval isolation, supplied
approval-token rejection, and refusal of the installer/production launcher/live
probe. Native Windows proof remains blocked, not claimed by these fixtures.
