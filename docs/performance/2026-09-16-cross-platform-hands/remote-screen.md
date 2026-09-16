# VM remote screen latency — 2026-09-16

## Results

[Raw timing samples, correlated host events, artifact hashes, and cleanup results](remote-screen-measurements.json).
[Correlated Worker event summaries](remote-screen-worker-events.json) retain only
events containing the scratch machine/allocation IDs, without request headers,
credentials, or bodies. This is an incomplete selection, not a distributed trace
that assigns every millisecond across the relay.

| Measurement | Original baseline | Pipeline only | Pipeline + shared TLS | Old publisher control after deployment |
| --- | ---: | ---: | ---: | ---: |
| Transport delivery, 20 frames | 1.92 fps | 8.58 fps | 9.03 fps | 1.81 fps |
| Median transport frame interval | 523 ms | 98 ms | 101 ms | 515 ms |
| Viewer ready → first JPEG | 542 ms | 338 ms | 338 ms | 550 ms |
| Connect start → first JPEG | 1,063 ms | 1,400 ms | 1,540 ms | 1,875 ms |
| Catalog request before connect | 1,322 ms | 1,247 ms | 1,644 ms | 519 ms |
| Control acquisition | 410 ms | 365 ms | 468 ms | 392 ms |
| Input → newly requested JPEG | 637 ms | 464 ms | 557 ms | 539 ms |
| Screen publication, excluding initial capture | 1,623 ms | 1,296 ms | 1,577 ms | 1,605 ms |

Each column is one fresh VM with 20 measured transport frames. The final and
control runs also used the **same shared native viewer code**: 20 decoded
frames at **7.62 fps versus 1.91 fps**, respectively. Native first-image arrival
was 1,677 ms versus 1,757 ms after connect; catalog requests before connect
were 1,753 ms versus 497 ms. The control uses the improved legacy native pacing,
so this isolates the publisher/protocol change rather than claiming the older
app was measured. The control ran after both Worker deployments.

Streaming improves approximately fourfold in the native viewer and fivefold
at transport level. These samples **do not establish an improvement in total
screen opening, control acquisition, or input response**. Connection/catalog
variance dominates those measurements. Native frame delivery also remains
bursty (up to 536 ms between frames), so this is not smooth 30/60 fps video.
All four input screenshots have the same SHA-256 and show the expected typed
marker, establishing that the measured response includes the changed desktop.

### Connection breakdown in the final release binary

The factory loaded 162 native roots once in **167.04 ms**. Later screen setup:

| Serial component | Duration |
| --- | ---: |
| DNS | 2.59 ms |
| TCP connection | 16.35 ms |
| Reused TLS trust configuration | 0.056 ms |
| TLS + authenticated HTTP upgrade | 1,357.41 ms |
| Ready + catalog publication acknowledgement | 201.06 ms |

This validates removal of repeated trust-store loading; it does not assign the
remaining 1.36 s to a specific network or server component. The next startup
investigation should split that upgrade path and the 0.5–1.75 s catalog lookup.
The current evidence does not justify removing authorization checks or claiming
millisecond end-to-end screen opening.

## Measured bottleneck

A real private GPU VM on this Mac served 20 authenticated JPEG frames through
the deployed managed relay. Local capture took 17–52 ms (median 28 ms), but
each serialized request/frame round trip took 495–542 ms (median 522 ms).
That limits this route to approximately 1.9 frames/second even when the desktop
can capture much faster. The baseline viewer first received a JPEG 1,063 ms
after opening its connection; catalog lookup before that cost another 1,322 ms.
These are frame arrival timings, not browser paint timings.

The same trace measured 410 ms to acquire control and 637 ms from sending text
input to receiving a newly requested screenshot. Local input application took
13 ms. The resulting screenshot visibly contains `screen_latency_probe`.

The Worker tail showed VM attachment validation at 0–2 ms and established
screen broker handlers at 0–1 ms. There is no SQL or credential lookup per
established frame. These traces do not justify attributing the half-second
frame round trip to database reads.

