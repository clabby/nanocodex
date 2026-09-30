# Private checkout inspection journey

This opt-in journey invokes the actual managed browser tool over Worker HTTP and
uses remote Cloudflare Chromium. It needs Cloudflare access and creates no VM.
Only the Vault resolver is replaced with fixed synthetic credentials. The public
fixture accepts only those credentials and cannot create a real payment.
Production Vault storage/authentication, Sage sign-in, and Link payment are not
covered by this fixture.

From the repository root, install dependencies and build the local tools and
protocol packages using the pinned pnpm version. Publish the synthetic website
with a unique temporary Worker name:

```sh
pnpm --filter nanocodex-managed-service exec wrangler deploy \
  --config scripts/wrangler.private-checkout-fixture.jsonc \
  --name YOUR_TEMPORARY_FIXTURE_NAME
```

In a separate terminal, start the local tool harness using the HTTPS origin
returned by that deployment:

```sh
pnpm --filter nanocodex-managed-service exec wrangler dev \
  --config scripts/wrangler.private-checkout-smoke.jsonc \
  --var 'FIXTURE_ORIGIN:https://YOUR_TEMPORARY_FIXTURE_NAME.YOUR_SUBDOMAIN.workers.dev' \
  --port 8798
```

Run the journey from the repository root:

```sh
node js/managed/scripts/private-checkout-smoke.mjs
```

It checks sign-in, a page echoing synthetic credentials (including an encoded
password), a verification-code challenge, blocked native GET fallback and
asynchronous native `form.submit()`, runtime closure while Vault resolution is
paused before filling, cross-origin navigation, Vault-origin rejection, caller
rejection, and a fresh independent browser. Results under ignored `output/private-checkout/journey`
contain capability flags and counts only. The runner finishes all cases and
returns a nonzero exit status if any case fails. The tool exposes no script argument,
raw text, screenshot, browser/session handle, credential, or payment token.
The fixture stores per-run counts in a Durable Object. The journey requires zero
credential-bearing GET arrivals and confirms that the asynchronous native-submit
handler ran; it does not store submitted fields. Both blocked native GET cases
allow only `login_required` or `outcome_unknown`, never successful inspection.
Chromium may change the document context or show an error document after CSP
blocks native navigation, preventing private inspection from completing. An
`outcome_unknown` result is therefore acceptable only with
`failure_stage=inspection`, `reason=private_inspection_failed`, and server
evidence: zero credential-bearing GET arrivals and, for direct submission,
exactly one asynchronous handler attempt. The close
case awaits runtime shutdown and requires `unavailable` with `login_attempted=false`.
The local harness has no public Worker route and must not be deployed.

The private helper installs a browser-enforced `form-action 'none'` Content
Security Policy before filling credentials. All native form navigation, including
GET, POST, and direct `form.submit()`, is unsupported. JavaScript sign-in handlers
that send POST requests with `fetch` can still work. The helper fills the login
and activates its sign-in control once; it does not activate booking,
payment, or consent controls. Website behavior during filling or sign-in may
still have side effects. This journey does not prove website side effects are
impossible.

To type-check the harness and fixture with dependencies resolved from the managed
package, create a temporary ignored config inside that package:

```sh
mkdir -p js/managed/.harness
cat > js/managed/.harness/tsconfig.private-checkout.json <<'JSON'
{
  "extends": "../tsconfig.json",
  "include": ["../scripts/private-checkout-smoke.ts", "../scripts/fixtures/private-checkout-site.ts"]
}
JSON
pnpm --filter nanocodex-managed-service exec tsc --noEmit \
  --project .harness/tsconfig.private-checkout.json
node --check js/managed/scripts/private-checkout-smoke.mjs
```

Stop the local harness and remove the temporary website after the run:

```sh
pnpm --filter nanocodex-managed-service exec wrangler delete \
  --name YOUR_TEMPORARY_FIXTURE_NAME
```
