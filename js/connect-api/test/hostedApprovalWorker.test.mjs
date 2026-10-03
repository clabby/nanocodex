import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const appId = "djbooth";
const appOrigin = "https://djbooth-library.gakonst.workers.dev";
const accountAddress = `0x${"1".repeat(40)}`;
const agentId = "11111111-1111-4111-8111-111111111111";
const digest = `0x${"a".repeat(64)}`;
const sandboxResource = "urn:nanocodex:agent:execution:sandbox";
const resources = [
  sandboxResource,
  "urn:nanocodex:data:read",
  "urn:nanocodex:data:write",
  "urn:nanocodex:agent:run",
  `urn:nanocodex:app:${appId}`,
  `urn:nanocodex:origin:${encodeURIComponent(appOrigin)}`,
  "urn:nanocodex:authorization:hosted",
  "urn:nanocodex:connector:chatgpt",
  "urn:nanocodex:agent:visibility:reply,actions",
  `urn:nanocodex:app-tool-catalog:sha256:${digest.slice(2)}`,
];

test("generic hosted apps exchange non-spending approvals into bound agent grants", async (t) => {
  const outdir = await mkdtemp(path.join(os.tmpdir(), "nanocodex-hosted-worker-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await promisify(execFile)(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "deploy", "--dry-run", "--config", "./wrangler.jsonc", "--outdir", outdir],
    { cwd: new URL("..", import.meta.url) },
  );
  const { default: worker, ConnectNonceStorage } = await import(new URL(`file://${path.join(outdir, "index.js")}`));
  const entries = new Map();
  const storage = {
    get: async (key) => entries.get(key),
    put: async (key, value) => { entries.set(key, structuredClone(value)); },
    delete: async (key) => { entries.delete(key); },
    transaction: async (operation) => operation(storage),
  };
  const state = new ConnectNonceStorage({ storage });
  let exchanged = 0;
  let expectedSandbox = "true";
  let rejectAccount = false;
  const dataRequests = [];
  let dataReply = () => Response.json({ preserved: true });
  const env = {
    CONNECT_STATE: {
      idFromName: (name) => name,
      get: () => ({ fetch: (input, init) => state.fetch(new Request(input, init)) }),
    },
    ACCOUNTS: { fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/connect/hosted-authorizations/exchange") {
        exchanged++;
        const body = await request.json();
        if (rejectAccount) return new Response(null, { status: 403 });
        return Response.json({ linked: true, user_id: accountAddress, account_address: accountAddress, resources: body.resources });
      }
      if (url.pathname === "/v1/data") {
        dataRequests.push(request.clone());
        return dataReply();
      }
      assert.equal(request.headers.get("x-nanocodex-connect-sandbox-execution"), expectedSandbox);
      if (url.pathname === `/v1/agents/${agentId}/_connect-existence`) return new Response(null, { status: 204 });
      assert.equal(url.pathname, "/v1/agents");
      return Response.json({ agent_id: agentId });
    } },
    EGRESS: { fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/connectors")) return Response.json({ connectors: {} });
      if (url.pathname.endsWith("/credentials")) return Response.json({ chatgpt: { connected: true } });
      if (url.pathname.startsWith("/subjects/")) return new Response(null, { status: 204 });
      assert.fail(`Unexpected broker request: ${url.pathname}`);
    } },
  };
  const pending = [];
  const context = { waitUntil(promise) { pending.push(promise); } };
  const authorize = (approved = resources, fields = {}) => worker.fetch(new Request("https://connect.test/v1/hosted-authorizations", {
    method: "POST",
    headers: { origin: "https://nanocodex.gakonst.workers.dev", "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_origin: appOrigin, account_address: accountAddress, code: "c".repeat(43), resources: approved, ...fields }),
  }), env, context);
  const approvalResponse = await authorize();
  assert.equal(approvalResponse.status, 200, await approvalResponse.clone().text());
  const approval = await approvalResponse.json();
  assert.equal(exchanged, 1);
  assert.deepEqual(entries.get(`connect-approval:${approval.approval_id}`).value.resources, resources);
  const connect = (fields = {}, origin = appOrigin) => worker.fetch(new Request("https://connect.test/v1/connections", {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-nanocodex-app-id": appId },
    body: JSON.stringify({ app_id: appId, account_address: accountAddress, approval_id: approval.approval_id,
      authorization_mode: "hosted", permission: "agent.run", requested_connectors: ["chatgpt"],
      requested_app_tool_catalog_digest: digest, ...fields }),
  }), env, context);

  for (const [fields, origin, code] of [
    [{}, "https://other.example", "app_not_approved"],
    [{ requested_connectors: ["chatgpt", "spotify"] }, appOrigin, "connector_not_approved"],
    [{ requested_app_tool_catalog_digest: `0x${"b".repeat(64)}` }, appOrigin, "app_tool_catalog_mismatch"],
    [{ key_authorization: {} }, appOrigin, "hosted_authorization_denied"],
  ]) {
    const response = await connect(fields, origin);
    assert.equal(response.status, 403, await response.clone().text());
    assert.equal((await response.json()).error.code, code);
  }
  const connected = await connect();
  assert.equal(connected.status, 201, await connected.clone().text());
  const connection = await connected.json();
  const grants = [...entries].filter(([key]) => key.startsWith("grant:"));
  assert.equal(grants.length, 1);
  const grant = grants[0][1].value;
  assert.equal(grant.agentId, agentId);
  assert.equal(grant.appId, appId);
  assert.equal(grant.appOrigin, appOrigin);
  assert.equal(grant.accountAddress, accountAddress);
  assert.equal(grant.appToolCatalogDigest, digest);
  assert(grant.capabilities.includes("chatgpt"));
  assert(grant.capabilities.includes("agent.execution.sandbox"));
  assert(grant.capabilities.includes("data:read"));
  assert(grant.capabilities.includes("data:write"));
  assert(!grant.capabilities.includes("mpp.mach"));
  assert(!grant.capabilities.includes("mercator.boost"));
  assert.equal(grant.accessKey, undefined);
  assert.equal((await connect()).status, 403, "approval cannot be replayed");

  for (const [approved, fields, code] of [
    [resources.filter((r) => r !== "urn:nanocodex:agent:run"), {}, "capability_not_approved"],
    [resources, { app_id: "other-app" }, "app_identity_mismatch"],
    [resources, { app_origin: "https://other.example" }, "app_identity_mismatch"],
    [[...resources, "urn:nanocodex:mpp:machusd:spend"], {}, "hosted_authorization_denied"],
  ]) {
    const response = await authorize(approved, fields);
    assert.equal(response.status, 403, await response.clone().text());
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(exchanged, 1, "invalid approvals never reach the account exchange");
  expectedSandbox = null;
  const unscoped = await (await authorize(resources.filter(r => r !== sandboxResource && !r.startsWith("urn:nanocodex:data:")))).json();
  const forged = await connect({ approval_id: unscoped.approval_id, capabilities: ["agent.execution.sandbox", "data:read", "data:write"], sandboxExecution: true });
  assert.equal(forged.status, 400, "forged capability fields are rejected before grant creation");
  const unscopedConnected = await connect({ approval_id: unscoped.approval_id });
  assert.equal(unscopedConnected.status, 201, await unscopedConnected.clone().text());
  const unscopedGrant = [...entries].filter(([key]) => key.startsWith("grant:")).map(([, record]) => record.value).find(value => value.id !== grant.id);
  assert(unscopedGrant);
  assert(!unscopedGrant.capabilities.includes("agent.execution.sandbox"), "caller fields cannot elevate the approved resource set");
  assert(!unscopedGrant.capabilities.includes("data:read"));
  assert(!unscopedGrant.capabilities.includes("data:write"));
  const unscopedConnection = await unscopedConnected.json();
  const payloads = {
    document_get: { key: "notes/fixture" }, document_list: { prefix: "notes/", limit: 10 },
    document_put: { key: "notes/fixture", value: { text: "example" } }, document_delete: { key: "notes/fixture" },
    timeseries_list: { limit: 10 }, timeseries_query: { series: "steps", limit: 10 },
    timeseries_aggregate: { series: "steps", start_ms: 0, end_ms: 1000, bucket_ms: 100, aggregation: "sum" },
    timeseries_write: { series: "steps", points: [{ timestamp_ms: 100, value: 3 }] },
    object_get: { key: "objects/fixture" }, object_list: { limit: 10 }, object_delete: { key: "objects/fixture" },
    object_put: { key: "objects/fixture", content: "example", encoding: "utf8", content_type: "text/plain" },
  };
  const dataRequest = (operation, { token = connection.grant_token, headers = {}, verb = "POST", suffix = "", body = payloads[operation] ?? {} } = {}) => new Request(
    `https://connect.test/v1/data${suffix}`, {
      method: verb,
      headers: { authorization: `Bearer ${token}`, origin: appOrigin, "x-nanocodex-app-id": appId,
        "content-type": "application/json", ...headers },
      ...(verb === "POST" ? { body: JSON.stringify({ operation, ...body }) } : {}),
    });
  const data = (operation, options) => worker.fetch(dataRequest(operation, options), env, context);
  const reads = ["document_get", "document_list", "timeseries_list", "timeseries_query", "timeseries_aggregate", "object_get", "object_list"];
  const writes = ["document_put", "document_delete", "timeseries_write", "object_put", "object_delete"];
  for (const operation of [...reads, ...writes]) {
    const body = payloads[operation];
    const response = await data(operation, { body, headers: {
      cookie: "private-cookie=never-forward", "x-nanocodex-connect-user": "forged-owner",
      "x-nanocodex-user-id": "forged-owner", "x-nanocodex-connect-capabilities": '["*"]',
    } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { preserved: true });
    const forwarded = dataRequests.at(-1);
    assert.equal(forwarded.url, "https://nanocodex.internal/v1/data");
    assert.equal(forwarded.method, "POST");
    assert.deepEqual(await forwarded.json(), { operation, ...body });
    assert.equal(forwarded.headers.get("x-nanocodex-connect-user"), grant.brokerUserId);
    assert.equal(forwarded.headers.get("x-nanocodex-connect-grant-id"), grant.id);
    assert.equal(forwarded.headers.has("authorization"), false);
    assert.equal(forwarded.headers.has("cookie"), false);
    assert.equal(forwarded.headers.has("x-nanocodex-user-id"), false);
  }
  const grantRecord = entries.get(`grant:${grant.id}`);
  const replaceGrant = changes => entries.set(`grant:${grant.id}`, { ...grantRecord, value: { ...grant, ...changes } });
  for (const [allowed, denied, capability] of [[reads, writes, "data:read"], [writes, reads, "data:write"]]) {
    replaceGrant({ capabilities: [capability] });
    for (const operation of allowed) {
      assert.equal((await data(operation)).status, 200);
      assert.deepEqual(JSON.parse(dataRequests.at(-1).headers.get("x-nanocodex-connect-capabilities")),
        ["agents:read", "agents:write", "tools:use", capability]);
    }
    const count = dataRequests.length;
    for (const operation of denied) assert.equal((await data(operation)).status, 403);
    assert.equal(dataRequests.length, count, "read and write authority stay separate");
  }
  replaceGrant({});
  const count = dataRequests.length;
  for (const options of [
    { token: unscopedConnection.grant_token }, { token: "u".repeat(43) },
    { headers: { origin: "https://other.example" } }, { headers: { "x-nanocodex-app-id": "other" } },
  ]) assert.ok((await data("document_get", options)).status >= 400);
  assert.equal((await data("document_get", { verb: "GET" })).status, 405);
  assert.equal((await data("document_get", { suffix: "?user_id=other" })).status, 400);
  assert.equal((await data("raw_sql")).status, 400);
  assert.equal((await data("document_get", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } })).status, 413);
  const streamedOversize = new Request("https://connect.test/v1/data", {
    method: "POST", headers: dataRequest("document_get").headers,
    body: JSON.stringify({ operation: "document_put", key: "large", value: "x".repeat(2 * 1024 * 1024) }),
  });
  assert.equal((await worker.fetch(streamedOversize, env, context)).status, 413, "missing Content-Length cannot bypass the byte limit");
  for (const changes of [{ status: "revoked" }, { expiresAt: 1 }, { brokerUserId: "different-owner", accountAddress: `0x${"2".repeat(40)}` }]) {
    replaceGrant(changes);
    assert.ok((await data("document_get")).status >= 400);
  }
  replaceGrant({});
  assert.equal(dataRequests.length, count, "rejected calls never reach account storage");
  dataReply = () => new Response(null, { status: 302, headers: { location: "https://other.example" } });
  assert.equal((await data("document_get")).status, 502);
  dataReply = () => new Response("not JSON");
  assert.equal((await data("document_get")).status, 502);
  dataReply = () => new Response("invalid", { headers: { "content-type": "application/json" } });
  assert.equal((await data("document_get")).status, 502);
  dataReply = () => Response.json({ content: "\u0000".repeat(1024 * 1024) });
  assert.equal((await data("object_get")).status, 200, "JSON escaping of a valid 1 MiB object fits the response envelope");
  dataReply = () => Response.json({}, { headers: { "content-length": String(8 * 1024 * 1024 + 1) } });
  assert.equal((await data("object_get")).status, 502, "oversized upstream responses are bounded");
  dataReply = () => Response.json({ error: "revision_conflict" }, { status: 409, headers: { "set-cookie": "private=value" } });
  const conflict = await data("document_put");
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "revision_conflict" });
  assert.equal(conflict.headers.has("set-cookie"), false);
  t.diagnostic("Hosted approval -> scoped grant -> /v1/data: all 12 operations forwarded with authenticated owner; unsigned, cross-app, expired, revoked and mismatched-owner calls blocked; upstream redirects and malformed JSON rejected.");
  rejectAccount = true;
  assert.equal((await authorize()).status, 403, "account service still must approve the exact resources");
  await Promise.all(pending);
});
