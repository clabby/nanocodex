import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const appOrigin = "https://nanocodex-connect-playground.gakonst.workers.dev";
const accountAddress = `0x${"1".repeat(40)}`;
const grantId = `0x${"2".repeat(64)}`;
const grantToken = "t".repeat(43);
const alpha = "a".repeat(43);
const bravo = "b".repeat(43);
const later = "c".repeat(43);

test("Worker connector execution fences and forwards the exact approved identity", async (t) => {
  const outdir = await mkdtemp(path.join(os.tmpdir(), "nanocodex-connector-worker-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await execFileAsync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "deploy", "--dry-run", "--config", "./wrangler.jsonc", "--outdir", outdir],
    { cwd: new URL("..", import.meta.url) },
  );
  const worker = (await import(new URL(`file://${path.join(outdir, "index.js")}`))).default;
  let grant = activeGrant({ gmail: [alpha, bravo] });
  const forwarded = [];
  let reply = () => new Response("ok", { status: 200 });
  const env = {
    CONNECT_STATE: {
      idFromName: (name) => name,
      get: () => ({ fetch: async input => Response.json(new URL(input).searchParams.get("token") === grantToken ? {
        principal: { accountAddress, appId: "atlas-workspace", appOrigin, grantId },
        grant,
      } : {}) }),
    },
    EGRESS: { fetch: async (request) => {
      forwarded.push(request);
      return reply();
    } },
  };
  const context = { waitUntil() {} };

  const accepted = await worker.fetch(egressRequest(bravo), env, context);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].headers.get("x-nanocodex-connector-connection"), bravo);
  assert.equal(forwarded[0].headers.get("x-nanocodex-connector-instance"), null);
  assert.equal(forwarded[0].headers.get("authorization"), "Bearer NANOCODEX_PROVIDER_CREDENTIAL");
  assert.notEqual(forwarded[0].headers.get("authorization"), `Bearer ${grantToken}`);

  const denied = await worker.fetch(egressRequest(later), env, context);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "connector_connection_not_granted");
  assert.equal(forwarded.length, 1);

  grant = activeGrant(undefined);
  const legacy = await worker.fetch(egressRequest(), env, context);
  assert.equal(legacy.status, 200);
  assert.equal(forwarded.at(-1).headers.get("x-nanocodex-connector-connection"), null);
  const legacyExpansion = await worker.fetch(egressRequest(alpha), env, context);
  assert.equal(legacyExpansion.status, 403);
  assert.equal((await legacyExpansion.json()).error.code, "connector_connection_not_granted");

  for (const [provider, url] of [
    ["spotify", "https://api.spotify.com/v1/me/playlists"],
    ["soundcloud", "https://api.soundcloud.com/playlists"],
  ]) {
    grant = { ...activeGrant({ [provider]: [alpha] }), capabilities: [provider] };
    const body = JSON.stringify({ title: "Music playlist" });
    const response = await worker.fetch(egressRequest(alpha, {
      url, method: "POST", headers: { "content-type": "application/json" },
      body_base64: Buffer.from(body).toString("base64"),
    }), env, context);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).url, url);
    assert.equal(forwarded.at(-1).headers.get("x-nanocodex-connector-connection"), alpha);
    assert.equal(await forwarded.at(-1).text(), body);
    const count = forwarded.length;
    assert.equal((await worker.fetch(egressRequest(bravo, { url }), env, context)).status, 403);
    grant = { ...grant, capabilities: [] };
    assert.equal((await worker.fetch(egressRequest(alpha, { url }), env, context)).status, 403);
    assert.equal(forwarded.length, count);
  }

  // Apps call the same grant-bound broker without fabricating an agent/thread.
  for (const [connector, path] of [["spotify", "/v1/me/playlists?limit=1"], ["soundcloud", "/me/playlists?limit=1"]]) {
    grant = { ...activeGrant({ [connector]: [alpha] }), capabilities: [connector] };
    reply = () => Response.json({ items: [{ id: "playlist" }] }, { headers: { link: '<https://api.spotify.com/v1/me/playlists?offset=1>; rel="next"' } });
    const read = await worker.fetch(connectorRequest(connector, { path }), env, context);
    assert.equal(read.status, 200);
    assert.match(read.headers.get("link"), /rel="next"/);
    assert(read.headers.get("access-control-expose-headers").split(", ").includes("link"));
    assert.deepEqual(await read.json(), { items: [{ id: "playlist" }] });
    assert.equal(forwarded.at(-1).headers.get("x-nanocodex-connector-connection"), alpha);
    assert.equal(forwarded.at(-1).method, "GET");
    const count = forwarded.length;
    for (const fields of [{ connection_id: bravo }, { path: "//evil.example/steal" },
      { headers: { authorization: "Bearer stolen" } }, { user_id: "other" },
      { body: { invalid: "GET body" } }, { method: 123 }]) {
      const denied = await worker.fetch(connectorRequest(connector, { path, ...fields }), env, context);
      assert(denied.status >= 400);
    }
    for (const headers of [{ origin: "https://evil.example" }, { "x-nanocodex-app-id": "other-app" }, { authorization: "Bearer invalid" }]) {
      assert((await worker.fetch(connectorRequest(connector, { path }, headers), env, context)).status >= 400);
    }
    for (const change of [{ status: "revoked" }, { expiresAt: 1 }, { capabilities: [] }, { connectorConnections: { [connector]: [] } }]) {
      const prior = grant; grant = { ...grant, ...change };
      assert((await worker.fetch(connectorRequest(connector, { path }), env, context)).status >= 400);
      grant = prior;
    }
    assert.equal(forwarded.length, count);
    reply = () => new Response(null, { status: 429, headers: { "retry-after": "5" } });
    const limited = await worker.fetch(connectorRequest(connector, { path }), env, context);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "5");
    assert.equal(forwarded.length, count + 1, "does not retry provider failures");
    reply = () => new Response(null, { status: 204 });
    const body = { name: "Updated playlist" };
    const write = await worker.fetch(connectorRequest(connector, {
      path: connector === "spotify" ? "/v1/playlists/fixture" : "/playlists/fixture",
      method: "PUT", body,
    }), env, context);
    assert.equal(write.status, 204);
    assert.deepEqual(await forwarded.at(-1).json(), body);
  }

  // Every API capability uses the same grant boundary, including Google services.
  for (const [connector, path, upstream, scheme = "Bearer"] of [
    ["github", "/user", "https://api.github.com", "token"],
    ["gmail", "/gmail/v1/users/me/messages", "https://gmail.googleapis.com"],
    ["gdrive", "/drive/v3/files", "https://www.googleapis.com"],
    ["gcalendar", "/calendar/v3/calendars/primary/events", "https://www.googleapis.com"],
    ["gtasks", "/tasks/v1/users/@me/lists", "https://tasks.googleapis.com"],
    ["gdocs", "/v1/documents/fixture", "https://docs.googleapis.com"],
    ["gsheets", "/v4/spreadsheets/fixture", "https://sheets.googleapis.com"],
    ["gslides", "/v1/presentations/fixture", "https://slides.googleapis.com"],
    ["gcontacts", "/v1/people/me/connections", "https://people.googleapis.com"],
    ["slack", "/api/auth.test", "https://slack.com"],
    ["x", "/2/users/me", "https://api.x.com"],
    ["spotify", "/v1/me/playlists", "https://api.spotify.com"],
    ["soundcloud", "/me/playlists", "https://api.soundcloud.com", "OAuth"],
  ]) {
    grant = { ...activeGrant({ [connector]: [alpha] }), capabilities: [connector] };
    const request = () => new Request(`https://nanocodex.gakonst.workers.dev/connectors/${connector}${path}`, {
      headers: { authorization: `${scheme} ${grantToken}` },
    });
    reply = () => Response.json({ fixture: true });
    const response = await worker.fetch(request(), env, context);
    assert.equal(response.status, 200, `${connector}: ${await response.text()}`);
    assert.equal(forwarded.at(-1).url, upstream + path);
    assert.equal(forwarded.at(-1).headers.get("authorization"), "Bearer NANOCODEX_PROVIDER_CREDENTIAL");
    assert.equal(forwarded.at(-1).headers.get("x-nanocodex-connector-connection"), alpha);
    const count = forwarded.length;
    grant = { ...grant, capabilities: [] };
    assert.equal((await worker.fetch(request(), env, context)).status, 403, connector);
    assert.equal(forwarded.length, count);
    if (scheme !== "Bearer") {
      assert.equal((await worker.fetch(connectorRequest(connector, { path }, {
        authorization: `${scheme} ${grantToken}`,
      }), env, context)).status, 401, "scheme aliases apply only to SDK routes");
    }
  }

  for (const [connector, path, upstream] of [
    ["spotify", "/v1/me/playlists", "https://api.spotify.com"],
    ["soundcloud", "/me/playlists", "https://api.soundcloud.com"],
  ]) {
    grant = { ...activeGrant({ [connector]: [alpha] }), capabilities: [connector] };
    const base = `https://nanocodex.gakonst.workers.dev/connectors/${connector}`;
    const native = (suffix = "?limit=1", init = {}) => new Request(base + path + suffix, {
      ...init, headers: { authorization: `Bearer ${grantToken}`, ...init.headers },
    });
    reply = () => Response.json({ next: upstream + path + "?offset=1", items: [
      { href: upstream + "/tracks/1", artwork_url: "https://images.example/art.jpg" },
    ] }, { headers: { link: `<${upstream}${path}?offset=1>; rel="next"` } });
    const read = await worker.fetch(native(), env, context);
    assert.equal(read.status, 200, await read.clone().text());
    assert.equal(forwarded.at(-1).url, upstream + path + "?limit=1");
    assert.equal(forwarded.at(-1).headers.get("authorization"), "Bearer NANOCODEX_PROVIDER_CREDENTIAL");
    assert.equal(forwarded.at(-1).headers.get("x-nanocodex-connector-connection"), alpha);
    assert.equal(forwarded.at(-1).headers.get("origin"), null);
    assert.equal(read.headers.get("link"), `<${base}${path}?offset=1>; rel="next"`);
    const page = await read.json();
    assert.equal(page.next, base + path + "?offset=1");
    assert.equal(page.items[0].href, base + "/tracks/1");
    assert.equal(page.items[0].artwork_url, "https://images.example/art.jpg");
    assert.equal((await worker.fetch(new Request(page.next, { headers: { authorization: `Bearer ${grantToken}` } }), env, context)).status, 200);
    assert.equal(forwarded.at(-1).url, upstream + path + "?offset=1");
    const before = forwarded.length;
    assert.equal((await worker.fetch(native("", { headers: { authorization: `Bearer ${"z".repeat(43)}` } }), env, context)).status, 401);
    for (const headers of [{ "x-nanocodex-connector-connection": bravo }, { origin: "https://evil.example" }, { "x-nanocodex-app-id": "wrong-app" }, { authorization: "Bearer invalid" }]) {
      assert((await worker.fetch(native("", { headers }), env, context)).status >= 400);
    }
    for (const change of [{ status: "revoked" }, { expiresAt: 1 }, { capabilities: [] }]) {
      const prior = grant; grant = { ...grant, ...change };
      assert((await worker.fetch(native(), env, context)).status >= 400);
      grant = prior;
    }
    assert.equal(forwarded.length, before);
    reply = () => new Response(null, { status: 204 });
    const payload = '{"name":"SDK write","nested":[1,2]}';
    assert.equal((await worker.fetch(native("", { method: "PUT", headers: { "content-type": "application/json" }, body: payload }), env, context)).status, 204);
    assert.equal(await forwarded.at(-1).text(), payload);
    assert.equal(forwarded.at(-1).headers.get("content-type"), "application/json");
    reply = () => new Response(`{"id":9007199254740993123,"next":"${upstream}${path}?offset=1"}`, { headers: { "content-type": "application/json" } });
    const exact = await (await worker.fetch(native(), env, context)).text();
    assert.match(exact, /9007199254740993123/, "large provider IDs retain their exact digits");
    assert.equal(JSON.parse(exact).next, base + path + "?offset=1");
    reply = () => new Response(null, { status: 302, headers: { location: upstream + path + "?offset=1" } });
    assert.equal((await worker.fetch(native(), env, context)).headers.get("location"), base + path + "?offset=1");
    reply = () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    assert.equal((await worker.fetch(native(), env, context)).status, 502);
  }

  grant = { ...activeGrant({ github: [alpha] }), capabilities: ["github"] };
  const bytes = Uint8Array.from({ length: 300 * 1024 }, (_, index) => index % 256);
  const largeSize = 17 * 1024 * 1024 + 123;
  reply = () => {
    let remaining = largeSize;
    return new Response(new ReadableStream({
      pull(controller) {
        if (!remaining) { controller.close(); return; }
        const size = Math.min(remaining, 64 * 1024);
        controller.enqueue(new Uint8Array(size).fill(255));
        remaining -= size;
      },
    }), { headers: { "content-type": "application/x-git-upload-pack-result" } });
  };
  const cloned = await worker.fetch(egressRequest(undefined, {
    url: "https://github.com/fixture/large.git/git-upload-pack",
    method: "POST",
    headers: { "content-type": "application/x-git-upload-pack-request", "git-protocol": "version=2" },
    body_base64: Buffer.from(bytes).toString("base64"),
  }), env, context);
  assert.equal(cloned.status, 200);
  const git = forwarded.at(-1);
  assert.equal(git.url, "https://github.com/fixture/large.git/git-upload-pack");
  assert.equal(git.headers.get("x-nanocodex-subject"), grant.egressSubject);
  assert.equal(git.headers.get("x-nanocodex-connector-connection"), alpha);
  assert.equal(git.headers.get("git-protocol"), "version=2");
  assert.deepEqual(new Uint8Array(await git.arrayBuffer()), bytes);
  const downloaded = new Uint8Array(await cloned.arrayBuffer());
  assert.equal(downloaded.byteLength, largeSize);
  assert(downloaded.every((byte) => byte === 255));

  reply = () => new Response("public");
  const publicResponse = await worker.fetch(egressRequest(undefined, {
    url: "https://example.com/archive", method: "POST", body_base64: "AP+A/g==",
  }), env, context);
  assert.equal(await publicResponse.text(), "public");
  const publicRequest = forwarded.at(-1);
  assert.equal(publicRequest.url, "https://public-egress.internal/v1/request");
  assert.equal(publicRequest.headers.get("x-nanocodex-target-url"), "https://example.com/archive");
  assert.equal(publicRequest.headers.get("x-nanocodex-subject"), grant.egressSubject);
  assert.equal(publicRequest.headers.get("authorization"), null);
  assert.deepEqual([...new Uint8Array(await publicRequest.arrayBuffer())], [0, 255, 128, 254]);

  const before = forwarded.length;
  const spoofed = await worker.fetch(egressRequest(undefined, {
    url: "https://example.com", headers: { "x-nanocodex-target-url": "https://api.github.com/user" },
  }), env, context);
  assert.equal(spoofed.status, 403);
  const outsideGrant = await worker.fetch(egressRequest(bravo, {
    url: "https://github.com/fixture/large.git/info/refs?service=git-upload-pack",
  }), env, context);
  assert.equal(outsideGrant.status, 403);
  assert.equal(forwarded.length, before);

});

