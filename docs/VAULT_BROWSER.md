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
development uses a remote `BROWSER` binding. The one-shot `chromium` and `kitesurf`
providers do not expose private Vault or secure-input browser tools.
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
