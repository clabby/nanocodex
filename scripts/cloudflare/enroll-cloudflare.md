# Enroll an existing Cloudflare deployment credential

An account owner can explicitly authorize the protected `Cloudflare` workflow's
`enroll-cloudflare` dispatch target. Supply `enrollment_owner` (account UUID) and
`enrollment_operation` (new UUID). The job injects its existing
`CLOUDFLARE_API_TOKEN` secret into a native process, authenticates a Wrangler
remote service binding to the private egress Worker, creates an encrypted Vault
API key, and connects through that owner's Vault reference. It never deploys a
Worker or exposes a public enrollment route.

The CLI prints only a fixed status. `connected` means the broker validated the
token and reports the connection. It does not prove every provider permission;
verify the desired API read through the hosted `cloudflare_request` tool.

The job does not retry writes. After an uncertain result, inspect account
connector/Vault metadata before explicitly rerunning the same operation with
identical owner and secret. The operation identifies a Vault name; a rerun
reuses that entry and validates it again. Changing the secret requires a new
operation. Ambiguous duplicate entries fail closed. Invalid tokens leave the
existing connector unchanged and retain the new Vault entry for inspection.
Serialize manual invocations as the workflow does to avoid duplicate creation.

`node scripts/cloudflare/enroll-cloudflare.mjs --smoke` uses existing Wrangler
authentication to perform a read-only broker status request with a synthetic
owner. It returns `remote_binding_ready` or a fixed failure. It does not enroll.
Wrangler logs are redirected to the null device and child stdout/stderr are
ignored; no raw diagnostic or proxy URL is emitted or retained by the runner.

For an account-owned API token, set the `enrollment_account_id` workflow input (or `ENROLLMENT_ACCOUNT_ID` for native execution). Omit it for user tokens. The broker verifies account tokens at `/accounts/{account_id}/tokens/verify`; the Cloudflare deployment account alone does not select the token type. To connect an already-saved Vault item, call `account_connectors` with `connector: "cloudflare"`, `vault_id`, and `account_id`; do not repeat enrollment.
