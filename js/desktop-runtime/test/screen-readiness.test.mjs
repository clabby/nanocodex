import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { DesktopRuntime } from "@nanocodex/desktop-runtime";

// Only OS capture is substituted. Runtime, subprocesses, shell execution and
// HTTP/WebSocket attachment all run through their shipped public interfaces.
process.env.NANOCODEX_COMPUTER = "off";
const key = `ncx_live_${"a".repeat(12)}_${"b".repeat(43)}`;
const secondKey = `ncx_live_${"c".repeat(12)}_${"d".repeat(43)}`;
async function until(check, description, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await delay(10); }
  assert.fail(`Timed out: ${description}`);
}
async function journey(t) {
  const directory = await mkdtemp(join(tmpdir(), "ncx-screen-journey-"));
  const helperPath = join(directory, "screen-helper");
  const wsPath = import.meta.resolve("ws");
  await writeFile(helperPath, `#!${process.execPath}\n` + `
import WebSocket from ${JSON.stringify(wsPath)};
const socket = new WebSocket(process.env.NANOCODEX_MANAGED_URL.replace('http:', 'ws:') + '/fixture/screen');
socket.on('message', bytes => {
  const { command } = JSON.parse(String(bytes));
  if (command === 'ready') console.error('Hand screen is ready');
  if (command === 'failure') console.error('Hand screen unavailable: capture unavailable ' + process.env.NANOCODEX_API_KEY);
  if (command === 'crash') process.exit(1);
  if (command === 'exit') { console.error('Hand screen publisher stopped'); process.exit(0); }
});
process.on('SIGTERM', () => { console.error('Hand screen is ready'); setTimeout(() => process.exit(0), 80); });
`);
  // A script extension is not needed: the executable uses an explicit Node shebang.
  await chmod(helperPath, 0o700);
  const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); });
  const sockets = new WebSocketServer({ noServer: true });
  const helpers = [], hosts = [], frames = [], trace = [];
  server.on("upgrade", (request, socket, head) => {
    if (!["/v1/account/tool-host", "/fixture/screen"].includes(request.url)) { socket.destroy(); return; }
    if (request.url === "/v1/account/tool-host") assert.ok([`Bearer ${key}`, `Bearer ${secondKey}`].includes(request.headers.authorization));
    sockets.handleUpgrade(request, socket, head, ws => {
      if (request.url === "/fixture/screen") { helpers.push(ws); trace.push({ event: "helper-connected", instance: helpers.length }); return; }
      const host = { socket: ws };
      hosts.push(host);
      ws.on("message", data => {
        const frame = JSON.parse(String(data));
        if (frame.type === "catalog") { host.catalog = frame; ws.send('{"type":"ready"}'); trace.push({ event: "catalog", instance: hosts.length }); }
        if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong", nonce: frame.nonce }));
        if (frame.type === "drain") ws.send('{"type":"draining"}');
        if (frame.type === "result") { frames.push(frame); ws.send(JSON.stringify({ type: "ack", call_id: frame.call_id })); }
      });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let saved;
  const runtime = new DesktopRuntime({ baseUrl, apiKey: key, persist: async value => { saved = structuredClone(value); }, defaults: { binary: helperPath }, dataDirectory: join(directory, "data"),
    saved: { hands: [{ id: "primary", name: "Primary", kind: "local", workspace: directory }] } });
  runtime.on("event", event => {
    if (event.type === "state") {
      const hand = event.state.hands.find(hand => hand.id === "screen-test");
      trace.push({ event: "state", shell: hand?.status, screen: hand?.screen });
    }
  });
  t.after(async () => {
    await runtime.close();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ journey: t.name, trace }));
  });
  await runtime.refresh();
  await runtime.saveHand({ id: "screen-test", name: "Synthetic desktop", kind: "local", workspace: directory });
  const hand = () => runtime.state().hands.find(hand => hand.id === "screen-test");
  const command = (socket, command) => socket.send(JSON.stringify({ command }));
  let calls = 0;
  async function shell() {
    const host = hosts.at(-1);
    const tool = host.catalog.tools.find(tool => tool.remote_name === "exec_command" || tool.definition.name === "exec_command");
    assert.ok(tool, "Real attachment must expose shell execution");
    const id = `screen-shell-${++calls}`;
    host.socket.send(JSON.stringify({ type: "call", session_id: "screen-journey", call_id: id, model: "gpt-6-astra", name: tool.definition.name,
      input: { cmd: "printf screen_shell_usable", workdir: directory }, output_token_budget: 1024, output_byte_budget: 131072, deadline_at: Date.now() + 10_000 }));
    await until(() => frames.some(frame => frame.call_id === id), "shell result");
    const result = frames.find(frame => frame.call_id === id);
    assert.equal(result.outcome.status, "completed");
    assert.match(JSON.stringify(result.outcome.output), /screen_shell_usable/);
    trace.push({ event: "shell-result", call: calls, outcome: result.outcome.status, marker: "screen_shell_usable" });
  }
  return { runtime, hand, helpers, command, shell, hosts, trace, baseUrl, preferences: () => saved };
}

