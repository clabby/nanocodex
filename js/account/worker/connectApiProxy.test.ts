import assert from "node:assert/strict";
import test from "node:test";

import { isConnectApiRequest, routeConnectApi } from "./connectApiProxy.ts";

const state = `connect.${"s".repeat(43)}`;

test("production callback routing accepts unified Google and Slack providers", () => {
  for (const provider of ["github", "google", "gmail", "gdrive", "slack", "x", "spotify", "soundcloud"]) {
    const url = new URL(`https://nanocodex.test/v1/connectors/${provider}/callback?state=${state}`);
    assert.equal(isConnectApiRequest(new Request(url), url.pathname), true, provider);
  }
});

test("production callback routing rejects capability-only and unscoped callbacks", () => {
  for (const provider of ["gcalendar", "gtasks", "gdocs", "gsheets", "gslides", "gcontacts"]) {
    const url = new URL(`https://nanocodex.test/v1/connectors/${provider}/callback?state=${state}`);
    assert.equal(isConnectApiRequest(new Request(url), url.pathname), false, provider);
  }
  const unscoped = new URL("https://nanocodex.test/v1/connectors/google/callback?state=broker-state-only");
  assert.equal(isConnectApiRequest(new Request(unscoped), unscoped.pathname), false);
});


test("SDK base URLs reach Connect on the canonical app origin without onboarding headers", async () => {
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const url = new URL("https://nanocodex.test/connectors/spotify/v1/me/playlists?limit=1");
    const request = new Request(url, { method, headers: { authorization: "Bearer grant" },
      ...(["POST", "PUT", "PATCH"].includes(method) ? { body: '{"name":"playlist"}' } : {}) });
    assert.equal(isConnectApiRequest(request, url.pathname), true);
    const response = await routeConnectApi(request, { NANOCODEX_CONNECT_API: { async fetch(upstream) {
      assert.equal(upstream.url, request.url);
      assert.equal(upstream.method, method);
      assert.equal(upstream.headers.get("authorization"), "Bearer grant");
      if (request.body) assert.equal(await upstream.text(), '{"name":"playlist"}');
      return new Response(null, { status: 204 });
    } } }, url);
    assert.equal(response?.status, 204);
  }
});
