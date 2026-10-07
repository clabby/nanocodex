# Changelog

All notable changes to Nanocodex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.7](https://github.com/gakonst/nanocodex/releases/tag/v0.6.7) - 2026-10-07

### Bug Fixes

- [claude] Recover from context-window exhaustion ([#721](https://github.com/gakonst/nanocodex/issues/721))
- Fix Claude subscription compatibility and paused-turn recovery

### Dependencies

- Merge pull request [#682](https://github.com/gakonst/nanocodex/issues/682) from gakonst/speedups-combined
- Select CI jobs from the crate graph and add a draft fast lane
- Split nanocodex-tools features and trim unused JS dependencies

### Features

- Add native Claude coding workflows and recovery
- Fork committed agent boundaries and add side conversations

### Miscellaneous Tasks

- Release 0.6.6
- Remove obsolete docs, artifacts, and low-signal tests ([#568](https://github.com/gakonst/nanocodex/issues/568))

### Other

- Merge current master and fix OTP fixture wording
- Merge remote-tracking branch 'origin/master' into feat/tui-private-input-vault-20261005
- Merge pull request [#775](https://github.com/gakonst/nanocodex/issues/775) from gakonst/feat/claude-code-native-20261005
- Merge master into native Hand recording preserving screen and ownership contracts
- Merge pull request [#706](https://github.com/gakonst/nanocodex/issues/706) from gakonst/codex/notable-capabilities-20260930
- Merge master into personal storage without dropping current routes or test suites
- Merge remote-tracking branch 'origin/master' into pr715
- Merge remote-tracking branch 'origin/master' into merge-agent2/pr715-20261002
- Merge remote-tracking branch 'origin/master' into integrate-717
- Merge current master and retain steering through shared WASM harness builder
- Resolve Claude integration conflicts and scope test lock before await
- Merge master and preserve both Claude usage and fast-mode journeys
- Merge pull request [#657](https://github.com/gakonst/nanocodex/issues/657) from gakonst/codex/nanoclaude
- Port pinned OMP subscription wire profile with frozen durable affinity
- Merge current master into Nanoclaude provider integration
- Split provider tool crates and integrate managed Claude subscriptions
- Expose durable Claude JavaScript runtime and harden recovery
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-final
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-api
- Add durable Claude subscription OAuth and public facade integration
- Integrate Claude with shared durability and host tool lifecycles
- Add opt-in observer steering, image contracts, and receipt-time retries
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr673-20260930
- Merge remote-tracking branch 'origin/master' into feat/continue-tmux-20260930
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr674-20260930
- [durability] Remove checkpoint and store changes from [#682](https://github.com/gakonst/nanocodex/issues/682)
- Trim incremental checkpoints to the essential change
- Fold the Postgres store check into the durability integration binary
- Persist model boundaries incrementally and move SQLite off the executor

### Styling

- Add strict JSON Schema output and expose provider-reported model ([#656](https://github.com/gakonst/nanocodex/issues/656))

## [0.6.5](https://github.com/gakonst/nanocodex/releases/tag/v0.6.5) - 2026-09-24

### Bug Fixes

- [router] Accept Workers AI streams and terminate protocol failures ([#522](https://github.com/gakonst/nanocodex/issues/522))
- [runtime] Prevent image replay crashes and reconcile steering delivery ([#435](https://github.com/gakonst/nanocodex/issues/435))
- [durability] Defer developer checkpoints until queued turns settle ([#502](https://github.com/gakonst/nanocodex/issues/502))
- Keep subagents ephemeral and remove restart recovery ([#509](https://github.com/gakonst/nanocodex/issues/509))
- Preserve routed children across managed idle recovery

### Miscellaneous Tasks

- Prepare release 0.6.5 ([#584](https://github.com/gakonst/nanocodex/issues/584))

### Other

- Restore unchanged repository files omitted from frontier REST publication
- Support configured Cloudflare REST transport for frontier inference ([#495](https://github.com/gakonst/nanocodex/issues/495))
- Merge pull request [#436](https://github.com/gakonst/nanocodex/issues/436) from gakonst/poc/thread-model-routing

## [0.6.4](https://github.com/gakonst/nanocodex/releases/tag/v0.6.4) - 2026-09-19

### Bug Fixes

- Align hosted compaction retries and HTTPS fallback with codex-rs ([#370](https://github.com/gakonst/nanocodex/issues/370))

### Miscellaneous Tasks

- Prepare release 0.6.4 with minified QuickJS fix ([#420](https://github.com/gakonst/nanocodex/issues/420))
- Prepare corrected release 0.6.3 ([#418](https://github.com/gakonst/nanocodex/issues/418))
- Prepare release 0.6.2 ([#416](https://github.com/gakonst/nanocodex/issues/416))

### Other

- Merge origin/master into feat/mobile-project-threads
- Merge remote-tracking branch 'origin/master' into fix/hosted-image-output
- Merge remote-tracking branch 'origin/master' into feat/hand-rtmp

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

- [durability] Checkpoint recovered cancellations ([#301](https://github.com/gakonst/nanocodex/issues/301))
- [durability] Emit terminals only after durable settlement
- [durability] Checkpoint current execution and retire settled effects
- [apple] Preserve repository tree in native playtest update
- [apple] Preserve reading position and playtest navigation edge cases
- [durability] Stream large checkpoints within the Worker memory budget
- [durability] Recover from authoritative operation settlement
- [durability] Recover with retained model requests
- [managed] Retain steering and sandbox work across retries
- [durability] Replay completed tool outputs exactly
- [ci] Satisfy durability const lints
- [durability] Remove billing uncertainty state
- [durability] Settle uncertain effects safely
- [durability] Harden adversarial store boundaries
- [managed] Preserve exact durable dispatch state
- [managed] Chunk durable recovery state
- [durability] Fence authoritative execution end to end
- [durability] Terminally commit failed turns
- Fix durable subagent recovery ownership
- [durability] Satisfy WASM clippy
- [agent] Journal prompts automatically

### Documentation

- [durability] Show progressive composition

### Features

- Undo pending steering and queued messages
- Align Astra defaults and Code Mode with Codex ([#275](https://github.com/gakonst/nanocodex/issues/275))
- [durability] Persist clean agent descendants
- [durability] Persist spawned agent trees
- [managed] Run nondurable subagents from durable roots
- [agent] Expose durable request identities
- [durability] Add portable journal runtime

### Miscellaneous Tasks

- Release nanocodex 0.6.0 ([#330](https://github.com/gakonst/nanocodex/issues/330))

### Other

- Merge remote-tracking branch 'origin/master' into codex/durable-current-execution
- Revert "feat(durability): persist spawned agent trees"
- Merge pull request [#226](https://github.com/gakonst/nanocodex/issues/226) from gakonst/fix/btw-unstored-fork
- Merge pull request [#217](https://github.com/gakonst/nanocodex/issues/217) from gakonst/refactor/durability-total-state
- Merge remote-tracking branch 'origin/master' into codex/cloud-accounts-playground
- Bound managed durability receipt state
- Bound managed agent durability growth
- Merge remote-tracking branch 'origin/master' into codex/cloud-accounts-playground
- Merge pull request [#181](https://github.com/gakonst/nanocodex/issues/181) from gakonst/feat/durable-runtime

### Performance

- [durability] Collapse redundant settlement state

### Refactor

- [durability] Persist bounded execution records across hosts
- [durability] Replay committed effects only
- [durability] Replace journals with total state
- [agent] Make turn results backend-neutral
- [durability] Own agent integration above lifecycle

### Testing

- [durability] Cover replayable steering withdrawal ([#324](https://github.com/gakonst/nanocodex/issues/324))

<!-- generated by git-cliff -->
