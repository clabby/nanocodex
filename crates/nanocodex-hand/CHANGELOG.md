# Changelog

All notable changes to Nanocodex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.7](https://github.com/gakonst/nanocodex/releases/tag/v0.6.7) - 2026-10-07

### Bug Fixes

- [hand] Discard paused input and reject unverified recording storage
- [hand] Require native video and coordinate OS-owned updates

### Dependencies

- Merge pull request [#682](https://github.com/gakonst/nanocodex/issues/682) from gakonst/speedups-combined

### Features

- [hand] Add native scoped workflow recording and evidence controls

### Miscellaneous Tasks

- Release 0.6.6
- Remove obsolete docs, artifacts, and low-signal tests ([#568](https://github.com/gakonst/nanocodex/issues/568))

### Other

- Merge pull request [#713](https://github.com/gakonst/nanocodex/issues/713) from gakonst/feat/hand-recording-20261001
- Merge master into native Hand recording preserving screen and ownership contracts
- Merge master into personal storage without dropping current routes or test suites
- Merge current master and retain steering through shared WASM harness builder
- Bring native Claude integration up to date with master
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-final
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-api
- Provision required native video and gate Hand setup on its video desktop
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr673-20260930
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr674-20260930
- Make check:fast pass on macOS hosts

## [0.6.5](https://github.com/gakonst/nanocodex/releases/tag/v0.6.5) - 2026-09-24

### Miscellaneous Tasks

- Prepare release 0.6.5 ([#584](https://github.com/gakonst/nanocodex/issues/584))

### Other

- Restore unchanged repository files omitted from frontier REST publication
- Support configured Cloudflare REST transport for frontier inference ([#495](https://github.com/gakonst/nanocodex/issues/495))

### Performance

- [remote] Reduce WAN media fallback and scale video bitrate

## [0.6.4](https://github.com/gakonst/nanocodex/releases/tag/v0.6.4) - 2026-09-19

### Bug Fixes

- Restore cross-platform CI checks and Hand client shutdown ([#386](https://github.com/gakonst/nanocodex/issues/386))
- [hand] Restore Mac WebRTC video and share capture policy ([#359](https://github.com/gakonst/nanocodex/issues/359))
- [hand] Advertise reachable WebRTC addresses behind NAT
- [hands] Allow explicit websocket screen transport behind NAT

### Features

- [hand] Preserve high-resolution Mac video with shared encoder settings ([#360](https://github.com/gakonst/nanocodex/issues/360))
- [hand] Support relative Windows pointer control
- [hand] Configure Windows video resolution and bitrate
- [hands] Capture Windows system audio with WASAPI loopback
- [hands] Capture and control the native Windows desktop
- [hands] Unify computer publishers and reduce startup latency

### Miscellaneous Tasks

- Prepare release 0.6.4 with minified QuickJS fix ([#420](https://github.com/gakonst/nanocodex/issues/420))
- Prepare corrected release 0.6.3 ([#418](https://github.com/gakonst/nanocodex/issues/418))
- Prepare release 0.6.2 ([#416](https://github.com/gakonst/nanocodex/issues/416))

### Other

- Merge origin/master into feat/mobile-project-threads
- Merge master and align image preparation and replay with codex-rs
- Merge pull request [#379](https://github.com/gakonst/nanocodex/issues/379) from gakonst/fix/hand-video-level-ranges
- Make H264 level match ranges disjoint
- Merge remote-tracking branch 'origin/master' into feat/hand-rtmp
- Add high-quality RTMP broadcasting for connected Hand screens
- Merge pull request [#350](https://github.com/gakonst/nanocodex/issues/350) from gakonst/feat/remote-fullscreen-control
- Merge commit 'd1de7d86' into feat/hand-stream-audio
- Integrate shared 60 fps video with Windows desktop capture
- Merge pull request [#345](https://github.com/gakonst/nanocodex/issues/345) from gakonst/perf/hand-video-60fps
- Merge origin/master into Windows Hand installer

### Performance

- [hands] Stream shared remote screens at 60 fps

## [0.6.1](https://github.com/gakonst/nanocodex/releases/tag/v0.6.1) - 2026-09-15

### Bug Fixes

- [voice] Ship verified native runtime in 0.6.1 ([#333](https://github.com/gakonst/nanocodex/issues/333))

## [0.6.0](https://github.com/gakonst/nanocodex/releases/tag/v0.6.0) - 2026-09-15

### Rust API migration

Read the [0.5 → 0.6 Rust API changelog and migration guide](https://github.com/gakonst/nanocodex/blob/v0.6.0/docs/MIGRATING_0_6.md) before upgrading.

- **Breaking:** turn usage and snapshots are optional; session IDs are strings; prompt wrappers now target `PromptRequest`.
- **Breaking:** `hosted` tool APIs move to `embedded`; Code Mode execution/wait returns `Result`; protocol literals gain asynchronous fields.
- **Behavior:** default model/reasoning changes to Astra/low; resumed sessions use current instructions and tools; billing-uncertainty metrics and generic MCP resource helpers are removed.
- **Optional SDK layers:** durable execution with caller-owned storage, reusable subagent orchestration, and a managed backend. Browser, egress, VM, and voice leave experimental paths; computer and evals retain the label.

### Features

- [packages] Promote browser, egress, VM, Hand, and voice packages ([#329](https://github.com/gakonst/nanocodex/issues/329))

### Miscellaneous Tasks

- Release nanocodex 0.6.0 ([#330](https://github.com/gakonst/nanocodex/issues/330))

<!-- generated by git-cliff -->
