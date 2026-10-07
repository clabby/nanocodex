# Changelog

All notable changes to Nanocodex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.7](https://github.com/gakonst/nanocodex/releases/tag/v0.6.7) - 2026-10-07

### Bug Fixes

- Fix managed Claude recovery and cover Codex-to-Opus delegation ([#840](https://github.com/gakonst/nanocodex/issues/840))
- [managed] Carry model through combined and resumed lifecycle startup
- [claude] Strictly decode SSE and finish managed media and voice coverage
- [claude] Share streamed/final message identity; admit attachments and live voice routing for Claude
- Fix gateway model selection in the terminal picker ([#802](https://github.com/gakonst/nanocodex/issues/802))
- Satisfy private-input lint and master spelling checks
- [sessions] Keep Done HTTP journey lint-clean

### Dependencies

- Add protected Linux Hand sudo approval and private TUI input ([#693](https://github.com/gakonst/nanocodex/issues/693))
- Merge pull request [#682](https://github.com/gakonst/nanocodex/issues/682) from gakonst/speedups-combined
- Select CI jobs from the crate graph and add a draft fast lane

### Features

- [tui] Cache recent prompts across sessions and copy replies ([#806](https://github.com/gakonst/nanocodex/issues/806))
- Add private TUI input with default Vault saving and reuse
- [sessions] Continue recent mobile threads in tmux and mark sessions done
- [models] Migrate Sol to GPT-6.1 ([#679](https://github.com/gakonst/nanocodex/issues/679))
- Fork committed agent boundaries and add side conversations

### Miscellaneous Tasks

- Release 0.6.6
- Remove obsolete docs, artifacts, and low-signal tests ([#568](https://github.com/gakonst/nanocodex/issues/568))

### Other

- Expose connector and Vault services through REST, hosted forms, JavaScript and Rust ([#757](https://github.com/gakonst/nanocodex/issues/757))
- Merge remote-tracking branch 'origin/master' into fix/hand-retirement-final-20261006
- Merge remote-tracking branch 'origin/master' into fix/hand-menu-compact-20261006
- Merge master into account workspace redesign
- Merge pull request [#791](https://github.com/gakonst/nanocodex/issues/791) from gakonst/fix/claude-backend-voice-attachments
- Merge master into Claude fix; preserve prepared Vault journeys and loopback CI
- Merge master into Claude fixes; preserve model-aware admission and origin enrichment
- Manage connectors and Vault through native account APIs ([#817](https://github.com/gakonst/nanocodex/issues/817))
- Prefer submitting Hands and add brokered SSH recovery ([#801](https://github.com/gakonst/nanocodex/issues/801))
- Defer optional thread startup work and batch SDK first prompts ([#797](https://github.com/gakonst/nanocodex/issues/797))
- Merge pull request [#780](https://github.com/gakonst/nanocodex/issues/780) from gakonst/feat/tui-private-input-vault-20261005
- Add brokered Vault requests and private signing for agents and CLI ([#747](https://github.com/gakonst/nanocodex/issues/747))
- Merge master into native Hand recording preserving screen and ownership contracts
- Merge pull request [#706](https://github.com/gakonst/nanocodex/issues/706) from gakonst/codex/notable-capabilities-20260930
- Merge master into personal storage without dropping current routes or test suites
- Merge remote-tracking branch 'origin/master' into merge-agent2/pr715-20261002
- Merge current master and retain steering through shared WASM harness builder
- Merge pull request [#657](https://github.com/gakonst/nanocodex/issues/657) from gakonst/codex/nanoclaude
- Merge current master into Nanoclaude provider integration
- Split provider tool crates and integrate managed Claude subscriptions
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-final
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-api
- Add opt-in observer steering, image contracts, and receipt-time retries
- Merge commit 'refs/audit/merge-master-20260930' into audit/pr697-20260930
- Merge commit 'refs/audit/merge-master-20260930' into audit/pr674-20260930
- Merge commit 'refs/audit/merge-master-20260930' into audit/pr673-20260930
- Merge pull request [#688](https://github.com/gakonst/nanocodex/issues/688) from gakonst/feat/continue-tmux-20260930
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr692-20260930
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr673-20260930
- Validate Done acknowledgements before CLI success and offline cache mutation
- Merge pinned integration base preserving continuation and secure input state
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr674-20260930
- Shared links as multiplayer Chat turns with live web UI ([#669](https://github.com/gakonst/nanocodex/issues/669))
- Revocable sharing for managed threads and TUI ([#660](https://github.com/gakonst/nanocodex/issues/660))
- Expose owner Hand call aggregates in nanocodex2 CLI ([#630](https://github.com/gakonst/nanocodex/issues/630))

### Performance

- Create fresh CLI runs with one managed request ([#843](https://github.com/gakonst/nanocodex/issues/843))
- Reduce direct Hand preparation and terminal flush overhead ([#838](https://github.com/gakonst/nanocodex/issues/838))
- [cli] Overlap optional tool preparation with cloud admission ([#839](https://github.com/gakonst/nanocodex/issues/839))
- Pipeline fresh CLI creation and first prompt ([#830](https://github.com/gakonst/nanocodex/issues/830))

## [0.6.5](https://github.com/gakonst/nanocodex/releases/tag/v0.6.5) - 2026-09-24

### Bug Fixes

- [managed] Always allow steering and cancellation
- [router] Preserve existing managed event protocol for route updates ([#523](https://github.com/gakonst/nanocodex/issues/523))
- [runtime] Prevent image replay crashes and reconcile steering delivery ([#435](https://github.com/gakonst/nanocodex/issues/435))

### Features

- Add running-agent navigation and tmux overview ([#560](https://github.com/gakonst/nanocodex/issues/560))
- [router] Add Kimi and MiMo with mobile model controls ([#519](https://github.com/gakonst/nanocodex/issues/519))
- [tui] Add authenticated rich terminal integration ([#344](https://github.com/gakonst/nanocodex/issues/344))
- Add opt-in autoroute UX and retained provider display

### Miscellaneous Tasks

- Prepare release 0.6.5 ([#584](https://github.com/gakonst/nanocodex/issues/584))

### Other

- Merge remote-tracking branch 'origin/master' into perf/screen-direct-latency-20260923
- Merge remote-tracking branch 'origin/master' into perf/screen-latency-20260923
- Merge [#528](https://github.com/gakonst/nanocodex/issues/528): retire legacy facts and preserve Codex memory APIs
- Retire legacy facts while preserving Codex memory and background personalization
- Merge remote-tracking branch 'origin/master' into remove-legacy-memory
- Remove legacy memory storage and personalization
- Merge remote-tracking branch 'origin/master' into fix/turn-controls-merge
- Integrate GPT-6 Sol and Luna across Nanocodex ([#526](https://github.com/gakonst/nanocodex/issues/526))
- Restore unchanged repository files omitted from frontier REST publication
- Support configured Cloudflare REST transport for frontier inference ([#495](https://github.com/gakonst/nanocodex/issues/495))
- Run one persistent Hand daemon per machine ([#483](https://github.com/gakonst/nanocodex/issues/483))
- Merge pull request [#436](https://github.com/gakonst/nanocodex/issues/436) from gakonst/poc/thread-model-routing
- Merge latest master and retain voice lifecycle controls
- Add opt-in Jev thread routing with Workers AI GLM transport
- Forward Codex turn metadata and surface Sky consent in foreground Hands ([#429](https://github.com/gakonst/nanocodex/issues/429))

### Performance

- [cli] Present first responses immediately and finish shutdown promptly
- [cli] Make startup editable before backend discovery

## [0.6.4](https://github.com/gakonst/nanocodex/releases/tag/v0.6.4) - 2026-09-19

### Bug Fixes

- [tui] Open file links from their owning Hand
- [managed] Satisfy access cache lint checks

### Features

- [tui] Add Vault credential approval without raw JSON ([#361](https://github.com/gakonst/nanocodex/issues/361))
- [cli] Add managed native voice and measure end-to-end flows
- [agent] Scope personal memories and attribute startup callers
- [connect] Add ChatGPT account failover and per-session pins ([#343](https://github.com/gakonst/nanocodex/issues/343))
- [hands] Unify computer publishers and reduce startup latency

### Miscellaneous Tasks

- Prepare release 0.6.4 with minified QuickJS fix ([#420](https://github.com/gakonst/nanocodex/issues/420))
- Prepare corrected release 0.6.3 ([#418](https://github.com/gakonst/nanocodex/issues/418))
- Prepare release 0.6.2 ([#416](https://github.com/gakonst/nanocodex/issues/416))

### Other

- Merge origin/master into feat/mobile-project-threads
- Merge master and align image preparation and replay with codex-rs
- Merge remote-tracking branch 'origin/master' into feat/background-cua-integration
- Merge remote-tracking branch 'origin/master' into feat/hand-rtmp
- Merge remote-tracking branch 'origin/master' into perf/hand-video-60fps
- Merge origin/master into Windows Hand installer

### Performance

- [managed] Prepare active conversations before prompt submission
- [managed] Reuse short-lived request authorization

### Testing

- Verify request arrival in incomplete-download fixture ([#388](https://github.com/gakonst/nanocodex/issues/388))

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

- [durability] Store complete turns and memory without arbitrary content quotas
- [remote] Restore VM desktop before tool reconnection
- [apple] Preserve repository tree in native playtest update
- [apple] Preserve reading position and playtest navigation edge cases
- [managed] Retry transient thread history reads
- [managed] Keep durable sessions responsive across reconnects
- [managed] Document VM connector boundary
- [managed] Harden VM hand lifecycle
- [managed] Control attached turns by durable id
- [durability] Cancel turns at admission
- [managed] Harden workspace execution clients
- [managed] Release test locks before await
- [managed] Retain cloud fallback on initial attach failure
- [managed] Await reverse tool attachment readiness
- [managed] Separate event sequence from durable cursor
- [managed] Keep lifecycle identities backend-neutral

### Features

- Undo pending steering and queued messages
- [managed] Expose settings and durable schedule controls
- Align Astra defaults and Code Mode with Codex ([#275](https://github.com/gakonst/nanocodex/issues/275))
- [managed] Add scoped VM hand factories
- Complete GPT-6 Astra integration
- Prepare GPT-6 Astra support
- [managed] Share VM hands across an account
- [managed] Attach retained VM compute hands
- [managed] Route execution through cwd namespaces
- [managed] Harden durable brain and hands
- [managed] Add brain and hands workspace fabric
- [nanocodex2] Add hosted model controls
- [nanocodex2] Stream managed turns over websocket
- [nanocodex2] Ship instant managed TUI
- [nanocodex2] Add durable interactive attach
- [managed] Add separate lifecycle backend crate

### Miscellaneous Tasks

- Release nanocodex 0.6.0 ([#330](https://github.com/gakonst/nanocodex/issues/330))

### Other

- Merge remote-tracking branch 'origin/master' into codex/durable-current-execution
- Merge pull request [#264](https://github.com/gakonst/nanocodex/issues/264) from gakonst/fix/remove-astra-entitled
- Merge pull request [#252](https://github.com/gakonst/nanocodex/issues/252) from gakonst/feat/host-vm-pools
- Merge pull request [#251](https://github.com/gakonst/nanocodex/issues/251) from gakonst/feat/gpt-6-astra-readiness
- Merge pull request [#235](https://github.com/gakonst/nanocodex/issues/235) from gakonst/feat/named-workspace-fabric
- Merge remote-tracking branch 'origin/master' into codex/pr243-managed-wallet
- Merge nanocodex2 TUI and live startup
- Merge pull request [#217](https://github.com/gakonst/nanocodex/issues/217) from gakonst/refactor/durability-total-state

### Performance

- [nanocodex2] Create agents over the live socket

### Refactor

- [astra] Remove catalog entitlement projection
- [durability] Replace journals with total state

### Testing

- [managed] Complete attachment drain handshake

<!-- generated by git-cliff -->
