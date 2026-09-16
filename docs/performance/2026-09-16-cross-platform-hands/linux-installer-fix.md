# Linux installer and VM release repair — 2026-09-16

Follow-up to [Linux recovery](linux-recovery.md).

## Changes

- The CLI embeds the computer runtime's Cargo manifests, source, and extensions
  at build time and uploads them with the VM image recipe. Docker receives the
  required `computer-source` named context. Installation works without a source
  checkout on the client or target.
- The immutable VM image key includes source paths and content digests. Editing,
  adding, renaming, or removing a source file invalidates the image; an unchanged
  rerun reuses it without invoking Docker.
- Local `--artifacts` installation includes `nanocodex-computer` alongside the
  host and guest executables, matching published-release installation.
- Explicit VM teardown accepts an attachment that the broker already fenced.
  It still waits for attachment cleanup and requires VM shutdown and retained
  file cleanup to succeed. Ordinary attachment observers still receive fencing
  failures; transport and shutdown failures remain errors. This avoids turning
  agent deletion into a factory control-channel reconnect and release retry.

## Regression checks

- Seven installer policy tests passed, including image cache invalidation,
  missing-source failure, named-context wiring, and unchanged image reuse.
- Two CLI setup tests passed, including extracting the embedded source into an
  empty temporary directory without relying on the runtime checkout.
- All 32 VM lifecycle tests passed, including a real WebSocket whose broker
  closes with `managed agent is being deleted` before explicit teardown. The
  existing shutdown, cleanup-failure, and durable-release retry tests still pass.

The broad strict Clippy run encountered five existing `missing_const_for_fn`
findings in `nanocodex-voice-protocol`. The `--no-deps` run then encountered five
existing findings of the same lint in `browser_cookie_sync.rs` and the TUI. None
of those files was changed. A final `cargo clippy --no-deps -p nanocodex-bin
-p nanocodex2-bin --bins -- -D warnings -A clippy::missing_const_for_fn` passed,
excluding only that existing lint class. Formatting and whitespace checks pass.

## Latency investigation limits

The earlier native shell outlier remains unassigned: 2,530 ms at the managed
boundary versus a 4.907 ms host attachment span. The existing logs do not break
its remaining time into network, broker, and persistence stages. A read-only
Workers Observability query for that exact time window returned HTTP 403 with
an authentication error. No speculative routing or authorization change is
included in these fixes.

## Live installation and verification

On `paradigm` (`206.223.235.69`), the repaired installer built a fresh desktop
image, including its computer runtime, and the image passed all five `e2fsck`
passes. The rebuilt CLI then installed optimized host and guest binaries through
`hand add --artifacts`, using the freshly built image. This used the ordinary
installer path; no service-unit or manifest workaround was needed.

Installed revision: `beae96461973c4d53950c75c`.
Template: `desktop-d9ff55d7f6c73339.ext4`.
The host and guest use the workspace `nightly` optimized profile. The native
computer helper uses the checksum-verified published September 16 nightly.
Machine ID and workspace remain unchanged. The live native Hand catalog now
advertises `vm_factory:linux-paradigm`, exposing its host and VM provider together.
The installation is a local build;
these fixes have not been published in a new nightly.

Activation took 48.20 seconds after image preparation. A second invocation took
27.00 seconds including uploading the local executables. It reused the image,
performed no Docker build, and left both PIDs and the installation manifest
identical. Native Hand PID: 970756; factory PID: 970877; both report zero restarts.
The cold image build takes minutes; none of that work belongs to a normal tool
call or a claim of an already prepared VM.

### Native Hand calls

Five sequential `printf hand_latency_probe` calls all returned the exact marker
and exit code zero. Managed durations were **438 / 418 / 412 / 412 / 411 ms**.
Host command times were **5.94 / 5.83 / 4.73 / 5.34 / 6.00 ms**.

A live Worker tail captured five account-broker `/invoke` requests during this
cohort: **187 / 182 / 183 / 183 / 182 ms** wall time and **2 / 2 / 1 / 1 / 1 ms**
CPU time. These are nested spans, not additive stages. Correlation is by timing
and order, not a shared request ID. They do not split broker wait time into
storage versus transport, or explain the earlier outlier. No outlier repeated
in this small sample; this is not evidence of a tail-latency fix.

### VM creation and release

A fresh allocation from the running factory mounted in **3,110 ms**, ran
`uname -s && printf hand_latency_probe`, and returned Linux, the expected marker,
and exit code zero. The VM shell tool took **235 ms** end to end, with
**3.391 ms** in the guest command.

The local prepared-VM claim took **0.614 ms**; guest readiness was **0.656 ms**
from provision start. Desktop publication completed by **1,038 ms** and the tool
attachment by **1,848 ms**, overlapping. The factory's initial spare preparation
had already taken **10,902 ms** before the test; replenishment took **10,288 ms**.
This is a warm claim, not a cold boot comparison against the earlier 11.058-second
mount. Network/publication and managed coordination still dominate warm mounting.

The scratch agent was deleted, its allocation directory returned to empty, and
the factory replenished a fresh spare. The expected attachment fencing still
appears in the journal, but there is **no release error, factory reconnect, or
service restart**. Both benchmark agents were deleted successfully.

[Curated measurements, artifact hashes, and host events](linux-installer-fix-measurements.json)
include the full successful tool results. Raw image-build, installer, rerun,
service, and test logs remain under `output/cross-platform-hands/`.
