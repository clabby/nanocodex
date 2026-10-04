# Workers WhatsApp runtime preparation

`pnpm --dir js/egress prepare:whatsapp` builds the ignored
`src/whatsapp-generated/baileys.js` and `bridge.wasm`. Run it from Wrangler's
custom build command, and alias `@whiskeysockets/baileys` to
`./src/whatsapp-generated/baileys.js` in the broker configuration. Keep the
`CompiledWasm` rule and `nodejs_compat` flag enabled.

Dependencies pin Baileys 7.0.0-rc14 and whatsapp-rust-bridge 0.5.4. Preparation
verifies both the bridge source and its scalar WASM hashes before replacing
runtime WASM compilation with a Workers module import. No cryptographic
algorithm is reimplemented. A guarded Baileys compatibility patch propagates
libsignal's false signature-verification result instead of accepting it.
Upgrading either package requires reviewing these checks and repeating the
real workerd crypto and WebSocket journey.

The WebSocket adapter uses Workers fetch upgrades. Protocol logging is silent.
Preparation drops direct console calls throughout the protocol dependency bundle,
including libsignal session lifecycle diagnostics that otherwise print private
ratchet and root keys despite the silent pino logger. This applies only to the
generated protocol bundle; broker diagnostics remain available. Its transitive
`debug` dependency is also replaced with a no-op logger, preventing media metadata
diagnostics from reaching stderr even when debugging is enabled in the environment. Media
transformation dependencies fail closed. The runtime only projects
received data and exposes pairing, close, logout, and keyed history requests.
Authentication persistence belongs to the external encrypted account store.

The crypto adapter also omits `setAAD` when authenticated data is empty.
workerd's Node-compatible GCM implementation otherwise fails authentication
on the empty-AAD transport used after Noise initialization. Omitting that call
has identical AEAD semantics; encryption and authenticated decryption still use
native `node:crypto`. Both empty/nonempty AAD and tamper rejection are verified.

Reproduce the protocol journey from the repository with Node 24:

```sh
pnpm --dir js/egress test:whatsapp-runtime
pnpm --dir js/egress test:whatsapp-runtime --upstream
node js/egress/test/whatsapp-runtime/node-upstream.mjs
```

The default journey uses an actual local binary WebSocket echo service and
actual workerd. It also establishes Signal sessions between two synthetic peers,
encrypts/decrypts messages, replaces both outgoing and incoming sessions, and
asserts that the shipped protocol bundle makes zero console calls. Console
arguments are never retained or printed by this check. This narrow integration
uses in-memory auth storage because the anonymous upstream handshake cannot
exercise authenticated Signal lifecycle transitions; it requires no real account
or phone linking. `--upstream` also performs an anonymous WhatsApp Noise handshake
and verifies pairing-ready. It never requests a phone number, registers a
linked device, or emits QR/code/credentials. The optional Node command is an
upstream comparison. Diagnostics are bounded to known protocol labels, frame
lengths and close status. Evidence is written to ignored
`output/whatsapp-runtime/`; no external lab checkout is required.

The runtime requests full history using `Browsers.ubuntu('Desktop')`, an
upstream-documented desktop profile. Full-history coverage is reported
conservatively, since a linked device may receive only partial data.
The workerd journey uses the same Miniflare version as Wrangler and the broker's
`2026-07-29` compatibility date.
