import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import WebSocket from "ws";
import { createTools } from "nanocodex/tools";
import { createAttachment } from "nanocodex-tools/attachment";
import { createNodeProcessTools } from "nanocodex-tools/node";

// Real public JS publisher, ToolRouter, workerd WebSockets, broker, SQLite and
// native /bin/sh. Only admission credentials and clocks are fixture inputs.
// The HTTP wrapper calls the broker's public machine API and retains one old
// binding to exercise generation fencing without replacing broker behavior.
const root = fileURLToPath(new URL("..", import.meta.url));
const credential = "Bearer synthetic-hand-reconnect";
const machineId = "synthetic-hand";
const source = `
import { DurableObject } from 'cloudflare:workers';
import { HostedToolsBroker } from './src/hosted-tools-broker.ts';
export class FixtureBroker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.now = 1000; this.bindings = new Map();
    this.broker = new HostedToolsBroker(ctx, {now: () => this.now});
  }
  async fetch(request) {
    if (request.headers.get('authorization') !== '${credential}') return new Response(null, {status: 401});
    const path = new URL(request.url).pathname;
    if (path === '/attach') return this.broker.upgrade('synthetic-session');
    if (path === '/clock') { this.now = (await request.json()).now; return Response.json({now: this.now}); }
    if (path === '/bind') {
      const {id} = await request.json();
      const tool = this.broker.machineTool('${machineId}', 'exec_command');
      if (!tool) return new Response(null, {status: 503});
      this.bindings.set(id, tool); return Response.json({id, route_token: tool.routeToken});
    }
    if (path === '/invoke') {
      const {binding, call_id, input} = await request.json();
      const tool = binding ? this.bindings.get(binding) : this.broker.machineTool('${machineId}', 'exec_command');
      if (!tool) return new Response(null, {status: 503});
      return Response.json(await tool.handler(input, {sessionId: 'synthetic-session',
        callId: call_id, parentCallId: '', model: 'synthetic-model', signal: request.signal}));
    }
    if (path === '/inspect') return Response.json({now: this.now,
      online: this.broker.machineOnline('${machineId}'), machines: this.broker.machines(),
      routes: this.ctx.storage.sql.exec('SELECT route_id,generation,lease_id,lease_expires_at FROM hosted_tool_routes').toArray(),
      calls: this.ctx.storage.sql.exec('SELECT call_id,source_call_id,generation,lease_id,state,dispatched_at,result_json,receipt_json FROM hosted_tool_calls ORDER BY created_at,source_call_id').toArray()});
    return new Response(null, {status: 404});
  }
  webSocketMessage(socket, message) { return this.broker.webSocketMessage(socket, message); }
  webSocketClose(socket, code, reason) { this.broker.webSocketClose(socket, code, reason); }
  webSocketError(socket) { this.broker.webSocketError(socket); }
}
export default {fetch(request, env) { return env.BROKER.getByName('synthetic-broker').fetch(request); }};
`;

