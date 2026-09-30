# Retained private browser HTTP journey

This opt-in journey runs a local Worker over HTTP with the real managed browser
runtime and remote Cloudflare Chromium. Its separate synthetic merchant records
independent login, booking, profile-save, and synthetic checkout POST counts.
The fixture cannot charge money or create a real booking. Only Vault resolution
uses fixed synthetic credentials; production Vault authorization and storage are
not covered. Do not deploy the local harness.

Build workspace dependencies, then deploy a temporary fixture with a unique name:

```sh
npx --yes pnpm@11.25.0 --filter nanocodex-managed-service exec wrangler deploy \
  --config scripts/wrangler.private-browser-fixture.jsonc \
  --name YOUR_TEMPORARY_FIXTURE_NAME
```

Start the harness in a separate terminal using the returned HTTPS origin:

```sh
npx --yes pnpm@11.25.0 --filter nanocodex-managed-service exec wrangler dev \
  --config scripts/wrangler.private-browser-smoke.jsonc \
  --var FIXTURE_ORIGIN:https://YOUR_TEMPORARY_FIXTURE_NAME.YOUR_SUBDOMAIN.workers.dev \
  --port 8797
```

Run from the repository root:

```sh
PRIVATE_BROWSER_FIXTURE_ORIGIN=https://YOUR_TEMPORARY_FIXTURE_NAME.YOUR_SUBDOMAIN.workers.dev \
  node js/managed/scripts/private-browser-smoke.mjs
```

The runner verifies caller and origin rejection, sign-in and encoded credential
echo redaction, retained-session resumption without another login, stale snapshot
rejection, booking UUID replay after runtime reconstruction, ordinary text and
textarea fills, selection and checkbox changes, profile submission, and a
synthetic stored-method purchase. Public-browser checks inspect the separate
session for the absence of the private target, authenticated cookie, and session
storage marker. Same-origin navigation is exercised and its UUID replay returns the cached receipt.
Final merchant counts before takeover must be exactly one login, booking,
profile-save, and synthetic checkout, with zero authenticated public visits or
credential-bearing GETs. Action receipts alone are never treated as confirmation.

`PRIVATE_BROWSER_SMOKE_URL` overrides the local endpoint.
`PRIVATE_BROWSER_SMOKE_OUTPUT` overrides `output/private-browser/journey`.
The ignored output contains structured request/response traces and a summary.
The runner stops dependent steps on failure and closes retained sessions in
`finally`. Two private-takeover recovery cases type a synthetic secret through the host-only
user input route and confirm a merchant input event. After runtime reconstruction,
snapshots must reject, whether takeover finished before or after reconstruction.
The live runtime must redact the echoed secret. The harness discards viewport data
and returns only the takeover status. `--takeover-only` runs these two independent
recovery cases.

`--secure-input-only` runs one isolated post-login journey: fresh Vault sign-in,
same-origin navigation to a native POST form, `request_secure_input` with typed
fields and `submit=false`, then host-only `runtime.submitSecureInput`. The harness
generates an alphanumeric synthetic secret internally; tool requests never carry
it. The fixture echoes plain and base64 forms, both of which must be redacted by
`secure_input_snapshot`. A generic `secure_input_action` click and its identical
UUID replay must produce exactly one independently counted merchant POST. After
runtime reconstruction without closing Chromium, the secure snapshot must reject
with a close-required error. Separate probe counters preserve the other journeys.
The default run includes this case; `--takeover-only` remains limited to takeover.

The reconstruction check creates a new managed runtime over the same
Durable Object storage; it is not a full Worker process restart.

Stop Wrangler and remove the fixture after validation:

```sh
npx --yes pnpm@11.25.0 --filter nanocodex-managed-service exec wrangler delete \
  --config scripts/wrangler.private-browser-fixture.jsonc \
  --name YOUR_TEMPORARY_FIXTURE_NAME
```

The fixture intentionally echoes synthetic credentials into visible page text so
that redaction is tested across the actual transport. It does not persist submitted
fields. No real merchant account, card, Sage booking, or payment provider is used.
