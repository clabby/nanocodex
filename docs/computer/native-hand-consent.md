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
