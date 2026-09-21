# Connect API

## Fresh connector status for connected apps

`GET /v1/grants/:grantId/connectors?providers=spotify,soundcloud` returns:

- `account_id`, `agent_id`, and the current `grant` projection;
- `connectors`, containing only the requested API providers and their currently
  connected identities selected by this grant.

Send the grant's opaque bearer token, `x-nanocodex-app-id`, and the registered app
`Origin`, as with other grant routes. The endpoint validates the current grant,
expiry, app binding, and live connector identities on every request. Responses
are `no-store`; consumers must not cache the authorization decision.

`providers` is a required, comma-separated, non-duplicated list of API connector
capabilities. ChatGPT is excluded because its credential status lives in a
separate broker. This endpoint never reads Vault credentials, account balances,
or the account's authorization index. It returns no provider credentials or grant
bearer token. Use account-info when the full account summary is needed.
