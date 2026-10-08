# Prepared model upgrade evidence

The fresh prepared live-admission path starts one auth-only Responses upgrade before its first SQLite write. Its runtime UUID is inserted into the same initial ownership batch and is subsequently read by the SDK's `cloudflare/Agent.mjs` durableIdentity. The independent managed durability ID remains the public session ID. Headers match `cloudflare/egress.mjs` openBrokeredWebSocket; the workerd journey consumes via that actual SDK builder, so header drift fails reuse assertions.

Only fresh direct-account session_v1 live creation is eligible. Live creation accepts model/settings, not account selection or dynamic routing configuration. Retained ownership is checked by scopedManagedModelEgress before consumption. Exact request-header comparison fences owner, subject, region, runtime identity and account selection. Consumption additionally waits for storage.sync and rechecks deletion/export/import and slot ownership. The SDK accepts the socket only after consumption. Mandatory storage durability is retained.

Lifecycle cleanup aborts pending work and closes late returned sockets on timeout, admission exception, deletion, export, import and runtime retirement (including settings/configuration replacement). Rejected or synchronously throwing fetch is optional-path failure and falls back to ordinary SDK transport. Disposal accepts a discarded socket only to close it; it sends no inference frame.

Validation (2026-10-08):

- `npx pnpm@11.25.0 exec tsc --noEmit`: passed.
- `npx pnpm@11.25.0 exec node --test test/prepared-model-upgrade-journey.test.mjs`: passed. Real workerd sockets, actual SDK headers/acceptance, SQLite sync plus an explicitly held admission join; one upgrade reused, no frames before release, single consumption, synchronous/asynchronous fetch failure, non-101 response, header mismatch, retirement, late-response cleanup and real 10-second expiry.
- `npx pnpm@11.25.0 exec node --test test/startup-overlap-journey.test.mjs`: full managed/account/SDK/WASM startup; exact early socket reuse, preserved first-turn tool/startup context, discovery overlap and rejected-authorization no-handshake assertions.

Logs are under output/startup-critical-path; full journey artifacts are under output/startup-overlap-journey. The isolated admission hold is not an emulated Cloudflare replication delay. These tests do not establish a 447 ms production saving. Production cross-Worker timestamps must still show upstream handshake entry before storage sync completes. Baseline full crash-recovery reportedly failed unchanged TOOL_NOT_AVAILABLE in the parent investigation; this patch does not claim that suite passes.
