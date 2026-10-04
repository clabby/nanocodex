Run from the repository root with Node 24:

```sh
node --test js/egress/test/whatsapp-account.node.test.mjs
```

The runner bundles the actual WhatsAppAccount and CredentialVault into Miniflare/workerd with SQLite Durable Object storage. Only the upstream transport module is aliased, because contacting WhatsApp is inappropriate in synthetic tests. The subclass supplies synthetic socket callbacks; all user actions call the actual DO HTTP endpoints. Fixture endpoints exist only in this test worker and are never exported by production.

The journey covers private pairing retrieval and cache headers, concurrent exact replay, mismatched operation conflicts, approval and socket state, chat/contact/message search, cursor scope and paging, context and history, account isolation, sticky view-once suppression across edits, earliest expiry preservation across omitted/later-deadline edits and actual elapsed-time expiration, permanent revocation tombstones, unlink/relink ID rotation, stale socket events, registered-credentials restart before first open, and real workerd eviction followed by an actual persisted reconnect alarm.

The key test is an intentionally narrow storage integration check: encrypted-at-rest material cannot be verified through the user HTTP interface. It checks envelope shape and absence of a known plaintext marker, then checks Uint8Array round-trip after real eviction. The expiry seam advances only the attempt deadline, retaining production expiration and generation invalidation behavior.

Each run writes the HTTP transcript to ignored `js/egress/output/whatsapp-account-journey.json`. All accounts, phones, codes, and cryptographic material are synthetic. The runner uses the Miniflare version shipped with Wrangler through its V4 compatibility converter, so it needs no new dependencies.

The routed broker journey runs the original egress entrypoint, UserConnectorBroker, subject directory, and WhatsAppAccount under workerd:

```sh
node --test js/egress/test/whatsapp-broker.node.test.mjs
```

Only the WhatsApp upstream transport is synthetic. The bundle includes the real Nanocodex WASM and uses the production unsupported-node-rsa adapter. Its transcript is `js/egress/output/whatsapp-broker-journey.json`. Status mismatches are collected until the end so a control-route regression still leaves evidence for independent data-route checks.
