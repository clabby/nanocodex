# Changelog

All notable changes to Nanocodex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.7](https://github.com/gakonst/nanocodex/releases/tag/v0.6.7) - 2026-10-07

### Miscellaneous Tasks

- Release 0.6.6
- Remove obsolete docs, artifacts, and low-signal tests ([#568](https://github.com/gakonst/nanocodex/issues/568))

### Other

- Merge master into native Hand recording preserving screen and ownership contracts
- Merge master into personal storage without dropping current routes or test suites
- Merge remote-tracking branch 'origin/master' into merge-agent2/pr715-20261002
- Merge current master and retain steering through shared WASM harness builder
- Merge pull request [#657](https://github.com/gakonst/nanocodex/issues/657) from gakonst/codex/nanoclaude
- Split provider tool crates and integrate managed Claude subscriptions
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-api
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr673-20260930
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr674-20260930

## [0.6.5](https://github.com/gakonst/nanocodex/releases/tag/v0.6.5) - 2026-09-24

### Miscellaneous Tasks

- Prepare release 0.6.5 ([#584](https://github.com/gakonst/nanocodex/issues/584))

### Other

- Restore unchanged repository files omitted from frontier REST publication
- Support configured Cloudflare REST transport for frontier inference ([#495](https://github.com/gakonst/nanocodex/issues/495))

## [0.6.4](https://github.com/gakonst/nanocodex/releases/tag/v0.6.4) - 2026-09-19

### Miscellaneous Tasks

- Prepare release 0.6.4 with minified QuickJS fix ([#420](https://github.com/gakonst/nanocodex/issues/420))
- Prepare corrected release 0.6.3 ([#418](https://github.com/gakonst/nanocodex/issues/418))
- Prepare release 0.6.2 ([#416](https://github.com/gakonst/nanocodex/issues/416))

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

### Bug Fixes

- [apple] Preserve repository tree in native playtest update
- [apple] Preserve reading position and playtest navigation edge cases

### Features

- [nanocodex2] Trace VM hand activity

### Miscellaneous Tasks

- Release nanocodex 0.6.0 ([#330](https://github.com/gakonst/nanocodex/issues/330))

### Other

- Merge pull request [#179](https://github.com/gakonst/nanocodex/issues/179) from gakonst/perf/minimize-agent-overhead
- Merge remote-tracking branch 'origin/master' into agent/eval-cluster-dashboard

### Performance

- Reduce agent startup overhead

## [0.5.0](https://github.com/gakonst/nanocodex/releases/tag/v0.5.0) - 2026-08-12

### Miscellaneous Tasks

- [release] Refresh 0.5.0 changelogs
- [release] Prepare 0.5.0

### Other

- Merge pull request [#169](https://github.com/gakonst/nanocodex/issues/169) from gakonst/release/0.5.0

## [0.4.0](https://github.com/gakonst/nanocodex/releases/tag/v0.4.0) - 2026-08-11

### Bug Fixes

- [tls] Standardize rustls on ring
- [ci] Stabilize observability tests

### Features

- Support Luna

### Miscellaneous Tasks

- [release] Refresh 0.4.0 changelogs
- [release] Prepare 0.4.0

### Other

- Merge pull request [#160](https://github.com/gakonst/nanocodex/issues/160) from gakonst/release/v0.4.0
- Merge pull request [#86](https://github.com/gakonst/nanocodex/issues/86) from gakonst/fix/ring-only-rustls
- Merge pull request [#80](https://github.com/gakonst/nanocodex/issues/80) from clabby/cl/luna

### Testing

- [observability] Consume OTLP request bodies

## [0.3.0](https://github.com/gakonst/nanocodex/releases/tag/v0.3.0) - 2026-07-28

### Miscellaneous Tasks

- [release] Refresh 0.3.0 changelogs
- [release] Prepare 0.3.0

### Other

- Merge pull request [#50](https://github.com/gakonst/nanocodex/issues/50) from gakonst/refactor/05-observability

### Refactor

- Stabilize public SDK surface
- Consolidate the OpenAI Responses API

### Testing

- [observability] Verify full-fidelity turn traces

## [0.2.0](https://github.com/gakonst/nanocodex/releases/tag/v0.2.0) - 2026-07-26

### Features

- [mcp] Prewarm deferred default servers
- [cli] Route OpenAI through Tempo MPP

### Miscellaneous Tasks

- [release] Prepare 0.2.0

### Other

- Merge pull request [#2](https://github.com/gakonst/nanocodex/issues/2) from gakonst/feat/mpp-integration

## [0.1.1](https://github.com/gakonst/nanocodex/releases/tag/v0.1.1) - 2026-07-23

### Bug Fixes

- [ci] Tolerate OTLP warm-up connections
- [ci] Read complete OTLP test headers

### Features

- [observability] Add end-to-end OTLP tracing
- Add MCP observability and release automation

### Miscellaneous Tasks

- [release] Prepare 0.1.1
- [release] Prepare 0.1.0
- [release] Refresh 0.1.0 changelogs
- [release] Add per-crate changelogs
- [release] Automate publishing and native updates

<!-- generated by git-cliff -->
