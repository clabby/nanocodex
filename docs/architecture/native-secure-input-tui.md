# Trusted terminal native sudo approval

The legacy managed terminal accepts `/secure-input` to select a safe pending
receipt, or `/secure-input AGENT_ID REQUEST_UUID`. This is a local control, never
password-bearing chat. Only the current main agent/pane can open the control;
Managed2 and unsupported operating systems fail closed without a chat fallback.

The client first fetches the concrete persistent account UUID from authenticated
`GET /v1/me`, using the same fixed bearer credential as its private describe,
submit and cancel requests. Review shows account, agent, machine, request, UID,
expiry, command digest, executable, working directory and every indexed argument.
Controls, bidi and formatting characters are displayed literally. The complete
review must fit the terminal; otherwise approval/input/submission are disabled.

Crossterm's shared decoder can retain incomplete bracketed paste and escape
sequences. A quiet queue drain is only a mitigation, not a freshness proof. Each
review, password admission and status dismissal therefore requires a newly
rendered, 32-hex UUIDv4 safety token (122 bits of random entropy). Type the token
with ordinary keys, **not paste**, then use the indicated control. Matching keeps
only an index, not an input string; paste, repeats, modified keys and mismatches
cannot satisfy it. Tokens change with phases and focus changes. A partial stale
paste absorbs any typed token and is discarded: it cannot enable input or exit.
This deliberate extra interaction is required until the terminal decoder offers
a trustworthy parser/kernel reset. The token is public UI metadata, not a secret.

Before opening private input, macOS requires `PT_DENY_ATTACH` and zero hard/soft
core limits. Linux requires zero hard/soft core limits, `PR_SET_DUMPABLE=0`, a
successful nondumpability readback and `TracerPid=0` checked after nondumpability
is established. Failure leaves password input disabled. Protection is permanent
for that process. Root compromise, an already compromised process and an
untrusted terminal/SSH endpoint are outside this boundary.

All terminal events are intercepted before normal AppEvent, composer, clipboard,
control/debug, history, chat and export paths, including loading, review and
submission. The password lives in a fixed zeroizing 4096-byte buffer with no
Debug/Serialize/Clone; backspace erases removed bytes in place. Rendering uses a
constant eight-star mask independent of length. Focus loss or unexpected focus
gain, scope changes, cancellation and shutdown discard the buffer. Cancellation
retains an input quarantine; returning to chat requires the fresh status token
and an explicit Esc. Sending cannot be undone and uncertain outcomes are never
retried. Escape from sending reports uncertainty rather than claiming rollback.

Encryption is synchronous and local: P256 ECDH, HKDF-SHA256 with empty salt and
request UUID info, AES-256-GCM with fresh 12-byte nonce and nonce+ciphertext+tag.
Only ciphertext enters a task or HTTP builder. Responses/errors are bounded and
projected to fixed statuses; no remote error text or command output is reflected.
The model receives only the request UUID and a fixed status receipt. Temporary
crypto plaintext/key buffers and the owned password buffer are zeroizing; this
does not claim universal erasure of terminal/kernel/clipboard/library copies.

Synthetic acceptance tests are in `nanocodex2_tui_lifecycle`: real PTY raw keys,
bracketed paste, exact encrypted roundtrip, stale/partial paste across review,
password and dismissal, focus cancellation, and absence of plaintext in normal
HTTP/chat/history/terminal output. Managed client tests use local fixture servers
for authentication, strict metadata, crypto binding, malformed/oversized/private
error suppression and response-loss/no-retry. They do not install/enroll helpers,
change sudoers, access real credentials, execute privileged commands or deploy.
