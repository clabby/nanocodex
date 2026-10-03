# Nanoclaude JavaScript durability continuation — 2026-09-30

Continues the same draft PR #657 from `3d9c1e3b`. No merge or production deployment.

## Implemented

- Additive `Claude.create` from `nanocodex/node`, `/host`, `/browser` and `/worker`, backed by the actual Rust Messages loop and **existing** durability/store/fencing machinery. Browser/host run in the current isolate; no implicit Codex module Worker or managed provider switch.
- Explicit host-owned API-key/header authentication and Claude-only tools. No ambient credentials, Codex catalog or default host services. Native tool errors/media/metadata are preserved; unsupported shared media fail closed. Strict/deferred flags are retained or explicitly rejected. Nested config is snapshotted before asynchronous loading.
- Stable embedding-owned native session identity; a durable session ID must equal its state ID. The common public acceptance contract stays unchanged; an internal actual Rust turn-identity seam supports isolated host aborts even without a durable request ID.
- Client disposal retains auth/tool/store routes for accepted work until terminal settlement, even with no caller result waiter. Shutdown explicitly cancels and joins work. Active/queued cancellation does not poison another turn's host signal. Ephemeral queued cancellation can retire before acquiring the busy conversation mutex; durable retirement retains the serialized checkpoint frontier.

## Reproduced correctness fixes

Before-fix failures are preserved in the private evidence bundle:

1. A recovered frozen zero-tool request could invoke a newly installed host handler. Dispatch now requires a definition in the admitted request template, including its deferred-discovery policy. Committed receipts still replay without handlers.
2. An accepted SSE error could echo authentication into a durable failure. Only diagnostics are scrubbed, including both rejected/current generations after a bounded 401 retry; valid signed/opaque provider content is unchanged.
3. Anonymous active host cancellation did not abort the correct signal, while queued cancellation could wait indefinitely on the active conversation lock. Actual lifecycle identity and scoped ephemeral cancellation fix these cases.
4. Immediate JS disposal released routes needed by accepted work. Proactive terminal observation and deferred host cleanup now preserve it.

## Verification

- Full Claude Rust suite: **98 passed, zero ignored**.
- Shared durability suite: **142 passed** (including one doctest), **3 ignored**: one existing release benchmark and two construction doctests. An initial concurrent run hit the existing clone/drop scheduling-budget assertion; its log is preserved. The complete rerun passed without source/test relaxation.
- Claude JS unit + actual generated Node/web WASM suites: **29 passed**, no skips. Separate shared JS regressions: **151 passed**, no skips. Type declarations, package verification, formatting and diff checks pass.
- Strict native Claude/durability Clippy and scoped WASM Clippy pass. Unscoped WASM Clippy encounters the unchanged `missing_const_for_fn` warning at `nanocodex-agent/src/model/context.rs:336`; no unrelated source workaround was applied.
- Repository's unmodified development WASM build script regenerates the real kernel/glue. Independent review verifies source and artifact hashes; no fake engine or check-only substitution.
- Actual Chromium **145.0.7632.6** page **and browser module Worker** each execute real WASM, one tool effect, automatic compaction/native signed-block retention, durable handle reopen and terminal replay. Six total synthetic Messages requests; replay adds zero requests/auth calls/effects.
- Node tests perform actual SQLite close/reopen. An independent detach journey never calls the original turn's `result()`: after disposal it observes a persisted completed operation and immutable tool/terminal records, closes/reopens SQLite, then replays `DETACHED_RECEIPT` with **0 HTTP / 0 auth / 0 effects**. Synthetic auth is absent from persisted state/records.
- Independent final read-only review: no remaining introduced P1/P2 in the reviewed scope.

Reproduce:

```sh
cargo test --locked -p nanocodex-claude --all-features
cargo test --locked -p nanocodex-durability --features claude,sqlite
bash js/nanocodex-vite/scripts/build-js-package.sh
node --test --test-concurrency=1 js/nanocodex/test/claude.test.mjs \
  js/nanocodex/test/claude-cancel-isolation-wasm.test.mjs \
  js/nanocodex/test/nanoclaude-wasm.test.mjs
npm --prefix js/nanocodex run test:typecheck
npm --prefix js/nanocodex run check:package
# Optional: requires an installed Playwright module and Chromium executable.
node js/nanocodex/scripts/test-nanoclaude-browser.mjs
```

The optional browser harness accepts `NANOCLAUDE_PLAYWRIGHT_MODULE` and `NANOCLAUDE_CHROMIUM_EXECUTABLE`; no automatic browser installation is performed.

## Evidence and limits

Private artifact index: `/brain/outputs/nanoclaude/continue-20260930/REPORT.md`.
The runtime restart dropped the original subagents; native source/logs survived and replacement agents completed validation/review.

Development WASM was exercised, not an optimized release artifact. Browser persistence uses the shared memory store within an isolate; on-disk SQLite reopen is independently covered in Node. No deployed Cloudflare Worker, real provider traffic, fresh PKCE authorization, native refresh, production sign-in/provider UI or billing was tested in this continuation. Prior live native/CLI subscription evidence remains separate. JS header callbacks have no automatic 401 recovery callback.

External effects without committed receipts remain at least once, not universally exactly once. Abort is cooperative and does not prove rollback. An indefinitely blocked accepted callback can retain routes after detach. Whole-JSON checkpoints, full CLI tools/host services and managed product integration remain unfinished. See the [JavaScript guide](../CLAUDE_JAVASCRIPT.md), [runtime](../CLAUDE_RUNTIME.md), [tool matrix](../CLAUDE_TOOL_MATRIX.md) and [authentication](../claude-authentication.md).
