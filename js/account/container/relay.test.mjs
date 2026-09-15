import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import test from "node:test";

import { startRelay } from "./relay.mjs";

const path = "/backend-api/codex/realtime/calls";

async function fixture(t, handler) {
  const upstream = createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const relay = startRelay({
    host: "127.0.0.1",
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
  });
  await once(relay, "listening");
  t.after(() => {
    for (const server of [relay, upstream]) {
      server.closeAllConnections();
      server.close();
    }
  });
  return `http://127.0.0.1:${relay.address().port}${path}`;
}

function post(url) {
  const outgoing = request(url, {
    method: "POST",
    headers: { authorization: "Bearer fixture", "content-type": "application/json" },
  });
  // A cancelled client request emits ECONNRESET if no response arrived yet.
  outgoing.on("error", () => {});
  outgoing.end('{"sdp":"fixture"}');
  return outgoing;
}

for (const sendHeaders of [false, true]) {
  test(`disconnect after full call upload cancels upstream ${sendHeaders ? "body" : "header wait"}`, { timeout: 5_000 }, async (t) => {
    let uploaded;
    const bodyReceived = new Promise((resolve) => { uploaded = resolve; });
    let closed;
    const upstreamClosed = new Promise((resolve) => { closed = resolve; });
    const url = await fixture(t, (incoming, response) => {
      incoming.resume();
      incoming.on("end", () => {
        if (sendHeaders) {
          response.writeHead(201, { "content-type": "application/sdp" });
          response.write("partial answer");
        }
        uploaded();
      });
      response.once("close", closed);
    });
    const outgoing = post(url);
    const responseReady = sendHeaders ? once(outgoing, "response") : undefined;
    await bodyReceived;
    if (responseReady) await responseReady;
    const cancelledAt = performance.now();
    outgoing.destroy();
    const timeout = setTimeout(() => closed(false), 1_000);
    t.after(() => clearTimeout(timeout));
    assert.notEqual(await upstreamClosed, false, "relay left the provider request alive after client disconnect");
    t.diagnostic(`upstream cancellation ${Math.round(performance.now() - cancelledAt)}ms after client disconnect`);
  });
}

test("completed call preserves SDP, location, and the fully uploaded body", { timeout: 5_000 }, async (t) => {
  const url = await fixture(t, async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    assert.equal(body, '{"sdp":"fixture"}');
    response.writeHead(201, { "content-type": "application/sdp", location: "/calls/rtc_fixture" });
    response.end("answer SDP");
  });
  const outgoing = post(url);
  const [response] = await once(outgoing, "response");
  let body = "";
  for await (const chunk of response) body += chunk;
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers.location, "/calls/rtc_fixture");
  assert.equal(body, "answer SDP");
  const timing = JSON.parse(response.headers["x-nanocodex-relay-timing"]);
  for (const key of ["process_age_ms", "fetch_ms", "socket_wait_ms", "upload_ms", "response_wait_ms"]) {
    assert.ok(Number.isFinite(timing[key]) && timing[key] >= 0, `${key} must measure the request`);
  }
  assert.equal(timing.socket_reused, false);
  assert.deepEqual(Object.keys(timing).sort(), ["process_age_ms", "fetch_ms", "socket_wait_ms", "upload_ms", "response_wait_ms", "socket_reused"].sort());
});
