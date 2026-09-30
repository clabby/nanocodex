# One-time private secure input

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

The browser API does not support terminal stdin, native CUA input, arbitrary
application fields, or CAPTCHA. Native sudo uses the separate enrolled helper
boundary below; ordinary Hand RPC must never receive a plaintext password.

## Typed browser forms

The same conversation bottom sheet supports multiple private fields:

```js
request_secure_input({
  target_id, expected_origin, submit: false,
  fields: [
    {id: "card", kind: "card_number", selector: "#card-number"},
    {id: "expiry", kind: "card_expiry", selector: "#expiry"},
    {id: "cvc", kind: "card_cvc", selector: "#security-code"}
  ]
})
```

Supported kinds are `password`, `card_number`, `card_expiry`, `card_cvc`, and
`sensitive_text`. One to eight fields must be unique visible native inputs in
one same-origin top-frame HTTPS POST form. Password fields require password
inputs; other kinds accept text, tel, or password inputs. Iframes, custom controls,
readonly/disabled/inert, transparent, offscreen or occluded fields, duplicate
selectors and cross-origin form actions fail closed. Card number, expiry and CVC
inputs must also advertise the corresponding `cc-number`, `cc-exp` and `cc-csc`
HTML autocomplete tokens; generic text/contact fields cannot be relabeled as
card destinations. Page markup can still be malicious, so users must trust the
verified website origin. This is not universal form or native-app support.

The tool returns metadata only with `kind: "browser_form"`. The authenticated
client posts `{request_id, action: "describe"}` to the private endpoint and gets
exactly `{request_id, origin, expires_at, fields:[{id,kind,selector}]}`. Display labels
are app-owned. The client submits `{request_id, values:{card,expiry,cvc}}`; the map
must match the bound field IDs exactly. The aggregate encoded JSON limit is
32 KiB, including envelope and escaping, in addition to each 4096-character limit.
Legacy password requests still use `{request_id,value}`.

Typed requests require `submit:false` and never invoke form submission or click
a payment button. They dispatch native input/change events, so the approved
website's own handlers still run and can have side effects; a verified origin is
not a guarantee of benign site behavior. Receipts are `filled`, `outcome_unknown`, or
`cancelled`; downstream sign-in/payment actions need separate authorization.
The same quarantine, one-use consumption, loader binding and restart failure
behavior apply. All entered values stay transient; snapshots also redact numeric
values after common space, slash, dot or hyphen formatting changes.

The iOS sheet rises from the conversation, starts at medium height, expands for
review, and clears masked inputs on submission, dismissal or backgrounding.
Password-manager AutoFill metadata is supplied without requiring a Vault item;
third-party password-manager behavior still needs physical-device verification.
The simulator password/card/native journeys use synthetic inputs and share the
production sheet shell. The card receipt is a fixture; actual browser fill and
zero explicit submission are separately exercised by the Chrome/runtime journey.

## Enrolled native sudo

`request_native_secure_input({machine_id, executable, arguments, cwd})` prepares
one exact command on a supported, independently enrolled native macOS or Linux Hand. Paths are absolute and
arguments are an array. The model receives only an opaque `native_sudo` request
receipt, Hand ID, and expiry. The protected helper returns a signed ephemeral
recipient key bound to the command digest, uid, request ID, and expiry. The
backend verifies both its independently enrolled helper identity and the digest
of the requested command before storing metadata. See the
[native protocol](../../macos/secure-input/PROTOCOL.md) for canonical encodings.

The private client posts to `/v1/agents/{agent_id}/native-secure-input`:

- `{request_id, action:"describe"}` returns the authenticated command, uid,
  expiry, digest and recipient key (nine fields).
- `{request_id, ephemeral_public_key, ciphertext}` submits the client-encrypted
  envelope. No plaintext `value` field is accepted.
- `{request_id, action:"cancel"}` consumes the request and cancels its helper ticket.

Both HTTP boundaries enforce the existing owner, capability, Connect denial,
CSRF and body-size checks. Only this authenticated endpoint can sign the
ciphertext approval. Model tools cannot obtain a server approval signature.
The exact Hand route is pinned; replay, expiry, changed routes and missing
configuration fail closed. Submission is consumed before dispatch, and an
uncertain dispatch returns `outcome_unknown` without retry. Receipts contain
only type, request ID and status (`completed`, `failed`, `outcome_unknown`, `cancelled`).
Completed means exit status zero; failed means nonzero. Command output is never returned.

Deployment requires two operator-controlled Worker bindings:
`NATIVE_SECURE_INPUT_SIGNING_KEY` (secret P256 private JWK JSON) and
`NATIVE_SECURE_INPUT_HELPERS` (JSON mapping native machine IDs to independently
enrolled helper P256 x963 public keys in standard base64). The helper must pin
the corresponding backend signing public key through its locally approved
installation/enrollment. Neither binding is agent configuration, tool input,
or discovered from untrusted Hand output. Missing bindings leave this feature
unavailable. Repository tests do not provision keys, enroll a machine, install
a privileged helper, change sudoers, or deploy a Worker.

The mobile app or trusted local TUI encrypts directly to the helper. The backend and persisted Hand RPC
see only metadata, ciphertext and signatures. Ordinary Hand RPC durably retains
the ciphertext and approval signature in its input records; it never receives
plaintext. The native adapter forwards those
to the root-owned helper; arbitrary terminal input and native application fields
remain unsupported. This requires the separately installed protected helper;
an ordinary same-user process or FIFO is not a supported substitute.

