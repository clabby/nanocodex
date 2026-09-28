# One-time browser password input

`request_secure_input({target_id, expected_origin, password_selector, submit})`
creates a five-minute request for a visible password field on a same-origin HTTPS
POST form in the managed browser. It does not read or create a Vault item. The
result contains `type: "secure_input"`, `status: "input_required"`, `request_id`,
`agent_id`, `origin`, `expires_at`, and `kind: "browser_password"`.

The account client posts JSON directly to
`/v1/agents/{agent_id}/secure-input`:

- Submit: `{request_id, value}` (1–4096 characters, no control characters).
- Cancel: `{request_id, action: "cancel"}`.

Both ingress and session routes require direct account authority and the
`agents:write` and `tools:use` capabilities. Browser account sessions also require
same-origin mutation authority. Connect grants are rejected. Requests have no
query parameters, use JSON, and are bounded to 32 KiB before parsing. Responses
are non-cacheable. The private submission does not enter conversation messages,
model tool arguments, tool events, or ordinary Hand RPC.

Receipts contain exactly `{type: "secure_input_receipt", request_id, status}`.
Status is `filled`, `submitted`, `action_required`, `outcome_unknown`, or
`cancelled`. Submission is not proof of sign-in. An ambiguous result is never
replayed automatically. Cancellation of a submitted request closes its browser
session; cancellation of an unsubmitted request removes only the request.

The host binds each request to the browser provider session, target, HTTPS
origin, document loader, and password selector. It validates the form before
asking for input and again before filling. The request is consumed before a
possibly ambiguous provider operation. Serialized browser access prevents
concurrent replay. Only request metadata is durable; the entered password is
held in runtime memory and sent on a private CDP transport.

Before injection, a durable quarantine blocks ordinary browser tools and
unsolicited model-facing CDP observations. `secure_input_snapshot({request_id})`
returns the existing bounded private snapshot with known password echoes
redacted. `secure_input_action({request_id, action, ...})` supports same-origin
navigation (`url`) and clicks on current snapshot refs (`snapshot_id`, `ref`).
These operations retain the password in runtime memory for redaction. After a
runtime restart they fail closed; quarantine survives, and the user must close
the browser and start again. `browser_vault_close({})` also discards this session.
No secret is written to durable storage for rehydration, and JavaScript does not
provide guaranteed zeroization of memory.

Page code on the explicitly approved origin receives the password. Snapshot
redaction is defense in depth, not a confidentiality guarantee against a
malicious credential destination. Private snapshots never return input values,
cookies, raw DOM, provider URLs, or screenshots.

This API does not support sudo, terminal stdin, native CUA input, arbitrary
application fields, or CAPTCHA. Ordinary Hand RPC persists tool input, and
same-user shell access could observe a FIFO or helper process. Secure native
input requires a separately protected native execution boundary.

## Local verification

Use synthetic passwords only. Run the account contract tests with
`node --experimental-strip-types --test js/account/src/secureInput.test.ts`
and the browser form journey with
`node js/account/scripts/secure-input-smoke.mjs`.
The browser journey uses an isolated headless Chrome profile and accepts
`CHROME_PATH` for the browser executable; evidence is written under
`output/secure-input/`.

The managed boundary scenarios are in `js/managed/test/secure-input.test.ts`
and `js/managed/test/browser-vault-route.test.ts`. The real Chrome/runtime
journey is `node js/managed/scripts/secure-input-chrome-e2e.mjs`.
The latter covers private CDP injection and observation isolation; HTTP account
admission remains covered separately through the Worker route tests.

`swift test --package-path apple/InboxCore --filter SecureInputTests` exercises
the native client contract. The `InboxUITests.testPrivatePasswordFieldAndSafeReceipt`
simulator test exercises the production secure field and receipt presentation
using synthetic input; it does not authenticate with a password-manager app or
exercise a live account. Invoke Xcode through `scripts/xcodebuild-guard.sh`.
