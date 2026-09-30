# Secure Vault intake and website approval

`request_vault_intake` renders an inline card in managed web and iPhone/iPad chat.
The card opens a client-owned form. Login passwords, API keys, card values,
addresses and phone numbers are submitted directly to the authenticated Vault
endpoint, never as conversation or tool arguments. Only an allowlisted saved
receipt is sent back into the original conversation. Closing the form or changing
accounts discards its input. Unknown save outcomes are not automatically retried.

For an existing login without a website binding, request
`{ operation: "authorize_origin", kind: "login", vault_id, origin }`.
The form retrieves the actual saved item's name, displays the exact HTTPS website,
and updates only `browser_origin`; the user does not reenter the password. Approval
replaces the prior website binding. There are no wildcard or subdomain grants.
Legacy entries remain usable for their existing HTTP Vault operations, but private
browser login requires website approval.

Account-session mutations retain same-origin protection. Native Vault forms use
persistent account API keys with `agents:write` and `tools:use`; Connect grants,
anonymous accounts and read-only keys cannot mutate Vault. Website approval and
Vault resolution use the current account's broker. The browser-only materialization
RPC is reachable through the managed service binding, never model HTTP egress.

## Hosted browser

Managed sessions expose `browser_execute` through the Cloudflare `BROWSER` binding
and `LOADER` Worker loader. The browser runs independently of mounted Hands.
The default Chromium provider uses one-shot sessions: complete navigation and
inspection in one call; page state does not persist between calls. Attached
computer browsers continue to use workdir-scoped CUA. Restricted-network and multiplayer sessions do not receive
hosted browser tools. Every browser call requires current full account tool
authority; Connect grants cannot access the account's retained browser.

Production, development, and an unset `MANAGED_BROWSER_PROVIDER` select `chromium`;
development uses a remote `BROWSER` binding. Kitesurf has no private Vault or
secure-input browser tools. Chromium exposes `browser_private_checkout_inspect`
for an explicitly authorized named Vault login and a public checkout URL. It opens
its own host-owned Chromium connection, validates the login's approved HTTPS
origin and document, signs in once, and returns only fixed checkout capability
flags. It disconnects and awaits browser deletion before returning, reporting
uncertain cleanup explicitly; it cannot continue a `browser_execute` session.
Credentials, page text, connection IDs and payment tokens never enter tool
results. It activates only the sign-in control, not booking, payment,
registration, password-reset or consent controls. Merchant sign-in can have side
effects. It does not solve verification challenges. An uncertain login result
must not be retried automatically.

The private inspection uses upstream CDP directly and leaves public
`browser_execute` commands unchanged. JavaScript-backed login forms are supported
with browser-enforced CSP blocking all native form navigation, including direct
`form.submit()`. Sign-in through JavaScript fetch/XHR works; native POST/GET form
navigation is unsupported. Runtime closure aborts and drains private operations;
provider connection and deletion requests have independent eight-second limits.
Inspection is not proof of successful sign-in or Link compatibility: a challenge or missing opt-in marker needs further
authorized work. Generic secure-input and private continuation remain unavailable
with one-shot providers.
Authenticated waitlist submission uses `browser_private_waitlist`. Supply a saved,
explicitly authorized Vault login, the public checkout URL, exact expected class
title/date/time/instructor, and a stable UUID `operation_id`. `operation: "inspect"`
returns fixed action and capability fields. `operation: "join"` additionally
requires `authorize_join: true` and explicit user authorization for that class.
The host verifies the class and captured control immediately before the one
submission. It activates only the standalone **Join the Waitlist** control;
purchase/payment controls, credit spending, guest/recurring booking, and required
unchecked policies stop submission. Arketa's standalone join action is recognized
separately from its purchase-and-join flow; other sites require an explicit free
or zero-total indication. Missing price alone is not treated as a free purchase.

The operation journal persists in the agent's Durable Object. Identical retries
return the saved result, changed arguments under the same UUID are rejected, and
an uncertain or confirmed join fences further submission for that Vault/class
across new UUIDs. Read-only inspection can reconcile an uncertain result without
submitting again. A click is not a successful join: a visible, class-matched
waitlist confirmation is required. Credentials and arbitrary private page text
remain outside tool results; the public upstream browser tools are unchanged.

Deploy the managed Worker to apply the binding and tool changes.
Deployments without a browser binding can still serve ordinary agent turns.

The retained `cloudflare` and `browserbase` providers must be explicitly selected
for the private browser flows below. They reuse their sessions between calls.

For an explicitly authorized named Vault login, use `browser_vault_status` and
`browser_vault_fill` with the exact approved HTTPS origin. Credential entry
isolates the session from ordinary browser inspection. Continue through redacted
`browser_vault_snapshot` and constrained `browser_vault_action` calls. Submission
alone does not prove successful sign-in.

Verification codes use `browser_vault_request_challenge`; human-only gates use
`browser_vault_request_takeover`. These authenticated client forms send private
input directly to the bound browser challenge. Passwords, codes, cookies and
browser connection URLs never belong in chat, tool arguments or artifacts.
`browser_vault_close` discards the private browser session. Idle sessions are swept,
and deleting the agent closes its browser.