## Remote Linux and local TUI boundary

A live shell Hand is not sufficient to accept a sudo password. Linux needs the
separately installed root recipient in [`linux/secure-input`](../../linux/secure-input/README.md),
just as macOS needs its signed protected helper. Unsupported platforms and
unenrolled devices fail closed. The existing mobile approval and the TUI use the
same command-bound encrypted wire format; neither posts plaintext to a model tool.
This is **sudo approval**, not a general-purpose remote terminal password API.

The local TUI uses a private review/input modal. It displays the authenticated
machine, peer uid, executable, cwd and exact argv before explicit approval.
The TUI requires freshly typed local safety tokens at phase boundaries; this deliberate
friction prevents already queued or partially decoded terminal paste from approving a
command or returning private text to the normal composer. Pasting a safety token is
not accepted. Keyboard and paste events are intercepted before the ordinary composer,
transcript and history paths, including while the modal loads or submits.
The private buffer is zeroized on completion, cancellation, expiry, navigation,
account changes and shutdown. Only encrypted submission and a fixed status receipt
leave that flow. `/secure-input` is not a chat message containing a password.
The opt-in Managed2 protocol does not support this private endpoint and must not
fall back to sending a value through a chat turn.

The client and its terminal are trusted user interfaces. A malicious terminal,
local keylogger, compromised OS administrator, or privileged command deliberately
approved by the user is outside the confidentiality boundary. Disabling process
inspection/core dumps and clearing buffers are defense in depth, not a promise
that every copy can be erased. Never ask the user to type a production secret into
an agent-controlled PTY, shell command, CUA target, tool argument or chat message.

First privileged installation is an unavoidable local trust bootstrap. It must
be approved through the operating system / administrator's trusted local session,
with independently authenticated public-key enrollment. Learning a helper key
from an ordinary Hand response and immediately pinning it is not enrollment.
The backend private signing key must be provisioned outside the model, never
printed, persisted in `/brain`, or passed as a tool argument. Tests use synthetic
keys and inputs only; a test installation does not enroll a production device.

Linux root enrollment explicitly binds a `transport_uid` (the actual Hand socket
peer) to a `sudo_uid` (the authentication user displayed and signed in the ticket).
Neither can be changed by the model or private password form. A trusted local
administrator may deliberately enroll service998 → login1000; absent that mapping,
a service998 Hand cannot use an unrelated human1000 password. Sudo/PAM policy
for the enrolled authentication user remains authoritative. This is not a silent
account substitution, sudoers relaxation, timestamp bypass or NOPASSWD workaround.
The macOS helper continues to bind authentication directly to its socket peer.

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

Native backend protocol failures and direct HTTP admission are exercised with
`cd js/managed && node_modules/.bin/vitest run test/native-secure-input.test.ts test/browser-vault-route.test.ts test/account-hosted-tools.test.ts`.
These use synthetic keys and a simulated Hand boundary; they do not prove a live
privileged installation or end-to-end sudo on a production-enrolled Hand. Native installation
and IPC details are in the native protocol linked above.

Native validation:

- `swift test --package-path macos/secure-input --jobs 3` checks the helper's
  cryptographic boundary without root or enrollment.
- `swift test --package-path macos/secure-input-integration --jobs 3` exercises
  the production Swift client and helper together with a synthetic authenticated
  transport. It does not exercise the JavaScript backend or real sudo.
- `cargo test -p nanocodex2-bin --bin nanocodex2 native_secure_input --jobs 3`
  on macOS or Linux verifies the native adapter's plaintext rejection and bounded framing.
- Managed `native-secure-input`, `browser-vault-route`, and the native cases in
  `hosted-tools-broker` / `account-hosted-tools` cover private HTTP admission,
  signatures, stale routes, replay and fixed receipts.
- `InboxUITests.testNativeCommandReviewAndDeniedAuthentication` exercises the
  production review and authorization gate using a simulated denial. Actual
  Face ID success, third-party password-manager AutoFill, signed installation,
  and privileged sudo remain separate device validation requirements.

Linux and TUI validation:

- `cargo test --manifest-path linux/secure-input/Cargo.toml --locked` covers
  cryptographic and unprivileged Linux OS boundaries. `linux/secure-input/build-release.sh`
  builds without installing; `package-release.sh` archives ordinary-mode files.
- The separate `linux/secure-input/tests/disposable_e2e.py` is destructive and root-only.
  Run **only in a freshly provisioned dedicated test VM/sandbox**, following its README
  setup and explicit test marker. It generates synthetic credentials at runtime and
  tests the unchanged release helper, actual setuid askpass, distro sudo/PAM,
  peer998/admin1000 mapping, rejected submissions, memory/core restrictions, slowloris,
  and the full120-second process timeout. It is never a production enrollment step.
- `cargo test -p nanocodex-managed native_secure_input` covers private HTTP, account
  and command review bindings, ciphertext roundtrip, bounded errors and safe receipts.
- TUI private overlay and PTY tests use synthetic secrets only. They do not authorize
  running an agent-controlled terminal to collect a real password.

A live production hand update requires actual administrator-approved installation,
independent helper-key pinning, the correct enrolled user mapping, a compatible Hand
binary, and verified service restart. A successful sandbox/PAM test, a staged binary,
or a merged PR is not evidence that those live steps have happened.
