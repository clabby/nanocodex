import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { connect as connectNet } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import test, { before, after } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startRelay } from "./relay.mjs";

let directory, cert, key;
before(() => {
  directory = mkdtempSync(join(tmpdir(), "nanocodex-relay-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
  key = readFileSync(join(directory, "key.pem"));
  cert = readFileSync(join(directory, "cert.pem"));
});
after(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
const relayId = "22222222-2222-4222-8222-222222222222";
const parentId = "11111111-1111-4111-8111-111111111111";
const headers = {
  authorization: "Bearer synthetic-private-access-marker", "chatgpt-account-id": "synthetic-private-account-marker",
  "x-nanocodex-relay-id": relayId, "x-nanocodex-egress-request-id": parentId,
  "x-private": "synthetic-private-header-marker",
};

async function fixture(t, raw = false) {
  // Trust only this ephemeral fixture certificate at the connect boundary. The
  // production relay still performs a real authenticated TLS handshake.
  const connect = tls.connect;
  t.mock.method(tls, "connect", (options) => connect({ ...options, ca: cert }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const upstream = raw ? tls.createServer({ cert, key }) : createHttpsServer({ cert, key });
  const sockets = new Set();
  upstream.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const relay = startRelay({ host: "127.0.0.1", port: 0, upstreamOrigin: `https://localhost:${upstream.address().port}` });
  await once(relay, "listening");
  relay.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  t.after(() => { for (const socket of sockets) socket.destroy(); relay.close(); upstream.close(); });
  return { upstream, url: `ws://127.0.0.1:${relay.address().port}/backend-api/codex/responses` };
}

function assertSafe(records) {
  const allowed = new Set(["type", "transport", "outcome", "relay_id", "egress_request_id", "status", "socket_reused", "dns_observed",
    "process_age_ms", "duration_ms", "socket_setup_ms", "dns_lookup_ms", "tcp_connect_ms", "tls_handshake_ms",
    "upgrade_send_ms", "upstream_first_byte_ms", "upstream_upgrade_ms", "header_read_ms", "downstream_bytes",
    "downstream_chunks", "upstream_bytes", "upstream_chunks", "first_downstream_data_ms", "first_upstream_data_ms",
    "last_downstream_data_age_ms", "last_upstream_data_age_ms"]);
  const outcomes = new Set(["upgraded", "upstream_rejected", "upstream_error", "first_downstream_data",
    "first_upstream_data", "upstream_closed", "downstream_closed", "downstream_error"]);
  for (const record of records) {
    assert.ok(["responses.relay.upstream", "responses.relay.stream"].includes(record.type));
    assert.ok(outcomes.has(record.outcome));
    for (const [name, value] of Object.entries(record)) {
      assert.ok(allowed.has(name), `unexpected telemetry field ${name}`);
      if (name.endsWith("_ms")) assert.ok(Number.isFinite(value) && value >= 0, name);
      if (name.endsWith("_bytes") || name.endsWith("_chunks")) assert.ok(Number.isSafeInteger(value) && value >= 0, name);
    }
  }
  assert.doesNotMatch(JSON.stringify(records), /synthetic-private-|127\.0\.0\.1|localhost/);
}

for (const brokenLogger of [false, true]) test(`real TLS delayed WebSocket stream preserves frames and bounded lifecycle logs (throwing logger: ${brokenLogger})`, { timeout: 10_000 }, async (t) => {
  const records = [];
  const f = await fixture(t);
  let finalized;
  const finalRecord = new Promise((resolve) => { finalized = resolve; });
  t.mock.method(console, "info", (record) => {
    const parsed = JSON.parse(record);
    records.push(parsed);
    if (parsed.type === "responses.relay.stream" && !parsed.outcome.startsWith("first_")) finalized(parsed);
    if (brokenLogger) throw new Error("synthetic-private-logger-marker");
  });
  const wss = new WebSocketServer({ noServer: true });
  t.after(() => wss.close());
  let observed, provider, uploaded;
  const uploadReceived = new Promise((resolve) => { uploaded = resolve; });
  f.upstream.on("upgrade", (incoming, socket, head) => {
    observed = incoming.headers;
    wss.handleUpgrade(incoming, socket, head, (ws) => {
      provider = ws;
      ws.on("message", (data) => uploaded(data.toString()));
    });
  });
  const client = new WebSocket(f.url, { headers });
  t.after(() => client.terminate());
  await once(client, "open");
  const prompt = "synthetic-private-prompt-marker";
  const response = "synthetic-private-response-marker";
  client.send(prompt);
  assert.equal(await uploadReceived, prompt);
  await delay(100);
  assert.equal(client.readyState, WebSocket.OPEN, "silent provider wait must leave the stream open");
  assert.deepEqual(records.map(({ outcome }) => outcome), ["upgraded", "first_downstream_data"], "idle sockets emit no periodic records");
  for (let i = 0; i < 2; i++) {
    const received = once(client, "message");
    provider.send(response);
    assert.equal((await received)[0].toString(), response);
  }
  assert.equal(observed.authorization, headers.authorization);
  assert.equal(observed["chatgpt-account-id"], headers["chatgpt-account-id"]);
  for (const name of ["x-nanocodex-relay-id", "x-nanocodex-egress-request-id", "x-private"]) assert.equal(observed[name], undefined);
  const reason = "synthetic-private-close-marker";
  const closed = once(client, "close"); provider.close(1000, reason);
  const [code, closeReason] = await closed;
  assert.equal(code, 1000); assert.equal(closeReason.toString(), reason);
  const summary = await finalRecord;
  await delay(30);
  assert.equal(records.length, 4, "one handshake, two first-data records, and one terminal record");
  assert.equal(records.filter(({ outcome }) => outcome === "first_upstream_data").length, 1);
  assert.equal(records.filter(({ outcome }) => outcome === "first_downstream_data").length, 1);
  assert.ok(["upstream_closed", "downstream_closed"].includes(summary.outcome));
  assert.equal(summary.downstream_bytes, 6 + Buffer.byteLength(prompt) + 8 + Buffer.byteLength(reason));
  assert.equal(summary.upstream_bytes, 2 * (2 + Buffer.byteLength(response)) + 4 + Buffer.byteLength(reason));
  assert.ok(summary.downstream_chunks >= 2); assert.ok(summary.upstream_chunks >= 2);
  assert.ok(summary.first_upstream_data_ms - summary.first_downstream_data_ms >= 90, "stream timings expose the delayed provider bytes");
  assert.ok(summary.duration_ms >= summary.first_upstream_data_ms);
  assert.ok(Number.isFinite(summary.last_downstream_data_age_ms));
  assert.ok(Number.isFinite(summary.last_upstream_data_age_ms));
  assert.equal(records[0].outcome, "upgraded"); assert.equal(records[0].status, 101);
  assert.equal(records[0].relay_id, relayId); assert.equal(records[0].socket_reused, false);
  for (const record of records) {
    assert.equal(record.relay_id, relayId); assert.equal(record.egress_request_id, parentId);
  }
  for (const name of ["socket_setup_ms", "tcp_connect_ms", "tls_handshake_ms", "upstream_first_byte_ms", "upstream_upgrade_ms", "header_read_ms"]) {
    assert.ok(Number.isFinite(records[0][name]), name);
  }
  assertSafe(records);
  t.diagnostic(`safe relay lifecycle: ${JSON.stringify(records)}`);
});

test("real TLS upgrade counts coalesced WebSocket bytes and client head before a downstream reset", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, true);
  const records = [];
  let finalized;
  const finalRecord = new Promise((resolve) => { finalized = resolve; });
  t.mock.method(console, "info", (record) => {
    const parsed = JSON.parse(record);
    records.push(parsed);
    if (parsed.type === "responses.relay.stream" && !parsed.outcome.startsWith("first_")) finalized(parsed);
  });
  // Real text frames: a masked client frame and an unmasked provider frame.
  const clientFrame = Buffer.from([0x81, 0x83, 0, 0, 0, 0, 0x61, 0x62, 0x63]);
  const providerFrame = Buffer.from([0x81, 3, 0x78, 0x79, 0x7a]);
  const upgrade = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
    + "X-Request-Id: synthetic-private-upstream-header-marker\r\n\r\n");
  let uploaded;
  const uploadReceived = new Promise((resolve) => { uploaded = resolve; });
  f.upstream.on("secureConnection", (socket) => {
    let incoming = Buffer.alloc(0), upgraded = false;
    socket.on("data", (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);
      if (!upgraded) {
        const end = incoming.indexOf("\r\n\r\n");
        if (end === -1) return;
        assert.doesNotMatch(incoming.subarray(0, end).toString(), /x-nanocodex-|x-private:/i);
        incoming = incoming.subarray(end + 4);
        upgraded = true;
        socket.write(Buffer.concat([upgrade, providerFrame]));
      }
      if (incoming.byteLength >= clientFrame.byteLength) uploaded(incoming);
    });
  });
  const target = new URL(f.url);
  const client = connectNet({ host: target.hostname, port: Number(target.port) });
  t.after(() => client.destroy());
  await once(client, "connect");
  let received = Buffer.alloc(0), downloaded;
  const downloadReceived = new Promise((resolve) => { downloaded = resolve; });
  client.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
    if (received.byteLength >= upgrade.byteLength + providerFrame.byteLength) downloaded(received);
  });
  const lines = [`GET ${target.pathname} HTTP/1.1`, `Host: ${target.host}`, "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Key: c3ludGhldGljLWZpeHR1cmU=", "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", ""];
  client.write(Buffer.concat([Buffer.from(lines.join("\r\n")), clientFrame]));
  assert.deepEqual(await uploadReceived, clientFrame, "client head reaches the provider unchanged");
  assert.deepEqual(await downloadReceived, Buffer.concat([upgrade, providerFrame]), "coalesced provider frame reaches the client unchanged");
  client.resetAndDestroy();
  const summary = await finalRecord;
  await delay(30);
  assert.equal(records.length, 4);
  assert.equal(summary.outcome, "downstream_error");
  assert.equal(summary.downstream_bytes, clientFrame.byteLength);
  assert.equal(summary.upstream_bytes, providerFrame.byteLength);
  assert.equal(summary.downstream_chunks, 1);
  assert.equal(summary.upstream_chunks, 1);
  for (const record of records) {
    assert.equal(record.relay_id, relayId); assert.equal(record.egress_request_id, parentId);
  }
  assertSafe(records);
  t.diagnostic(`safe coalesced/reset lifecycle: ${JSON.stringify(records)}`);
});

