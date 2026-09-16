import assert from "node:assert/strict";
import test from "node:test";
import { managedAccessFetch, withManagedAccess } from "../managed/Access.mjs";

const token = "ncx_access_v1.fixture.signature";
function issued(ttl = "120000") { return Response.json({}, { headers: { "x-nanocodex-access": token, "x-nanocodex-access-ttl-ms": ttl } }); }
const init = { headers: { authorization: "Bearer fixture" } };
test("an unmarked 401 never replays a mutation", async () => {
  let calls = 0;
  const wrapped = managedAccessFetch(async () => ++calls === 1 ? issued() : new Response(null, { status: 401 }), "https://managed.test");
  await wrapped("https://managed.test/v1/agents", init);
  const response = await wrapped("https://managed.test/v1/agents", { ...init, method: "POST", body: "{}" });
  assert.equal(response.status, 401);
  assert.equal(calls, 2);
});
test("managed authority is shared across handles and retries rejection with the same operation", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push(options);
    return calls.length === 1 ? issued() : calls.length === 2 ? new Response(null, { status: 401, headers: { "x-nanocodex-access-rejected": "1" } }) : Response.json({});
  };
  const first = managedAccessFetch(fetch, "https://managed.test", "first-key");
  const second = managedAccessFetch(fetch, "https://managed.test", "first-key");
  await first("https://managed.test/v1/agents", init);
  await second("https://managed.test/v1/agents/a/turns", { ...init, method: "POST", body: '{"input":"hello"}', headers: { ...init.headers, "idempotency-key": "operation" } });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].headers.get("x-nanocodex-access"), token);
  assert.equal(calls[2].headers.get("x-nanocodex-access"), null);
  assert.equal(calls[1].body, calls[2].body);
  assert.equal(calls[2].headers.get("idempotency-key"), "operation");
});
test("tokens are isolated by key/origin and omitted on streams and privileged routes", async () => {
  const calls = [];
  const fetch = async (url, options) => { calls.push(options); return calls.length === 1 ? issued() : Response.json({}); };
  const first = managedAccessFetch(fetch, "https://managed.test", "first-key");
  await first("https://managed.test/v1/agents", init);
  await managedAccessFetch(fetch, "https://managed.test", "second-key")("https://managed.test/v1/agents", init);
  await first("https://managed.test/v1/agents/a/events", init);
  await first("https://managed.test/v1/agents/a/tool-host", init);
  await first("https://managed.test/v1/api-keys", init);
  await first("https://other.test/v1/agents", init);
  for (const call of calls) assert.equal(call.headers.get("x-nanocodex-access"), null);
});
test("nearly expired grants are renewed through ordinary live authentication", async () => {
  const calls = [];
  const fetch = async (url, options) => { calls.push(options); return issued("1000"); };
  const wrapped = managedAccessFetch(fetch, "https://managed.test");
  await wrapped("https://managed.test/v1/agents", init);
  await wrapped("https://managed.test/v1/agents", init);
  assert.equal(calls[1].headers.get("x-nanocodex-access"), null);
});

test("Connect preserves a streamed request body on retry and isolates grant restrictions", async () => {
  const calls = [];
  const wrapped = withManagedAccess(async request => {
    calls.push({ headers: new Headers(request.headers), body: await request.text() });
    return calls.length === 1 ? issued() : calls.length === 2 ? new Response(null, { status: 401, headers: { "x-nanocodex-access-rejected": "1" } }) : Response.json({});
  });
  const headers = { "x-nanocodex-connect-user": "user", "x-nanocodex-connect-grant-id": "grant-one", "x-nanocodex-connect-connectors": '["chatgpt"]' };
  await wrapped(new Request("https://nanocodex.internal/v1/agents", { method: "POST", headers }));
  await wrapped(new Request("https://nanocodex.internal/v1/agents/a/turns", { method: "POST", headers, body: '{"input":"hello"}' }));
  assert.equal(calls.length, 3);
  assert.equal(calls[1].headers.get("x-nanocodex-access"), token);
  assert.equal(calls[2].headers.get("x-nanocodex-access"), null);
  assert.equal(calls[1].body, calls[2].body);
  await wrapped(new Request("https://nanocodex.internal/v1/agents", { headers: { ...headers, "x-nanocodex-connect-grant-id": "grant-two" } }));
  assert.equal(calls[3].headers.get("x-nanocodex-access"), null);
});
