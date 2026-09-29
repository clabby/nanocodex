# Native adapter contract

The native Hand `native_secure_input` adapter connects to the installed daemon using this metadata/ciphertext-only protocol.

Connect Unix stream `/var/run/nanocodex-secure-input.sock`. Send exactly one JSON object followed by LF (maximum 32768 bytes, five-second absolute admission deadline); read one JSON object followed by LF then EOF. Socket root-owned mode0666; peer uid from getpeereid binds all operations. Public metadata and encrypted signed ciphertext only cross this socket.

- Prepare: `{ "operation":"prepare", "executable":"/absolute/path", "arguments":[], "cwd":"/absolute/path" }`
- Submit: `{ "operation":"submit", "request_id":"...", "ephemeral_public_key":"base64", "ciphertext":"base64", "signature":"base64" }`
- Cancel: `{ "operation":"cancel", "request_id":"..." }`

Prepare returns raw ticket `{request_id,command_digest,public_key,expires_at,uid,command:{executable,arguments,cwd},helper_signature}`. Expiry is Unix milliseconds. Errors return only `{status:"unavailable"}` or `{status:"rejected"}`. Submit returns `{request_id,status:"completed",exit_code:number}` or `{request_id,status:"outcome_unknown"}`. Cancel returns `{request_id,status:"cancelled"}`. Adapter must preserve this raw object. No command output is returned.

Helper signature: P256 ECDSA raw64 base64 over UTF8 `["nanocodex-secure-sudo-ticket-v1", request_id, command_digest, public_key, String(expires_at), String(uid)].join("\n")`. Recipient public key is P256 x963 base64. Root-held persistent helper signing identity must be pinned independently by the account backend per machine before accepting a ticket. A pin learned from ordinary Hand output is not enrollment.

Command digest SHA256 base64 of JSON UTF8 with keys in exact order `arguments,cwd,executable,uid`, unescaped slashes, no extra whitespace. Swift JSONEncoder sortedKeys+withoutEscapingSlashes; JSON.stringify({arguments,cwd,executable,uid}) compatible for standard JSON strings. Mobile receives uid as well to recompute digest from displayed argv/cwd. No executable contents are hashed; scripts and binaries may change after approval.

Mobile encrypts UTF8 JSON `{request_id,command_digest,value}` using ephemeral P256 ECDH, HKDF-SHA256 salt empty/info UTF8 request_id/key32, AES-GCM combined nonce12+ciphertext+tag16 base64. Server receives ciphertext only. Server signature P256 ECDSA raw64 base64 over UTF8 `["nanocodex-secure-sudo-v1",request_id,ephemeral_public_key,ciphertext].join("\n")`. Helper pins server approval public key x963 at local enrollment.

Root daemon invokes immutable `/usr/bin/sudo -A -k -- executable arguments...` after PT_DENY_ATTACH, clean environment and uid/gid drop. All standard descriptors are `/dev/null`. Separate root-owned4755 askpass connects root-only socket (0700 parent/0600 socket), sends actual getppid and real uid; daemon checks root peer and matches the launched sudo pid and uid, consumes once, and writes secret. Askpass outputs only to sudo-created pipe, never command stdin. No same-user FIFO, password argv/env, sudoers modification, sudo timestamp weakening, or PAM policy bypass. Production installation requires signed hardened root-owned binaries via locally approved installer. No live enrollment or setuid changes are performed by tests.