## Changes

- An authenticated viewer can grant up to six frame credits. The publisher
  captures at most every 100 ms while credits remain, sharing capture across
  viewers. Each decoded frame replenishes one credit. This bounds queued
  images, stops capture when the viewer stops consuming, and removes the
  request/response round trip between successive frames.
- The viewer can grant its initial credits in the authenticated WebSocket
  upgrade, removing a further request round trip before the first image.
- Browser and shared Mac/iPhone viewers implement the bounded protocol.
  The native single-frame fallback also subtracts network time from its
  100 ms pacing interval instead of sleeping 100 ms after every frame.
- Screen, attached-tools, and managed host/session WebSockets share a native
  TLS configuration for at most five minutes, preserving session resumption.
  Certificate environment overrides invalidate it immediately; failed refresh
  fails closed. Authentication and allocation leases remain separate and
  unchanged. Five standalone native-root probes on this Mac took 204–601 ms
  each; previously the WebSocket library loaded roots for every connection.
  The probe used debug dependencies and is not a controlled release effect size.
- Startup traces separate DNS, TCP, trust setup, TLS/HTTP upgrade, publication
  acknowledgement, and local capture. Agent screenshot observation no longer
  has an unconditional 80 ms settling delay; input actions retain settling.

## Measurement method

Release host binaries use the same optimized guest and VM recipe (2 vCPU,
2 GiB, GPU desktop). Each benchmark starts a private factory, allocates a fresh
VM through the live managed mount tool, verifies shell execution, measures
20 frames and input, deletes the scratch agent, and stops its factory.
Node measures authenticated transport delivery. The opt-in Swift benchmark
uses the actual shared native viewer and JPEG decoder on macOS. Neither is
an iPhone hardware, cellular-network, or browser paint benchmark.
The measurements cover the VM `frames-v1` path. Native Mac display sharing
uses its existing WebRTC path and was not latency-benchmarked here; these fps
numbers must not be applied to that path.

The host binary before the TLS cache isolates the frame pipeline change from
connection setup changes. Frame-window measurements use inter-arrival times,
not mislabeled request round trips. Samples are short observations, not p95s
or an SLA. Concurrent development builds and changing network conditions can
affect these results.

## Rollout and validation

- Managed relay deployed as `0321ded2-4860-4281-a43e-0706fc1a364f`.
- Account/browser deployed afterward as `c9861a3f-6259-43d4-a303-dd318c5eee8f`.
- Both deployments used `--containers-rollout=none`; no container image rollout
  was needed. Uploads containing source maps repeatedly failed with EPIPE on
  Node 26 and Node 24, including IPv4. Deployment succeeded with
  `--upload-source-maps=false`; normal checked-in configuration is unchanged.
  These two deployed versions therefore lack uploaded source maps.
- CLI publisher and native viewer changes are built/tested locally, **not yet
  installed as a CLI/nightly or Mac/iPhone app release**. Existing publishers
  continue to use single-frame delivery until upgraded.
- Relay tests: 35 passing. Browser screen tests: 33 passing. Shared native viewer
  tests: 26 passing, plus both opt-in live viewer benchmarks passing.
- Rust screen publisher: 4 passing, including a real local WebSocket test that
  grants six credits and verifies no seventh capture/delivery without credit.
  Managed Rust tests: 32 passing. Attachment-only transport tests: 14 passing.
- Standalone `native-tls` feature test: 1 passing (expiry and certificate
  environment invalidation). This caught and fixed a missing explicit Rustls
  `std` feature that the full CLI had supplied through other dependencies.
- Browser and managed type checks, browser production/WASM build, Worker build,
  crate boundaries, Rustls provider policy checks, Rust formatting, and CLI
  Clippy with `-D warnings` passed.
- Every scratch agent was deleted successfully; benchmark publishers and VM
  children were stopped. No credentials or JPEG payloads are in the curated JSON.