test("screen startup failure, recovery, terminal exit and Stop preserve a usable shell", { skip: process.platform === "win32", timeout: 25_000 }, async t => {
  const f = await journey(t);
  const starting = f.runtime.startHand("screen-test");
  await until(() => f.helpers.length === 1, "first screen helper");
  assert.equal(f.hand().screen.status, "starting");
  f.command(f.helpers[0], "failure"); await starting;
  assert.equal(f.hand().status, "connected");
  assert.equal(f.hand().screen.status, "unavailable");
  assert.match(f.hand().screen.error, /\[redacted\]/);
  assert.ok(!JSON.stringify(f.runtime.state()).includes(key));
  await f.shell();
  f.command(f.helpers[0], "ready");
  await until(() => f.hand().screen.status === "ready", "late readiness after failure");
  assert.equal(f.hand().screen.error, undefined);
  // A live publisher can lose capture without exiting or republishing.
  f.command(f.helpers[0], "failure");
  await until(() => f.hand().screen.status === "unavailable", "post-ready capture loss");
  assert.equal(f.hand().status, "connected"); await f.shell();
  f.command(f.helpers[0], "ready");
  await until(() => f.hand().screen.status === "ready", "capture recovery on the same publisher");
  assert.equal(f.helpers.length, 1, "Recovery must retain the existing process/publication owner");
  f.command(f.helpers[0], "crash");
  await until(() => f.hand().screen.status === "unavailable", "late screen child exit");
  assert.match(f.hand().screen.error, /publisher stopped \(1\)/);
  await f.shell();
  await delay(100); assert.equal(f.helpers.length, 1, "Terminal exit must not reclaim or respawn publication");
  await f.runtime.stopHand("screen-test");
  assert.equal(f.hand().screen.status, "stopped");
  const replacement = f.runtime.startHand("screen-test");
  await until(() => f.helpers.length === 2, "replacement screen helper");
  f.command(f.helpers[1], "ready"); await replacement;
  await f.shell();
  await f.runtime.saveLayout({ tabs: [{ id: "screen-tab" }], activeTabId: "screen-tab", tabPosition: "left", theme: "system" });
  assert.ok(f.preferences().hands.every(hand => hand.screen === undefined), "Readiness is never persisted as live presence");
  f.command(f.helpers[1], "exit");
  await until(() => f.hand().screen.status === "unavailable", "terminal publisher notification and exit");
  assert.match(f.hand().screen.error, /replaced by another host/);
  await delay(100); assert.equal(f.helpers.length, 2, "Terminal notification cannot reclaim publication");
  await f.runtime.stopHand("screen-test");
  const stopTarget = f.runtime.startHand("screen-test");
  await until(() => f.helpers.length === 3, "screen before explicit Stop");
  f.command(f.helpers[2], "ready"); await stopTarget;
  // The OS helper emits a late readiness line during SIGTERM. It cannot undo Stop.
  await f.runtime.stopHand("screen-test"); await delay(100);
  assert.equal(f.hand().status, "stopped"); assert.deepEqual(f.hand().screen, { status: "stopped" });
  const fenced = f.runtime.startHand("screen-test");
  await until(() => f.helpers.length === 4, "capture starting during shell replacement");
  f.hosts.at(-1).socket.close(1008, "Host replaced");
  await until(() => f.hand().status === "stopped" && f.hand().screen.status === "stopped", "shell fencing must promptly cancel screen startup", 2000);
  await fenced;
  await until(() => f.helpers[3].readyState === 3, "fenced helper process must close promptly", 2000);
  await f.runtime.stopHand("screen-test"); // Await complete resource retirement before explicit restart.
  assert.equal(f.helpers.length, 4, "A retired shell must not restart capture publication");
  const next = f.runtime.startHand("screen-test");
  await until(() => f.helpers.length === 5, "new screen while account replacement begins");
  await f.runtime.connect({ baseUrl: f.baseUrl, apiKey: secondKey }); await next;
  assert.deepEqual(f.runtime.state().hands, [], "Late readiness cannot cross the account transition");
  const transitions = f.trace.filter(event => event.event === "state").map(event => event.screen?.status);
  for (const status of ["starting", "ready", "unavailable", "stopped"]) assert.ok(transitions.includes(status), `Public notifications must include ${status}`);
});

test("native screen publication after the real startup deadline recovers readiness", { skip: process.platform === "win32", timeout: 55_000 }, async t => {
  const f = await journey(t);
  const starting = f.runtime.startHand("screen-test");
  await until(() => f.helpers.length === 1, "screen helper awaiting publication");
  await starting; // Exercise the real 40-second deadline, not a fake timer or test-only seam.
  assert.equal(f.hand().status, "connected"); assert.equal(f.hand().screen.status, "unavailable");
  assert.match(f.hand().screen.error, /40 seconds/);
  await f.shell();
  f.command(f.helpers[0], "ready");
  await until(() => f.hand().screen.status === "ready", "post-timeout publication");
  await f.shell();
  await f.runtime.stopHand("screen-test");
  assert.deepEqual(f.hand().screen, { status: "stopped" });
});
