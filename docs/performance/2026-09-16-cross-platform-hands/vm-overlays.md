# Linux VM disk preparation — 2026-09-16

The repeated Linux VM disk copy dominated spare preparation. On the live
`linux-paradigm` factory, copying the 16 GiB sparse template took 3,570 ms and
syncing the copy took another 4,753 ms. Changing GNU `cp` from `--sparse=always`
to `--sparse=auto` did not help: 3,584 ms copying plus 5,335 ms syncing.
The template contains about 5 GB of allocated data. These are direct copy/sync
measurements on the factory's ext4 filesystem, not inferred from total startup.

## Change

Linux factories now boot the existing OverlayFS VM backend with an immutable
base and a separate sparse ext4 upper for each VM. Each upper is private;
changes to `/workspace` and the rest of the guest root survive factory recovery
without modifying the base. The guest keeps a read-only bind of its runtime
executable in `/run` after switching roots, so desktop capture works too.

Linux's `protected_hardlinks` correctly prevented the unprivileged factory from
linking the root-owned installed image. The factory therefore makes one private,
read-only cached base per source image identity. The identity includes device,
inode, size, modification time, and change time, including nanoseconds. Copying
uses the locked source descriptor, checks identity again afterward, and publishes
atomically. An initial cache miss still costs **7.20 seconds** in this run;
subsequent lookups took **0.006–0.007 ms**. No kernel hard-link protection or
installed-image ownership was changed.

Each allocation pins its exact base inode with a durable hard link. The lower
link is durable before publishing the upper; release removes the upper durably
before removing the lower. Replacing an installed image cannot redirect retained
allocations. Existing standalone allocation disks retain their original format.
Custom paths on different filesystems retain the ordinary private-copy fallback.

Recovery also keeps unrelated prepared spares alive. The first recovery trace
showed **128.5 ms** spent discarding one before opening a retained root; that
unnecessary shutdown is removed. A second live recovery opened the retained root
in **0.049 ms**, with guest readiness at **249.8 ms** from provision start.

## Measured result

The first successful cohort used the same running Linux machine and managed
provider as the earlier [installer measurements](linux-installer-fix.md).

| Local stage | New measurement |
| --- | ---: |
| New sparse upper, including sync | 6.05–9.44 ms |
| Guest boot and typed readiness | 250–316 ms |
| Complete prepared spare with desktop | 867–1,038 ms |
| Claim an already prepared spare | 0.664 ms |

Earlier complete spare preparation took **10,288–10,902 ms**. The new range is
roughly a tenfold improvement after the base is cached. It is not a claim that a
new image's first uncached startup takes one second.

Warm managed mounts still took **2,955 / 3,254 ms**. In the first cohort,
tools catalog preparation was 0.133 ms, WebSocket connection 1,681.9 ms, and catalog acknowledgement 194.5 ms.
The full attachment completed at 1,877.7 ms; desktop publication completed at
1,022.3 ms in parallel. Disk preparation does not explain or eliminate this
network/managed overhead. VM shell execution took 217 / 228 ms managed; the
first cohort spent 4.115 ms inside the guest.
The second attachment took 1,528.2 ms (WebSocket 1,304.6 ms, acknowledgement
222.3 ms); this small uncontrolled difference is not credited to the disk change.

A third baseline split the client connection further: TLS trust lookup took
0.026 ms, DNS completed at 0.505 ms, and TCP connected at 21.716 ms from connection
start. The WebSocket upgrade finished at 1,367.657 ms, followed by 239.814 ms
waiting for catalog acknowledgement. Thus about 1,346 ms remained after TCP;
DNS, TCP, and certificate-store loading were not the dominant waits. This span
still combines TLS and the HTTP upgrade/backend path. Fourteen attachment
protocol tests passed with that transport instrumentation.

## Verification and applicability

The live journey mounted a VM, checked that the guest runtime remains executable,
wrote `/workspace/overlay-proof` and `/etc/overlay-proof`, restarted the factory,
then read and verified both retained files from the same managed agent. Agent
deletion removed both allocation disks and base links; the factory remained
connected and prepared a new spare. The journey passed twice. `debugfs`
confirmed neither marker existed in the cached immutable base afterward.

37 VM-host tests cover ownership, lifecycle, immutable-base replacement, cache
reuse and invalidation, interrupted lower publication, independent upper disks,
failed spare adoption, and cross-filesystem fallback. All 121 VM-library tests
passed serially. An initial parallel run had one transient existing gvproxy
process-group test failure; that test also passed on an isolated rerun. Linux
host and musl guest optimized builds passed. Strict Clippy passed with the
existing `missing_const_for_fn` lint exception used by the preceding changes.

Windows factories running the Linux backend in WSL use this path. No Windows
hardware timing was collected. macOS keeps its existing APFS reflink path;
these Linux numbers are not Mac boot claims.

The live factory uses the scoped test executables under `/opt/nanocodex/vm-perf`
and `/etc/systemd/system/nanocodex-factory.service.d/90-vm-perf.conf`. The native
Hand service and installed release manifest were preserved. Remove that drop-in
when activating the consolidated release so normal installation owns the factory
again.

[Curated tool results, stage events, and artifact hashes](vm-overlay-measurements.json)
retain both cohorts. Raw logs are under `output/vm-perf/` in the VM worktree.

## Post-Worker comparison

The same factory and guest binaries were measured after managed Worker
`dd307c9e-d2aa-4752-af53-ea1559716905` deployed. Tools attachment took
**1,232 / 1,203 ms**, including **979 / 983 ms** to connect the WebSocket.
Full managed mounts took **3,979 / 3,096 ms**; these observations do not show a
consistent end-to-end mount improvement. Approximately **1,893 ms** remained
outside the factory attachment interval in the second sample. New spare
preparation stayed below one second in the first post-deployment cohort.

[Post-Worker tool results, client stage events, and exact artifact identities](vm-overlay-post-worker-measurements.json)
include shared request IDs for the matching Worker traces. Both agents were
deleted. The first VM also served three successful read-only screen viewer
measurements before deletion. The [Hand call report](hand-call-latency.md)
contains the matching server timings and remaining overhead ranking.
