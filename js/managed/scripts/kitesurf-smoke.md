# Local hosted browser smoke

From `js/managed`, with Node 24, dependencies installed, and Wrangler authenticated with Browser Run access:

```sh
corepack pnpm exec wrangler dev --config scripts/wrangler.chromium-smoke.jsonc --ip 127.0.0.1 --port 8793
```

In another terminal:

```sh
curl --fail-with-body --max-time 100 -X POST http://127.0.0.1:8793/smoke
```

The default smoke leaves `MANAGED_BROWSER_PROVIDER` unset to verify the runtime
default selects Chromium. To exercise the explicit Kitesurf provider, use the
same fixture with its separate ephemeral configuration:

```sh
corepack pnpm exec wrangler dev --config scripts/wrangler.kitesurf-smoke.jsonc --ip 127.0.0.1 --port 8793
```

The local Durable Object uses the real remote `BROWSER` binding, local `LOADER`, and the upstream Agents browser runtime through `createManagedBrowserRuntime`. Each provider receives the original BROWSER binding and the upstream tool schema, description, CDP commands and results without custom filtering or sanitization. The smoke asserts upstream CDP schema discovery and completed CDP navigation to example.com and the Example Domain title and HTML. With host Vault resolvers configured, it also asserts that only browser_execute is exposed and secure input is rejected before any login lookup. The Chromium run additionally opens the public Stripe checkout demo, attaches to its actual cross-origin `js.stripe.com` iframe, and asserts that `Runtime.evaluate` of `1+1` returns `2` and the frame origin is `https://js.stripe.com`. It does not enter payment data or submit a payment. This check depends on the public demo being available. The response contains only the bounded evidence fields. Browser connections close in `finally`. Stop Wrangler with Ctrl-C afterward. This config is for ephemeral local development; do not deploy it.
