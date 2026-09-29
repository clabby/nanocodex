# Local Kitesurf smoke

From `js/managed`, with Node 22, dependencies installed, and Wrangler authenticated with Browser Run access:

```sh
corepack pnpm exec wrangler dev --config scripts/wrangler.kitesurf-smoke.jsonc --ip 127.0.0.1 --port 8793
```

In another terminal:

```sh
curl --fail-with-body --max-time 100 -X POST http://127.0.0.1:8793/smoke
```

The local Durable Object uses the real remote `BROWSER` binding, local `LOADER`, and `createManagedBrowserRuntime`. It asserts completed CDP navigation to example.com, the Example Domain title and HTML, and rejection of Runtime.evaluate. With host Vault resolvers configured, it also asserts that only browser_execute is exposed and secure input is rejected before any login lookup. The response contains only the bounded evidence fields. Browser connections close in `finally`. Stop Wrangler with Ctrl-C afterward. This config is for ephemeral local development; do not deploy it.
