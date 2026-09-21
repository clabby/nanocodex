# Further Hand optimizations — 2026-09-16

[Timing samples](hands-component-measurements.json) and
[sanitized Worker events](hands-component-worker-events.json) accompany this report.
HTTP request IDs correlate client samples with Worker timings. WebSocket samples
do not have individual request-ID correlation; their Worker comparisons are
cohort-level observations. No credentials, TURN configuration, pixels, tool
arguments, or capability-bearing attachment paths are included.

## Changes with measured improvements

| Change | Before | After | Evidence |
| --- | ---: | ---: | --- |
| Public inventory for all Hands | 530 ms median | 420 ms, then 435 ms on final deployment | Five real HTTP requests per version |
| Mac CLI native screenshot capture | 156 ms; restored control 151 ms | 76 ms; repeat 76 ms | Four release runs, nine warm samples each |

Inventory now requests only online machine IDs, names, and capabilities from
the account Durable Object. Previously it fetched the full internal snapshot,
including the tool catalog, then projected this small public response. Ownership,
capability checks, online filtering, public mount paths and no-store remain in
place. The final deployed reduction is 95 ms (18%); the first after-run was
109 ms (21%). These short sequential runs are not a randomized trial or p95s.

Mac capture needs display metadata but previously enumerated desktop and
off-screen windows. Narrowing that metadata query reduced median discovery from
94–101 ms to 27–29 ms. The screenshot filter still captures every window on the
chosen display. Image capture itself was 35–49 ms and JPEG encoding about 9 ms.
The first sample of every capture run is retained in the data but excluded from
the warm medians. This change affects the CLI's snapshot/JPEG path; the app's
persistent WebRTC stream uses a different implementation.

An experimental screen-list RPC did **not** improve the approximately 170 ms
route stage and was removed. Attachment-grant JSON decoding measured 0 ms at
Worker timer resolution, so no RPC rewrite was made for that body either.

## Remaining work, ranked by observed cost

These rows are nested or alternative paths; do not add them into one total.

1. **Connection establishment.** Six fresh screen-host WebSockets took
   457–1,185 ms. DNS completed in 2–15 ms, TCP by 23–33 ms and TLS by 53–67 ms,
   all measured cumulatively from connect start. Typical Worker auth plus
   account routing was about 370–400 ms. Some samples fit that budget; others
   have roughly 600–800 ms outside those stages. Final independent API samples
   still show 1.1–1.2 s median upgrades. Locate that residual across ingress,
   dispatch and upgrade forwarding before choosing an architecture change.
   These measurements do not identify it as SQL, TLS, or container startup.
2. **Native Mac first video frame.** Three real WebRTC connections reached a
   decoded frame at 2,616 / 2,657 / 2,063 ms, after a separate 530 ms catalog
   request. Signaling readiness took 1,290 / 1,355 / 1,147 ms; the subsequent
   offer took another 471 / 516 / 518 ms. The host currently fetches ICE
   credentials for every viewer before creating its offer. Viewer ICE fetches
   took 264–349 ms but overlap signaling, so eliminating the viewer fetch alone
   would not save that time. Measure the host fetch directly and consider a
   bounded, identity-scoped credential cache. No cache was added in this patch.
   Peer connection to first frame added 626 / 578 / 194 ms. Investigate initial
   keyframe delivery and capture of a static desktop; the trace does not prove
   which causes that delay. No last-frame replay was introduced.
3. **Repeated authenticated account requests.** API-key authorization cost
   about 194–221 ms in final HTTP samples; account routing another 168–197 ms.
   ICE HTTP requests, which do not route through the account broker, took
   224–251 ms. These are real API-key paths, not measurements of the existing
   managed-access-token fast path or browser cookies. Investigate reuse on Hand
   connections without weakening expiration/invalidation. The new stage logs
   do not split auth into individual SQL reads, so no SQL-specific saving is
   claimed.
4. **Remote tool execution overhead.** One successful Linux VM shell call
   took 188 ms at the managed tool boundary, with 2.03 ms in the shell. About
   186 ms remains in routing, transport, admission and result handling together.
   Instrument these separately before optimizing a presumed database read.
   The same VM mounted in 3,493 ms; factory startup was a separate 5,371 ms.
   Millisecond local spare handoff is not millisecond end-to-end mount.

### Linux reliability finding

The existing native Linux Hand appeared online, but five read-only shell probes
returned two `ambiguous` transport-loss results with `invalid call`, and three
`unavailable` results while reconnecting. None count as successful execution
latency. The current Rust protocol emits that error when call validation fails;
we did not obtain the remote binary version or rejected wire fields, so this is
not enough evidence to identify the failing field or claim a fix. Reproduce with
remote publisher diagnostics and resolve the rejection before comparing native
Linux performance. The scratch agent was deleted successfully.

## Scope and verification

- Final managed deployment: `08644298-1639-4763-ad7c-254d152dec6c`.
  Inventory and request timing changes are live. No container image rollout was
  needed. The failed screen-list RPC experiment is absent from this version.
- 34 focused managed tests passed across account Hands, screen relay, and timing
  redaction; managed typecheck passed. Five Rust Mac Hand tests passed, as did
  crate-wide Clippy with all targets and warnings denied, and workspace formatting.
- Real native Mac WebRTC test passed with three connections and control
  acquisition/release. It sent no input or saved screen pixels. Control timings
  of 104–107 ms use a 100 ms polling assertion and are upper bounds, not exact
  control RTTs. Publication readiness (1,982 ms) also uses that polling helper.
- The Mac capture change was built and measured in release-mode probes. It is
  **not yet installed or released** in the user's CLI/app.
- The WebRTC host and viewer ran on the same Mac. These results do not measure
  WAN media performance, an iPhone, or Windows hardware. The successful Linux
  execution is a guest VM, distinct from the failing existing native Linux Hand.
- Benchmark VM/agent and temporary Mac publication were cleaned up. Worker tail
  was stopped after the final deployed API check.

## Reproduction

The native capture probe lives at
`crates/nanocodex-hand/examples/capture_latency.rs`; run
`cargo run --release --locked -p nanocodex-hand --example capture_latency` with
existing OS Screen Recording permission. It emits only timings and image sizes.

The opt-in native test is `AccountMacTests.testLiveMacScreenLatency` in
`apple/NanocodexRemote`. Supply `NANOCODEX_TEST_MAC_LATENCY=1`,
`NANOCODEX_REMOTE_DIAGNOSTICS=1`, `NANOCODEX_MANAGED_URL`, a private
`NANOCODEX_API_KEY`, and `NANOCODEX_TEST_MAC_LATENCY_OUTPUT`, then use the
package's existing `swift test --filter` workflow. It creates and removes its
own temporary publication.

Local HTTP/transport harnesses and release artifacts are retained under
`output/cross-platform-hands/`; their curated, credential-free timing outputs
are linked above. The HTTP probe performs five sequential rounds of inventory,
screen list, ICE and bare WebSocket upgrades, closing each socket without
publishing a catalog or replacing an existing Hand.