function activeGrant(connectorConnections) {
  return {
    id: grantId,
    appId: "atlas-workspace",
    appOrigin,
    accountAddress,
    brokerUserId: accountAddress,
    agentId: "agent-1",
    permission: "agent.run",
    status: "active",
    expiresAt: Math.floor(Date.now() / 1_000) + 600,
    capabilities: ["gmail"],
    ...(connectorConnections === undefined ? {} : { connectorConnections }),
    spentAtomics: "0",
    egressSubject: "s".repeat(43),
    sharedEgressSubject: true,
  };
}

function egressRequest(connectionId, fields = {}) {
  return new Request("https://nanocodex-connect-api.gakonst.workers.dev/v1/egress", {
    method: "POST",
    headers: {
      authorization: `Bearer ${grantToken}`,
      "content-type": "application/json",
      origin: appOrigin,
      "x-nanocodex-app-id": "atlas-workspace",
    },
    body: JSON.stringify({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      thread_id: "123e4567-e89b-42d3-a456-426614174000",
      ...(connectionId === undefined ? {} : { connection_id: connectionId }),
      ...fields,
    }),
  });
}

function connectorRequest(connector, fields, headers = {}) {
  return new Request(`https://nanocodex-connect-api.gakonst.workers.dev/v1/connectors/${connector}/request`, {
    method: "POST",
    headers: { authorization: `Bearer ${grantToken}`, "content-type": "application/json",
      origin: appOrigin, "x-nanocodex-app-id": "atlas-workspace", ...headers },
    body: JSON.stringify(fields),
  });
}
