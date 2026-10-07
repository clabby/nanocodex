# Changelog

All notable changes to Nanocodex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.7](https://github.com/gakonst/nanocodex/releases/tag/v0.6.7) - 2026-10-07

### Bug Fixes

- Fix CUA verification cache and remove inactive integration configuration ([#755](https://github.com/gakonst/nanocodex/issues/755))
- [release] Include unchanged crates in 0.6.6 changelogs

### Dependencies

- Merge pull request [#698](https://github.com/gakonst/nanocodex/issues/698) from gakonst/codex/direct-cua-retry
- Merge pull request [#682](https://github.com/gakonst/nanocodex/issues/682) from gakonst/speedups-combined
- Select CI jobs from the crate graph and add a draft fast lane

### Features

- [computer] Supercharged CUA — strip upstream confirmation policies by default ([#730](https://github.com/gakonst/nanocodex/issues/730))

### Miscellaneous Tasks

- Release 0.6.6

### Other

- Merge remote-tracking branch 'origin/master' into fix/hand-menu-compact-20261006
- Merge master into account workspace redesign
- Restore upstream Sky browser sessions without Codex app-server ([#809](https://github.com/gakonst/nanocodex/issues/809))
- Install the Mac Hand automatically and connect it on CLI sign-in ([#786](https://github.com/gakonst/nanocodex/issues/786))
- Merge master into PR preview branch
- Merge pull request [#737](https://github.com/gakonst/nanocodex/issues/737) from gakonst/whatsapp-workers-20261004
- Apply rustfmt to inherited computer policy changes
- Merge remote-tracking branch 'origin/master' into whatsapp-workers-20261004
- Merge current master into Nanoclaude provider integration
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-final
- Merge remote-tracking branch 'origin/master' into codex/nanoclaude-api
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr692-20260930
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr673-20260930
- Merge pinned integration base preserving continuation and secure input state
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr674-20260930
- Merge commit 'refs/audit/integration-base-20260930' into audit/pr697-20260930
- Complete no-Codex Linux CUA host and refuse unverified managed paths
- Merge pull request [#694](https://github.com/gakonst/nanocodex/issues/694) from gakonst/codex/direct-cua-mcp
- Preserve host policy-source paths without exposing them to CUA JavaScript
- Replace managed macOS app-server bridge with direct CUA MCP host
- Make macOS direct CUA packaging native-computer-only
- Provision direct CUA hosts without bundled Codex CLI

## [0.6.5](https://github.com/gakonst/nanocodex/releases/tag/v0.6.5) - 2026-09-24

### Bug Fixes

- [computer] Collapse nested provision test condition
- [computer] Enable upstream CUA discovery and turn metadata in Linux VMs ([#520](https://github.com/gakonst/nanocodex/issues/520))
- Let official CUA own execution deadlines ([#491](https://github.com/gakonst/nanocodex/issues/491))
- Preserve CUA execution budgets and explain native recovery ([#489](https://github.com/gakonst/nanocodex/issues/489))
- [cua] Bound provider calls by their requested deadline
- Fix official browser accessibility in CUA launchers ([#462](https://github.com/gakonst/nanocodex/issues/462))
- Fix Windows Sky decline probe launcher ([#459](https://github.com/gakonst/nanocodex/issues/459))
- [cua] Run the official Linux Sky helper on the desktop host ([#454](https://github.com/gakonst/nanocodex/issues/454))
- [computer] Host official Windows Sky through native pipe ([#437](https://github.com/gakonst/nanocodex/issues/437))
- [computer] Hash Windows bootstrap without module functions ([#432](https://github.com/gakonst/nanocodex/issues/432))

### Features

- [computer] Manage the official macOS CUA host lifecycle

### Miscellaneous Tasks

- Prepare release 0.6.5 ([#584](https://github.com/gakonst/nanocodex/issues/584))

### Other

- Make CUA and Hand setup native, seamless, and cross-platform ([#571](https://github.com/gakonst/nanocodex/issues/571))
- Merge remote-tracking branch 'origin/master' into perf/screen-latency-20260923
- Restore unchanged repository files omitted from frontier REST publication
- Support configured Cloudflare REST transport for frontier inference ([#495](https://github.com/gakonst/nanocodex/issues/495))
- Run macOS CUA headlessly with official Codex approval policy ([#485](https://github.com/gakonst/nanocodex/issues/485))
- Merge master into thread routing, preserving voice controls and typed subagent diagnostics
- Merge pull request [#476](https://github.com/gakonst/nanocodex/issues/476) from gakonst/feat/managed-native-openai-host
- Merge master photo UI and conversation controls into PR469
- Merge branch 'feat/elevenlabs-voice-cloning' into feat/mobile-elevenlabs-voices
- Merge remote-tracking branch 'origin/master' into feat/elevenlabs-voice-cloning
- Merge latest master and retain voice lifecycle controls
- Merge pull request [#460](https://github.com/gakonst/nanocodex/issues/460) from gakonst/fix/cua-deadline-current
- Remove custom CUA consent UI and handlers ([#456](https://github.com/gakonst/nanocodex/issues/456))
- Merge remote-tracking branch 'origin/master' into finish/thread-routing-20260921
- Remove custom CUA and use the official Sky MCP provider ([#448](https://github.com/gakonst/nanocodex/issues/448))
- Forward Codex turn metadata and surface Sky consent in foreground Hands ([#429](https://github.com/gakonst/nanocodex/issues/429))

### Performance

- [cli] Cache computer startup and cancel background work on exit

## [0.6.4](https://github.com/gakonst/nanocodex/releases/tag/v0.6.4) - 2026-09-19

### Bug Fixes

- [computer] Support Linux background function and navigation keys
- [cua] Capture Mac desktop and preserve screenshot errors ([#353](https://github.com/gakonst/nanocodex/issues/353))
- [computer] Preserve integer Windows click counts

### Features

- [computer] Automatically install official upstream CUA ([#413](https://github.com/gakonst/nanocodex/issues/413))
- [computer] Parallel background window control and agent cursors ([#377](https://github.com/gakonst/nanocodex/issues/377))
- [hands] Expose live screen control through computer tools
- [hand] Ship one-click Windows installer

### Miscellaneous Tasks

- Prepare release 0.6.4 with minified QuickJS fix ([#420](https://github.com/gakonst/nanocodex/issues/420))
- Prepare corrected release 0.6.3 ([#418](https://github.com/gakonst/nanocodex/issues/418))
- Prepare release 0.6.2 ([#416](https://github.com/gakonst/nanocodex/issues/416))

### Other

- Attach the installed upstream CUA provider through its MCP contract ([#406](https://github.com/gakonst/nanocodex/issues/406))
- Merge PR [#395](https://github.com/gakonst/nanocodex/issues/395): independent CUA loops, scoped dialog focus and offline upgrade
- Merge origin/master into feat/mobile-project-threads
- Merge master and align image preparation and replay with codex-rs
- Merge remote-tracking branch 'origin/master' into feat/communications-orchestration
- Merge pull request [#372](https://github.com/gakonst/nanocodex/issues/372) from gakonst/feat/background-cua-integration
- Make background AppKit windows key before their first click
- Clarify background native paste limitations
- Add experimental background app CUA for macOS and Hyprland
- Merge remote-tracking branch 'origin/master' into perf/hand-video-60fps
- Merge pull request [#340](https://github.com/gakonst/nanocodex/issues/340) from gakonst/codex/windows-hand-installer

### Testing

- [computer] Resolve Python absolutely on Windows

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
- Add parallel Sky-compatible computer use ([#315](https://github.com/gakonst/nanocodex/issues/315))

### Miscellaneous Tasks

- Release nanocodex 0.6.0 ([#330](https://github.com/gakonst/nanocodex/issues/330))

<!-- generated by git-cliff -->
