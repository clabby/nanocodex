# Changelog

All notable changes to Nanocodex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.7](https://github.com/gakonst/nanocodex/releases/tag/v0.6.7) - 2026-10-07

### Bug Fixes

- Expose Nanoclaude across managed agents, mobile and subagents ([#716](https://github.com/gakonst/nanocodex/issues/716))
- [subagents] Decouple message intent from thread correlation ([#684](https://github.com/gakonst/nanocodex/issues/684))
- Fix subagent test Clippy warning in master CI

### Dependencies

- Merge pull request [#682](https://github.com/gakonst/nanocodex/issues/682) from gakonst/speedups-combined
- Split nanocodex-tools features and trim unused JS dependencies

### Features

- Add native Claude coding workflows and recovery
- [agent] Route native Codex and Claude harnesses

### Miscellaneous Tasks

- Release 0.6.6
- Remove obsolete docs, artifacts, and low-signal tests ([#568](https://github.com/gakonst/nanocodex/issues/568))

### Other

- Merge current master and fix OTP fixture wording
- Merge remote-tracking branch 'origin/master' into feat/tui-private-input-vault-20261005
- Merge pull request [#775](https://github.com/gakonst/nanocodex/issues/775) from gakonst/feat/claude-code-native-20261005
- Merge master into native Hand recording preserving screen and ownership contracts
- Merge master into personal storage without dropping current routes or test suites
- Merge remote-tracking branch 'origin/master' into pr715
- Merge remote-tracking branch 'origin/master' into merge-agent2/pr715-20261002
- Merge current master and retain steering through shared WASM harness builder
- Merge pull request [#657](https://github.com/gakonst/nanocodex/issues/657) from gakonst/codex/nanoclaude
- Merge current master into Nanoclaude provider integration
- Split provider tool crates and integrate managed Claude subscriptions
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-final
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-api
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr673-20260930
- Merge remote-tracking branch 'origin/master' into feat/continue-tmux-20260930
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr674-20260930
- Enforce strict typed subagent spawn contracts and verify live child completion ([#666](https://github.com/gakonst/nanocodex/issues/666))

### Styling

- Add strict JSON Schema output and expose provider-reported model ([#656](https://github.com/gakonst/nanocodex/issues/656))

## [0.6.5](https://github.com/gakonst/nanocodex/releases/tag/v0.6.5) - 2026-09-24

### Bug Fixes

- [subagents] Remove mailbox caps and render readable TUI cards
- [ci] Version TUI control dependencies and simplify test condition
- Keep subagents ephemeral and remove restart recovery ([#509](https://github.com/gakonst/nanocodex/issues/509))
- [subagents] Make result revisions runtime-owned ([#484](https://github.com/gakonst/nanocodex/issues/484))
- [subagents] Restore evicted children and preserve live checkpoints ([#494](https://github.com/gakonst/nanocodex/issues/494))
- Fix threads blocked by stale child checkpoint bindings ([#488](https://github.com/gakonst/nanocodex/issues/488))
- Fix child transcript leakage and harden error recovery boundaries ([#471](https://github.com/gakonst/nanocodex/issues/471))
- Preserve routed children across managed idle recovery
- Admit routed children and clarify structured tool contracts

### Features

- [router] Add Kimi and MiMo with mobile model controls ([#519](https://github.com/gakonst/nanocodex/issues/519))

### Miscellaneous Tasks

- Prepare release 0.6.5 ([#584](https://github.com/gakonst/nanocodex/issues/584))

### Other

- Merge remote-tracking branch 'origin/master' into remove-legacy-memory
- Route non-GPT children while preserving manual GPT spawning ([#536](https://github.com/gakonst/nanocodex/issues/536))
- Merge remote-tracking branch 'origin/master' into fix/turn-controls-merge
- Integrate GPT-6 Sol and Luna across Nanocodex ([#526](https://github.com/gakonst/nanocodex/issues/526))
- Restore unchanged repository files omitted from frontier REST publication
- Support configured Cloudflare REST transport for frontier inference ([#495](https://github.com/gakonst/nanocodex/issues/495))
- Merge pull request [#436](https://github.com/gakonst/nanocodex/issues/436) from gakonst/poc/thread-model-routing
- Merge master into thread routing, preserving voice controls and typed subagent diagnostics
- Route CUA by workdir and disable legacy browser backends ([#480](https://github.com/gakonst/nanocodex/issues/480))
- Merge master photo UI and conversation controls into PR469
- Complete pinned provider and child routing with runtime validation
- Preserve unfinished provider routing and subagent integration
- Add opt-in Jev thread routing with Workers AI GLM transport

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
- [subagents] Make native and JavaScript concurrency unlimited by default
- [agent] Restore mixed legacy host contexts
- [managed] Harden VM hand lifecycle
- [cloudflare] Restore interrupted subagents
- [ci] Restore cross-package compatibility
- [subagents] Observe batch children at creation

### Features

- [managed] Add scoped VM hand factories
- Complete GPT-6 Astra integration
- [subagents] Bound inactive session residency
- [subagents] Start coordinated agent batches atomically
- [js] Expose direct subagent lifecycle
- [subagents] Configure spawned model and thinking

### Miscellaneous Tasks

- Release nanocodex 0.6.0 ([#330](https://github.com/gakonst/nanocodex/issues/330))

### Other

- Merge pull request [#252](https://github.com/gakonst/nanocodex/issues/252) from gakonst/feat/host-vm-pools
- Merge pull request [#251](https://github.com/gakonst/nanocodex/issues/251) from gakonst/feat/gpt-6-astra-readiness
- Merge pull request [#217](https://github.com/gakonst/nanocodex/issues/217) from gakonst/refactor/durability-total-state
- Merge master into durable runtime
- Merge pull request [#193](https://github.com/gakonst/nanocodex/issues/193) from gakonst/feat/viem-v3-js-api

### Refactor

- [tools] Separate embedded execution placement
- [subagents] Extract reusable native and wasm extension

<!-- generated by git-cliff -->
