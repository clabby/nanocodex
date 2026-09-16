# Native screen startup follow-up — 2026-09-16

## Implemented

- Prefetch host ICE credentials while opening the publication socket. The
  preparation belongs to that publication, shares concurrent requests, expires
  after five minutes (including time asleep), and cancels on disconnect, stop,
  or account replacement. Failed requests can retry. Existing periodic peer
  ICE restarts continue requesting fresh credentials.
- Prime a newly connected Mac viewer with the latest captured pixel buffer for
  at most one second. This uses one shared 30 fps timer and yields whenever
  actual capture already delivered a frame. It handles a static screen and a
  connection callback arriving before encoder readiness. Permission, geometry,
  shutdown and publication checks remain in place; no images are persisted.
- Seed the publisher's bandwidth estimate at 1 Mbps instead of its measured
  300 kbps default. This sets no bandwidth floor; congestion control can still
  reduce the rate. The existing maximum remains unchanged.
- Add host ICE/offer/connection timings and opt-in media statistics without
  ICE addresses, credentials, SDP, or screen contents.

## Live controls

The host and viewer ran on the same Mac using deployed authenticated signaling.
Each run connected three sequential viewers to its own temporary publication,
observed a decoded frame and acquired/released control without sending input.
Each publication was stopped afterwards. See [curated samples](screen-startup-measurements.json).

| Measurement | Control, three samples | Optimized, three samples |
| --- | --- | --- |
| Host ICE wait at viewer admission | 262 / 264 / 244 ms, direct fetch | 0.33 / 0.07 / 0.23 ms, prefetched |
| Connected → first decoded frame | 388 / 266 / 223 ms, 300 kbps | 268 / 159 / 133 ms, 1 Mbps |
| Connect → first decoded frame | 2,523 / 1,753 / 2,966 ms, 300 kbps | 1,748 / 1,919 / 1,669 ms, 1 Mbps |

The bitrate control uses the same one-second frame priming and ICE prefetch;
only the starting bandwidth estimate differs. The ICE control independently
restores the direct host fetch while retaining the media changes. These are
small sequential samples, not percentile estimates. Variable signaling latency
means total opening differences cannot all be attributed to these changes.
Catalog lookup is excluded from connect timings.

A final run after lifecycle fixes measured **270 / 199 / 212 ms** from connection
to first frame, **2,371 / 1,753 / 1,989 ms** from connect start, and
**0.095 / 0.073 / 0.077 ms** waiting for prepared ICE. Both optimized runs are
retained; network variation still affects total opening. Media statistics were
sampled every 25 ms only by the opt-in test, not by normal application sessions.

The media stats confirmed the default 300,000 bps estimate, 5–24 ms encoding
in the initial instrumented samples, and accumulated packet-send delay.
An intermediate one-shot frame seed still had a 1,041 ms connected-to-frame
sample with no encoded frame until the end of that interval. A later 500 ms
priming run had a cold 778 ms sample. The final priming interval is one second;
the results above include its first connection. This does not establish a
separate controlled effect size for priming, eliminate all cold encoder costs,
or measure mobile/WAN/constrained-link performance.

## Validation and delivery

The complete Swift package suite passed: 58 tests, 11 opt-in tests skipped,
zero failures. It covers preparation expiration, reuse, failed-request retry,
stop/account replacement, cancellation before HTTP startup, initial frame
requests on real peer connection, and existing viewer recovery. The live Mac
fixture was also run explicitly for the controls above.

These are native source changes tested in the Swift package. They have not yet
been included in an installed Mac/iPhone release. No Worker changes are required.

## Linux call rejection — still blocked on host access

The existing native Linux publisher rejects calls with `invalid call` and then
reconnects. Current broker code defaults `output_byte_budget` to
`Number.MAX_SAFE_INTEGER`; the Rust publisher before commit `e44149d81` rejects
anything above 131,072 bytes. Current Rust accepts the broker's default. This
is a concrete protocol-version mismatch that could explain the observed error,
but the installed remote version and rejected frame have not been obtained.

Two SSH attempts to the saved `ubuntu@206.223.228.133` address timed out. A working
SSH hostname/user is needed to inspect the running publisher, update/restart it
without losing machine identity, and rerun successful shell calls. No budget cap
or compatibility fallback was added, and this report does not claim Linux is
fixed.
