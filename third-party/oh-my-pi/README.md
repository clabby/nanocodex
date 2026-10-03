# oh-my-pi attribution and port scope

Pinned source: [v18.4.4](https://github.com/can1357/oh-my-pi/tree/v18.4.4), MIT (see LICENSE).

`crates/nanocodex-claude/src/subscription_wire.rs` ports the subscription billing fingerprint/CCH helpers in `packages/ai/src/providers/anthropic.ts`, identity/device/tool mapping in `anthropic-identity.ts`, and defaults in `claude-code-fingerprint.ts`. Native header defaults are integrated in the shared Claude client. This is not a fork of OMP's full provider, OAuth store, model registry or retry engine.

The same MIT notice ships in the Rust crate and npm WASM package as `THIRD-PARTY-LICENSES`. Golden synthetic HTTP bodies in `tests/fixtures/omp-v18.4.4-wire.json` were independently checked against unchanged pinned OMP helpers running on Bun 1.4.2 (OMP requires Bun >=1.4). Tests cover Unicode/UTF16 selection, exact final checksum bytes, stable account-scoped metadata and preservation of literal markers. They contain no real grants or tokens.