test("real TLS fragmented rejection preserves provider bytes and omits invalid correlation", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, true);
  const records = [];
  t.mock.method(console, "info", (record) => records.push(JSON.parse(record)));
  const body = "synthetic-private-provider-body-marker";
  f.upstream.on("secureConnection", (socket) => {
    let requestBytes = "";
    socket.on("data", (chunk) => {
      requestBytes += chunk.toString();
      if (!requestBytes.includes("\r\n\r\n")) return;
      socket.removeAllListeners("data");
      assert.doesNotMatch(requestBytes, /x-nanocodex-|x-private:/i);
      socket.write("HTTP/1.1 403 Forbidden\r\nX-Request-Id: synthetic-private-response-marker\r\n");
      setImmediate(() => socket.end(`Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
    });
  });
  const outgoing = request(f.url.replace("ws:", "http:"), { headers: { ...headers,
    "x-nanocodex-relay-id": "synthetic-private-invalid-id-marker",
    "x-nanocodex-egress-request-id": "synthetic-private-invalid-parent-marker", upgrade: "websocket", connection: "Upgrade",
    "sec-websocket-key": "c3ludGhldGljLWZpeHR1cmU=", "sec-websocket-version": "13",
  } });
  outgoing.end();
  const [response] = await once(outgoing, "response");
  let received = ""; for await (const chunk of response) received += chunk;
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers["x-request-id"], "synthetic-private-response-marker");
  assert.equal(received, body);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "upstream_rejected"); assert.equal(records[0].status, 403);
  assert.equal(records[0].relay_id, undefined);
  assert.equal(records[0].egress_request_id, undefined);
  assertSafe(records);
  t.diagnostic(`safe rejection record: ${JSON.stringify(records)}`);
});

test("real TLS failure logs one fixed outcome without the exception or request markers", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, true);
  const records = [];
  t.mock.method(console, "info", (record) => records.push(JSON.parse(record)));
  f.upstream.on("connection", (socket) => socket.destroy());
  const outgoing = request(f.url.replace("ws:", "http:"), { headers: { ...headers,
    upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "c3ludGhldGljLWZpeHR1cmU=",
  } });
  outgoing.end();
  const [response] = await once(outgoing, "response");
  response.resume(); await once(response, "end");
  assert.equal(response.statusCode, 502);
  assert.equal(records.length, 1); assert.equal(records[0].outcome, "upstream_error");
  assertSafe(records);
  t.diagnostic(`safe TLS failure record: ${JSON.stringify(records)}`);
});
