# Native Hand computer access

Nanocodex uses the official CUA MCP catalog and signed native helper, but does not
bundle or run a Codex app server on the managed macOS path. See
[direct MCP host](direct-mcp-host.md) for the exact dependency and permission model.

The outer Rust MCP client remains a thin transport and advertises no elicitation
capability itself. The direct macOS host is the provider's MCP client and supplies
native application-access consent from the trusted host's explicit
`NANOCODEX_CUA_APP_CONSENT=allow` setting. The managed launcher defaults to blanket app access; a trusted host can set
`deny` to disable it. The module denies access without an explicit `allow` value.

Blanket application-access consent is not blanket authorization for purchases,
messages, sensitive-data transmission, account changes, microphone/audio access,
or arbitrary provider requests. Only empty native app-access forms during an
active JavaScript invocation are eligible. Unknown requests and data-bearing
forms are never automatically accepted. The signed helper's protected-target
checks, OS permissions, and authenticated Hand boundaries remain in place.

Known local/MDM managed policy causes the direct host to fail closed until that
policy has a proper integration. It does not claim to be a signed-in Codex account
or invent authentication, requirements discovery, or enterprise-policy results.

There is no per-app Nanocodex approval dialog. The old dedicated official
app-server's process-local `approval_policy="never"` and
`sandbox_mode="danger-full-access"` overrides are superseded on the managed
macOS path by this direct host; do not restore the retired bridge or edit a
user's ordinary Codex configuration to obtain app access. Known provider or
organization restrictions are not overridden.

Confidential sudo input remains a separate exact-command flow through
`request_native_secure_input` and an independently enrolled protected helper.
The authentication user is enrollment-bound, not caller-selected. Installation
and first enrollment require trusted local administrator approval; passwords
never belong in chat, tool arguments, or an agent-visible terminal. This is not
a general native browser/login-password input mechanism.
