# Connect modal browser journey

Run from the repository root after installing dependencies and Playwright Chromium:

```sh
pnpm --filter nanocodex-connect-protocol run build
pnpm --filter nanocodex-connect-ui run build
pnpm --filter @nanocodex/connect-dialog run test:browser
```

The Vite fixture imports the built public `ConnectOnboarding` component and the shared stylesheet. It uses a synthetic request and host response callback. Only the account/SMS and external provider service transport is replaced by local HTTP endpoints; no SMS, account creation, or external authorization occurs. The `modal.nanocodex.localhost` hostname exercises the managed SMS flow instead of the loopback-only WebAuthn path. Playwright supplies its host resolution rule.

The journeys cover invalid phone input, a delivery failure and recovery, malformed and rejected codes, changing the number, successful sign-in, explicit consent, consent cancellation, initial cancellation, and Escape. Light/dark desktop, mobile, and short viewports assert edge-to-edge full-page geometry, no horizontal overflow, input/button keyboard focus, and consent heading focus with reset scroll position. Synthetic HTTP requests, host receipts, screenshots, and traces are written to the ignored repository `output/connect-full-page/` directory.

This verifies the real React rendering and user flow. It does not test the external SMS provider, production account backend, or the SDK iframe transport. A separate journey opens the real SDK popup and verifies the centered two-column desktop authorization layout.

Four connection-list journeys also cover grouped GitHub/Google rows, the approval gate for missing connections, keyboard focus visibility, and cancellation.

The connection journeys continue through a synthetic Google provider popup, the real origin/source-validated completion message, connector refresh, and explicit Allow access. They capture requested access, waiting for Google, and approval ready on desktop/mobile in both themes. Cancellation and a Gmail-only partial grant keep approval disabled; connecting Calendar still requires explicit final app approval. The provider fixture is clearly labeled local test content, not a reproduction of Google’s consent page.

Appearance journeys verify developer color scheme, accent contrast, font family,
and corner radius across sign-in and approval on desktop/mobile. An SDK popup
journey exercises the URL transport through the hosted parser into the real UI.
Malformed CSS-bearing values fall back to native defaults.
