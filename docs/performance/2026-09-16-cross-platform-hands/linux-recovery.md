# Native Linux Hand recovery — 2026-09-16

Subsequent installer and VM cleanup work is recorded in
[Linux installer and release repair](linux-installer-fix.md). This report retains
the initial recovery observations.

`lsh servers list --all-projects --no-input` identified `paradigm` at
`206.223.235.69`. The previously attempted `206.223.228.133` is a different,
Centaur server. SSH to `ubuntu@206.223.235.69` works.

## Cause and repair

The installed publisher was `nanocodex2 0.5.0`, release
`nightly-ed752110f2549bb43d9ad497c405e1c7a047b71a` (September 11), still started
with `native-hand`. Its protocol validator caps output bytes at 131,072. The
current broker defaults omitted byte budgets to `Number.MAX_SAFE_INTEGER`.
Commit `e44149d81` removed that publisher cap on September 14. The old service
journal records `attachment was fenced: invalid call` and process restarts.
The rejected wire frame itself was not captured.

Activated the checksum-verified published release
`nightly-b1b622f695e9623816c1f500cd543941257d9799` (`nanocodex2 0.6.1`), revision
`524fcbc2851f1687df514c3a`, and changed the service command to `hand`.
Machine ID `0dbfda66-12e4-4bcf-b1a9-994a052b3181`, workspace, credentials,
factory settings, and existing VM template were preserved. No compatibility
limits were added. Both systemd services became ready and the native Hand and
screen appeared in the account catalog.

The ordinary `nanocodex hand add` installer downloaded and verified the release
but failed before activation: its VM Dockerfile references the `computer-source`
named build context, while its bundled installer supplies neither that source
nor the build-context argument. Activation therefore used the verified artifacts
and retained the existing VM image, with backups of the symlink target, unit,
and manifest and rollback on service startup failure. The installer packaging
bug remains unresolved. The installation manifest explicitly records the
retained image's old release; no new image was built.

This published nightly predates the latest master Hand/startup optimizations.
This recovery does not claim those source changes are installed.

## Live native shell verification

Five sequential managed `exec_command` calls ran `printf hand_latency_probe`
on the existing native machine. Every call completed with exit code zero and
the expected output. The benchmark checks result status and output, not merely
the CLI exit status. The scratch agent was deleted successfully.

| Call | Managed tool duration | Host command wall time | Host attachment span |
| --- | ---: | ---: | ---: |
| 1 | 431 ms | 6.008 ms | 6.195 ms |
| 2 | 414 ms | 5.075 ms | 5.147 ms |
| 3 | 2,530 ms | 4.828 ms | 4.907 ms |
| 4 | 661 ms | 5.388 ms | 5.499 ms |
| 5 | 408 ms | 5.216 ms | 5.292 ms |

Median managed tool duration is 431 ms. Host execution is approximately 5–6 ms;
the remaining time is outside the host execution span. These measurements do
not separate routing, queueing, storage, and network time, and cannot explain
the 2.53-second outlier more precisely. Five samples are not tail percentiles.
The earlier failed calls are failure evidence, not a successful latency baseline.

Both services retained their post-upgrade PIDs and showed zero restarts during
the probes. No new `invalid call` or attachment fencing appeared in their
journals. See [curated tool and host events](linux-recovery-measurements.json).
Raw installation logs, systemd journal, catalog checks, CLI events, and cleanup
results are under `output/cross-platform-hands/` in this worktree.

## Retained-image VM smoke test

One fresh VM from `linux-paradigm` mounted successfully in **11,058 ms**.
Its `uname -s && printf hand_latency_probe` call returned Linux and the marker
with exit code zero: **355 ms** managed tool duration, **1.621 ms** guest command
wall time, and **2.193 ms** factory attachment span. The VM screen also published.
This is a functional check of the retained image with the new guest runtime,
not evidence of the newer master startup optimizations.

The scratch agent deletion succeeded and the factory allocations directory
returned to empty. Deletion fenced the VM attachment with `managed agent is
being deleted`; this release logged a release error and reconnected its control
channel, then reconciled successfully about 1.3 seconds later. Both systemd
PIDs remained unchanged with zero restarts. This cleanup reconnect is separate
from the native Hand's prior `invalid call` failure. See the
[VM smoke-test events](linux-vm-recovery-measurements.json).