test("an expired Hand lease reconnects, fences old work, and keeps replacement terminal", { timeout: 45_000 }, async t => {
  const output = join(root, "../../output/no-execution-gates-20261001/hand-reconnect", `${Date.now()}-${process.pid}`);
  const workspace = join(output, "hand");
  await mkdir(workspace, { recursive: true });
  const trace = [], wire = [], runtime = [], nativeResults = [];
  const sockets = new Map();
  const result = { command: "pnpm --filter nanocodex-tools build && pnpm --filter nanocodex-managed-service test:hand-reconnect",
    inputs: { catalog_at: 1000, lease_expires_at: 61000, next_heartbeat_at: 61001,
      heartbeat_ms: 100, reconnect_delay_ms: 1, machine_id: machineId, shell: "/bin/sh" },
    expected: { expiry_close: 1012, reconnected_generation: 2, same_runtime: true,
      fresh_shell_output: "RECONNECTED_OK", uncertain_effect_count: 1, stale_binding_dispatches: 0,
      replacement_close: 1008, replaced_publisher_reconnects: 0, old_receipt_close: 1008, old_receipt_accepted: false }, observed: {} };
  const capture = line => runtime.push(line);
  const bundle = await build({ stdin: { contents: source, resolveDir: root }, bundle: true, write: false,
    metafile: true, format: "esm", platform: "node", target: "es2022", external: ["cloudflare:*", "node:*"], logLevel: "warning" });
  const candidateRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const resolutions = Object.fromEntries(["nanocodex/tools", "nanocodex-tools/attachment", "nanocodex-tools/node", "nanocodex-tools/runtime/tool-router", "nanocodex-tools/hosted"]
    .map(name => [name, fileURLToPath(import.meta.resolve(name))]));
  for (const path of Object.values(resolutions)) assert.ok(path.startsWith(candidateRoot), `dependency escaped candidate checkout: ${path}`);
  await writeFile(join(output, "source-resolution.json"), JSON.stringify({resolutions, bundleInputs: Object.keys(bundle.metafile.inputs)}, null, 2) + "\n");
  await writeFile(join(output, "fixture-source.mjs"), source);
  await writeFile(join(output, "worker.mjs"), bundle.outputFiles[0].text);
  const mf = new Miniflare({ port: 0, modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    durableObjects: { BROKER: { className: "FixtureBroker", useSQLite: true } },
    durableObjectsPersist: join(output, "sqlite"), handleRuntimeStdio(stdout, stderr) {
      createInterface({ input: stdout }).on("line", capture);
      createInterface({ input: stderr }).on("line", capture);
    } });
  const base = await mf.ready;
  const endpoint = new URL("/attach", base); endpoint.protocol = "ws:";
  let clock = 1000;
  // Keep executor deadlines in the broker's synthetic epoch. Timers, workerd,
  // process execution and performance.now() continue to run on real time.
  t.mock.method(Date, "now", () => clock);
  const api = async (path, body) => {
    const response = await fetch(new URL(path, base), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: credential, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify({path, value}));
    return value;
  };
  const inspect = () => api("/inspect");
  const waitFor = async (predicate, description) => {
    const deadline = performance.now() + 8_000;
    while (performance.now() < deadline) {
      const value = await predicate(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`${description}: ${JSON.stringify({wire, inspection: await inspect()})}`);
  };
  const native = await createNodeProcessTools({ workspace, onActivity: event => trace.push({native: event}) });
  // Capture the real public provider result before the publisher decides whether
  // its originating socket still owns the call; the handler runs unchanged.
  const tools = await createTools({ tools: native.tools.map(tool => tool.name !== "exec_command" ? tool : {
    ...tool, async handler(input, context) {
      const output = await tool.handler(input, context);
      nativeResults.push({call_id: context.callId, output});
      return output;
    },
  }) });
  const connectors = [];
  const publish = label => {
    const connector = createAttachment(tools, { endpoint: endpoint.href, transport: { connect() {
      const attempt = wire.filter(row => row.publisher === label && row.event === "connect").length + 1;
      wire.push({publisher: label, attempt, event: "connect", clock});
      const socket = new WebSocket(endpoint, { headers: { authorization: credential } });
      sockets.set(`${label}:${attempt}`, socket);
      const send = socket.send.bind(socket);
      socket.send = (data, ...args) => { wire.push({publisher: label, attempt, direction: "host", clock,
        frame: JSON.parse(String(data))}); return send(data, ...args); };
      socket.on("message", data => wire.push({publisher: label, attempt, direction: "broker", clock,
        frame: JSON.parse(String(data))}));
      socket.on("close", (code, reason) => wire.push({publisher: label, attempt, event: "close", clock,
        code, reason: reason.toString()}));
      return socket;
    } } }, { machines: [{id: machineId, name: "Synthetic Hand", workspace, capabilities: ["shell"]}],
      attachmentId: machineId, heartbeatMs: 100, reconnectDelayMs: 1 });
    connectors.push(connector); return connector;
  };
  const invoke = (callId, input, binding) => api("/invoke", {call_id: callId, input, ...(binding ? {binding} : {})});
  const callFrames = () => wire.filter(row => row.direction === "broker" && row.frame.type === "call");
  let failure;
  try {
    const first = publish("first"); const firstClient = await first.connect();
    assert.equal(firstClient.connected, true);
    const initial = await inspect();
    const firstCatalog = wire.find(row => row.publisher === "first" && row.direction === "host" && row.frame.type === "catalog").frame;
    assert.match(firstCatalog.runtime_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(initial.now, 1000); assert.equal(initial.routes[0].lease_expires_at, 61000);
    assert.equal(initial.routes[0].generation, 1); assert.equal(initial.online, true);
    const binding = await api("/bind", {id: "before-expiry"});
    trace.push({initial, binding});

    const completedInput = {cmd: "printf 'COMPLETED_ONCE\\n' >> completed.log; printf BEFORE_OK", shell: "/bin/sh", login: false, yield_time_ms: 1000};
    const completed = await invoke("completed-once", completedInput);
    assert.equal(completed.success, true); assert.equal(completed.structuredResult.output, "BEFORE_OK");
    assert.equal(completed.structuredResult.exit_code, 0);

    // A real command commits an effect before expiry, then still has no receipt.
    // The broker must report ambiguity and never resend it on the fresh lease.
    const pendingInput = {cmd: "printf 'UNCERTAIN_ONCE\\n' >> uncertain.log; while [ ! -f release-old-result ]; do sleep 0.02; done; printf OLD_RESULT", shell: "/bin/sh", login: false, yield_time_ms: 30000};
    const pending = invoke("uncertain-once", pendingInput);
    await waitFor(async () => {
      try { return (await readFile(join(workspace, "uncertain.log"), "utf8")) === "UNCERTAIN_ONCE\n"; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }, "native command did not commit its first effect");
    clock = 61001; assert.deepEqual(await api("/clock", {now: clock}), {now: 61001});
    await waitFor(() => wire.some(row => row.publisher === "first" && row.event === "close" && row.code === 1012), "expired lease did not close with 1012");
    const expiryCloseIndex = wire.findIndex(row => row.publisher === "first" && row.event === "close" && row.code === 1012);
    assert.ok(wire.slice(0, expiryCloseIndex).some(row => row.publisher === "first" && row.attempt === 1
      && row.direction === "host" && row.frame.type === "ping" && row.clock === 61001), "expiry must be detected by the shipped client's next heartbeat");
    const reconnected = await waitFor(async () => {
      const state = await inspect(); return state.routes[0].generation === 2 && firstClient.connected
        && wire.filter(row => row.publisher === "first" && row.direction === "broker" && row.frame.type === "ready").length === 2 ? state : undefined;
    }, "public JS publisher did not become ready again");
    const secondCatalog = wire.find(row => row.publisher === "first" && row.attempt === 2 && row.direction === "host" && row.frame.type === "catalog").frame;
    assert.equal(reconnected.routes[0].generation, 2);
    assert.equal(reconnected.now, 61001); assert.equal(reconnected.routes[0].lease_expires_at, 121001);
    assert.equal(secondCatalog.runtime_id, firstCatalog.runtime_id);
    assert.notEqual(reconnected.routes[0].lease_id, initial.routes[0].lease_id);
    assert.equal(reconnected.online, true);
    const oldOutcome = await pending;
    assert.equal(oldOutcome.success, false); assert.equal(oldOutcome.structuredResult.status, "ambiguous");
    trace.push({reconnected, oldOutcome});

    const refreshedBinding = await api("/bind", {id: "after-expiry"});
    assert.notEqual(refreshedBinding.route_token, binding.route_token);
    const dispatches = callFrames().length;
    const stale = await invoke("stale-binding-new-call", {cmd: "printf STALE_MUST_NOT_RUN", shell: "/bin/sh", login: false}, "before-expiry");
    assert.equal(stale.success, false); assert.equal(stale.structuredResult.status, "unavailable");
    assert.equal(callFrames().length, dispatches, "old generation binding was retargeted");
    const completedReplay = await invoke("completed-once", completedInput);
    assert.equal(completedReplay.structuredResult.output, "BEFORE_OK");
    const uncertainReplay = await invoke("uncertain-once", pendingInput);
    assert.equal(uncertainReplay.structuredResult.status, "ambiguous");
    assert.equal(callFrames().length, dispatches, "retained calls were replayed to the new generation");
    const fresh = await invoke("fresh-after-reconnect", {cmd: "printf RECONNECTED_OK", shell: "/bin/sh", login: false, yield_time_ms: 1000});
    assert.equal(fresh.success, true); assert.equal(fresh.structuredResult.output, "RECONNECTED_OK");
    assert.equal(fresh.structuredResult.exit_code, 0);
    await writeFile(join(workspace, "release-old-result"), "fixture input: permit the original command to finish\n");
    const oldTransportCall = callFrames().find(row => row.frame.input.cmd === pendingInput.cmd).frame;
    const oldNativeResult = await waitFor(() => nativeResults.find(row => row.call_id === oldTransportCall.call_id), "original native command did not finish");
    assert.equal(oldNativeResult.output.output, "OLD_RESULT");
    assert.equal(oldNativeResult.output.exit_code, 0);
    // Wait for a real heartbeat after completion so the discarded result has
    // had an opportunity to reach the broker if the publisher were to resend it.
    const heartbeats = wire.filter(row => row.publisher === "first" && row.attempt === 2 && row.direction === "broker" && row.frame.type === "pong").length;
    await waitFor(() => wire.filter(row => row.publisher === "first" && row.attempt === 2 && row.direction === "broker" && row.frame.type === "pong").length > heartbeats, "reconnected publisher stopped heartbeating");
    assert.equal(wire.some(row => row.direction === "host" && row.frame.type === "result" && row.frame.call_id === oldTransportCall.call_id), false);
    const afterOldFinish = await inspect();
    assert.equal(afterOldFinish.calls.find(row => row.source_call_id === "uncertain-once").receipt_json, null);
    trace.push({oldNativeResult, afterOldFinish});
    assert.equal(await readFile(join(workspace, "completed.log"), "utf8"), "COMPLETED_ONCE\n");
    assert.equal(await readFile(join(workspace, "uncertain.log"), "utf8"), "UNCERTAIN_ONCE\n");
    trace.push({stale, completedReplay, uncertainReplay, fresh, refreshedBinding});

    // A distinct publisher for the same machine is a policy replacement, not
    // expiry. The old publisher must finish rather than evict its successor.
    const second = publish("replacement"); const secondClient = await second.connect();
    await waitFor(() => wire.some(row => row.publisher === "first" && row.event === "close" && row.code === 1008), "replacement did not close old publisher with 1008");
    await first.closed();
    assert.equal(firstClient.connected, false); assert.equal(secondClient.connected, true);
    // Observe several heartbeat/retry windows through real round trips.
    await waitFor(() => wire.filter(row => row.publisher === "replacement" && row.direction === "broker" && row.frame.type === "pong").length >= 3,
      "replacement publisher did not retain the route");
    assert.equal(wire.filter(row => row.publisher === "first" && row.event === "connect").length, 2);
    assert.equal(wire.filter(row => row.publisher === "replacement" && row.event === "connect").length, 1);
    const replacementResult = await invoke("fresh-after-replacement", {cmd: "printf REPLACEMENT_OK", shell: "/bin/sh", login: false, yield_time_ms: 1000});
    assert.equal(replacementResult.structuredResult.output, "REPLACEMENT_OK");
    const final = await inspect();
    assert.equal(final.routes[0].generation, 3); assert.equal(final.online, true);
    const uncertainRow = final.calls.find(row => row.source_call_id === "uncertain-once");
    assert.equal(uncertainRow.state, "ambiguous"); assert.equal(uncertainRow.generation, 1);
    assert.equal(final.calls.find(row => row.source_call_id === "fresh-after-reconnect").generation, 2);
    assert.equal(final.calls.find(row => row.source_call_id === "fresh-after-replacement").generation, 3);
    trace.push({final, replacementResult});
    // Deliberately send the original completed /bin/sh output as a stale receipt
    // on the successor's socket. Generation fencing must reject it even though
    // the receipt is well-formed and its call ID remains in the durable ledger.
    const oldReceipt = {type: "result", call_id: oldTransportCall.call_id,
      outcome: {status: "completed", output: {output: JSON.stringify(oldNativeResult.output), success: true,
        structured_result: oldNativeResult.output, metadata: null, process_trace: null}}};
    sockets.get("replacement:1").send(JSON.stringify(oldReceipt));
    await waitFor(() => wire.some(row => row.publisher === "replacement" && row.event === "close" && row.code === 1008), "successor accepted an old-generation receipt");
    await second.closed();
    const afterOldReceipt = await inspect();
    const rejectedRow = afterOldReceipt.calls.find(row => row.source_call_id === "uncertain-once");
    assert.equal(rejectedRow.state, "ambiguous"); assert.equal(rejectedRow.receipt_json, null);
    assert.equal(rejectedRow.result_json, uncertainRow.result_json);
    assert.equal(wire.some(row => row.publisher === "replacement" && row.direction === "broker" && row.frame.type === "ack" && row.frame.call_id === oldTransportCall.call_id), false);
    trace.push({oldReceipt, afterOldReceipt});
    assert.equal(callFrames().length, 4, "recovery must dispatch only the four original/fresh shell calls");
    result.observed = {expiry_close: 1012, reconnected_generation: reconnected.routes[0].generation,
      same_runtime: secondCatalog.runtime_id === firstCatalog.runtime_id, fresh_shell_output: fresh.structuredResult.output,
      uncertain_effect_count: 1, stale_binding_dispatches: 0, replacement_close: 1008,
      replaced_publisher_reconnects: 0, old_receipt_close: 1008, old_receipt_accepted: false,
      real_shell_dispatches: callFrames().length, final_generation: final.routes[0].generation};
    console.log(JSON.stringify({evidence: output, ...result.observed}));
  } catch (error) {
    failure = error; result.error = error.stack; throw error;
  } finally {
    try { trace.push({before_cleanup: await inspect()}); } catch (error) { trace.push({inspection_error: error.message}); }
    await Promise.all(connectors.map(connector => connector.close()));
    await tools.close(); await native.close(); await mf.dispose();
    t.mock.restoreAll();
    await writeFile(join(output, "trace.json"), JSON.stringify({result, trace}, null, 2) + "\n");
    await writeFile(join(output, "wire.json"), JSON.stringify(wire, null, 2) + "\n");
    await writeFile(join(output, "native-results.json"), JSON.stringify(nativeResults, null, 2) + "\n");
    await writeFile(join(output, "runtime.log"), runtime.join("\n") + "\n");
    await writeFile(join(output, "README.md"), `Run: \`${result.command}\`\n\nInputs: catalog at 1000, lease expires at 61000, next client heartbeat at 61001. The fixture controls both clock epochs; timers and /bin/sh are real.\n\nExpected: lease expiry closes with 1012, automatic generation 2 ready in the same runtime, RECONNECTED_OK from a real native command. Completed receipts replay without executing again; in-flight work stays ambiguous and executes once; old bindings cannot retarget. The original native command finishes once and its result is discarded; injecting that old receipt on a successor socket yields 1008 with no ACK or ledger mutation. A second publisher closes the first with terminal 1008 and survives three heartbeat windows with no eviction loop.\n\nObserved: ${JSON.stringify(result.observed)}\n\nStatus: ${failure ? "FAIL: " + failure.message : "PASS"}\n\nEvidence: trace.json (HTTP results, SQLite ledger), wire.json (actual WebSocket frames/closes), native-results.json (unchanged public provider results), source-resolution.json (candidate imports/bundle inputs), runtime.log (workerd console), hand/*.log (native effects), fixture-source.mjs and worker.mjs (exact wrapper/bundle), sqlite/ (persisted Durable Object SQLite).\n\nScope: public JS APIs and real broker transport/persistence/runtime; hosted account auth, live deployments, native Rust reconnect and physical sleep are outside this deterministic fixture.\n`);
  }
});
