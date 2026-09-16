import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { describeDeviceHand, connectDeviceHand } from "../src/device-hand.mjs";

const binary = process.env.NANOCODEX_DEVICE_TEST_BINARY;
test("real CLI and desktop leases share one authenticated host across account keys", { skip: !binary, timeout: 45_000 }, async t => {
  const home = await mkdtemp("/tmp/ncx-device-");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/me") response.end(JSON.stringify({ authentication: "api_key", user: { id: "test-owner" } }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/v1/account/tool-host") { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws));
  });
  let catalogs = 0, current, result;
  sockets.on("connection", socket => {
    current = socket;
    socket.on("message", data => {
      const frame = JSON.parse(String(data));
      if (frame.type === "catalog") { catalogs++; socket.send('{"type":"ready"}'); }
      if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong", nonce: frame.nonce }));
      if (frame.type === "drain") socket.send('{"type":"draining"}');
      if (frame.type === "result") { result = frame; socket.send(JSON.stringify({ type: "ack", call_id: frame.call_id })); }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = { ...process.env, HOME: home, NANOCODEX_MANAGED_URL: `http://127.0.0.1:${server.address().port}`, NANOCODEX_DESKTOP_DATA: home };
  const env = char => ({ ...base, NANOCODEX_API_KEY: `ncx_live_${char.repeat(12)}_${char.repeat(43)}` });
  const connections = [];
  t.after(async () => {
    for (const connection of connections) await connection.close();
    await delay(5000);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const firstId = await describeDeviceHand(binary, env("a"));
  const secondId = await describeDeviceHand(binary, env("b"));
  assert.equal(firstId.id, secondId.id, "API key rotation must not create another Mac");
  for (const key of ["a", "b"]) {
    const connection = connectDeviceHand({ binary, env: env(key), signal: new AbortController().signal, onState() {} });
    connections.push(connection); await connection.ready;
  }
  assert.equal(catalogs, 1);
  await connections[0].close();
  await delay(2500);
  assert.equal(catalogs, 1, "Closing the first client must preserve the existing publisher");
  current.send(JSON.stringify({ type: "call", session_id: "hand-test", call_id: "host-shell", model: "gpt-6-astra", name: "exec_command",
    input: { cmd: "printf hand_shared_ok" }, output_token_budget: 1024, output_byte_budget: 131072, deadline_at: Date.now() + 10_000 }));
  const deadline = Date.now() + 10_000;
  while (!result && Date.now() < deadline) await delay(20);
  assert.equal(result?.outcome.status, "completed");
  assert.match(result.outcome.output.output, /hand_shared_ok/);
  const closed = once(current, "close");
  await connections[1].close();
  await Promise.race([closed, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("Publisher outlived its last client"); })]);
  assert.equal((await describeDeviceHand(binary, env("a"))).id, firstId.id);
});
