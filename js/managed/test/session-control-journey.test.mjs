import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import WebSocket from "ws";

// Reproduce: pnpm --filter nanocodex-managed-service run test:session-control
// Only identity enrollment and the external model are fixtures. Public HTTP,
// authentication, the session_control tool, Code Mode and both sessions'
// production turn lifecycles run in workerd.
const root = fileURLToPath(new URL("..", import.meta.url));
const evidence = join(root, "../../output/session-control-journey", `${Date.now()}-${process.pid}`);
const alice = "22222222-2222-4222-8222-222222222201";
const bob = "22222222-2222-4222-8222-222222222202";
const caps = ["agents:read", "agents:write", "tools:use"];
const source = `
import { DurableObject } from 'cloudflare:workers';
import worker, { DurableAgentSession, AccountHostedTools } from './src/index.ts';
import { UserAccount, Organization, ApiKeyRecord, NonceStorage, ensureAccount, createApiKey } from './src/account-auth.ts';
export { DurableAgentSession, AccountHostedTools, UserAccount, Organization, ApiKeyRecord, NonceStorage };
const info = console.info.bind(console);
console.info = (record, ...rest) => info(record && typeof record === 'object' ? JSON.stringify(record) : record, ...rest);
export class FixtureSandbox extends DurableObject {
  async clearRemoteDesktop() {}
  async destroy() {}
}
// One scripted model for every session: a user message carrying
// SESSION_TOOL <base64 code> runs that Code Mode program once; SLOW_TARGET
// keeps a target turn active long enough to steer it.
export class FixtureModel extends DurableObject {
  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return Response.json({tools:[],machines:[],connections:[]});
    const [client, server] = Object.values(new WebSocketPair()); server.accept();
    server.addEventListener('close', () => server.close(1000));
    server.addEventListener('message', async event => {
      const body = JSON.parse(event.data);
      const items = body.input ?? [];
      const last = items.at(-1);
      const user = JSON.stringify(items.filter(item => item.role === 'user').at(-1) ?? '');
      const followUp = last && last.role !== 'user' && String(last.type ?? '').endsWith('output');
      if (!followUp && user.includes('SLOW_TARGET')) await new Promise(resolve => setTimeout(resolve, 4000));
      const marker = user.match(/SESSION_TOOL ([A-Za-z0-9+/=]+)/);
      const input = marker && !followUp ? atob(marker[1]) : undefined;
      const reply = user.includes('STEER_TEXT') ? 'STEERED_REPLY' : 'JOURNEY_DONE';
      server.send(JSON.stringify({type:'response.completed',response:{id:'resp_'+crypto.randomUUID(),status:'completed',end_turn:!input,
        output:input ? [{type:'custom_tool_call',name:'exec',call_id:'call-'+crypto.randomUUID(),input}]
          : [{type:'message',role:'assistant',content:[{type:'output_text',text:reply}]}],
        usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
    });
    return new Response(null,{status:101,webSocket:client});
  }
}
export default { async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === '/__fixture') {
    const b = await request.json(); await ensureAccount(env,b.user,true);
    const auth = await (await env.NANOCODEX_USERS.getByName(b.user).fetch('https://user.internal/authorization')).json();
    return Response.json(await createApiKey(env,{kind:'api_key',userId:b.user,...auth.grant,subjectId:'api_key:'+b.user,
      credentialId:'fixture',capabilities:b.capabilities},'Synthetic session control journey'));
  }
  return worker.fetch(request,env,ctx);
}};
`;

test("session_control drives another owned session through the managed turn lifecycle", { timeout: 180_000 }, async () => {
  await mkdir(evidence, { recursive: true });
  const trace = [], logs = [], assets = [], provenance = [];
  const record = entry => { trace.push(entry); appendFileSync(join(evidence, "trace.jsonl"), JSON.stringify(entry) + "\n"); };
  const bundle = await build({ stdin: { contents: source, resolveDir: root }, bundle: true, write: false,
    format: "esm", platform: "node", conditions: ["workerd"], target: "es2022",
    banner: { js: 'import { createRequire } from "node:module"; const require=createRequire("/worker.mjs");' },
    external: ["cloudflare:*", "node:*"], alias: { "node-rsa": join(root, "../nanocodex/tools/browser/unsupportedNodeRsa.mjs") },
    plugins: [{ name: "wasm", setup(builder) { builder.onResolve({ filter: /\.wasm$/ }, async args => {
      const path = join(args.resolveDir, args.path), contents = await readFile(path);
      const name = `fixture-${assets.length}.wasm`;
      assets.push({ type: "CompiledWasm", path: name, contents });
      provenance.push({ path, sha256: createHash("sha256").update(contents).digest("hex") });
      return { path: `./${name}`, external: true };
    }); } }], logLevel: "silent",
  });
  const proxy = await build({ stdin: { contents: `import {routeManaged} from '../account/worker/managedProxy.ts';
    export default {async fetch(request,env){return await routeManaged(request,env,new URL(request.url)) ?? new Response(null,{status:404})}}`, resolveDir: root },
    bundle: true, write: false, format: "esm", platform: "node", conditions: ["workerd"], target: "es2022",
    external: ["cloudflare:*", "node:*"], logLevel: "silent" });
  const common = { compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat", "enable_request_signal"] };
  const mf = new Miniflare({ port: 0, handleRuntimeStdio(stdout, stderr) {
    for (const stream of [stdout, stderr]) createInterface({ input: stream }).on("line", line => logs.push(line));
  }, workers: [
    { ...common, name: "account", modules: true, script: proxy.outputFiles[0].text, serviceBindings: { NANOCODEX_BACKEND: "managed" } },
    { ...common, name: "managed", modules: [{ type: "ESModule", path: "worker.mjs", contents: bundle.outputFiles[0].text }, ...assets],
      durableObjects: {
        NANOCODEX_SESSIONS: { className: "DurableAgentSession", useSQLite: true },
        NANOCODEX_USERS: { className: "UserAccount", useSQLite: true },
        NANOCODEX_ORGANIZATIONS: { className: "Organization", useSQLite: true },
        NANOCODEX_API_KEYS: { className: "ApiKeyRecord", useSQLite: true },
        NANOCODEX_AUTH: { className: "NonceStorage", useSQLite: true },
        NANOCODEX_SANDBOXES: { className: "FixtureSandbox", useSQLite: true },
        NANOCODEX_ACCOUNT_TOOLS: { className: "AccountHostedTools", useSQLite: true },
        NANOCODEX_MEMORY: { className: "FixtureModel", useSQLite: true },
        MODEL: { className: "FixtureModel", useSQLite: true },
      }, serviceBindings: { NANOCODEX: "provider" },
      r2Buckets: ["NANOCODEX_HISTORY", "NANOCODEX_WORKSPACES", "NANOCODEX_USER_DATA_OBJECTS"] },
    { ...common, name: "provider", modules: true,
      script: "export default {fetch(request,env){return env.MODEL.getByName('fixture-model').fetch(request)}};",
      durableObjects: { MODEL: { className: "FixtureModel", scriptName: "managed", useSQLite: true } } },
  ] });
  const sockets = [];
  try {
    const base = await mf.ready, backend = await mf.getWorker("managed");
    const key = async (user, capabilities) => {
      const response = await backend.fetch("https://fixture.test/__fixture", { method: "POST", body: JSON.stringify({ user, capabilities }) });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).token;
    };
    const tokens = { alice: await key(alice, caps), bob: await key(bob, caps), aliceNoRead: await key(alice, ["agents:write", "tools:use"]) };
    async function call(token, path, method = "GET", body, expected = 200) {
      const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15_000), method, headers: {
        "content-type": "application/json", authorization: "Bearer " + tokens[token] }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
      record({ kind: "http", token, method, path, expected, status: response.status, data });
      assert.equal(response.status, expected, `${method} ${path}: ${raw}`);
      return data;
    }
    const create = async token => (await call(token, "/v1/agents", "POST", { settings: { model: "gpt-6.1-sol", thinking: "low", reasoning_mode: "standard", fast_mode: false } }, 201)).agent_id;
    const driver = await create("alice"), target = await create("alice"), foreign = await create("bob");
    record({ kind: "sessions", driver, target, foreign });
    const program = calls => "SESSION_TOOL " + Buffer.from(`const results = [];
for (const [label, args] of ${JSON.stringify(calls)}) {
  try { results.push({ label, ok: true, value: await tools.session_control(args) }); }
  catch (error) { results.push({ label, ok: false, error: String(error?.message ?? error) }); }
}
text(JSON.stringify(results));`).toString("base64");
    const results = frames => {
      const exec = frames.find(frame => frame.event?.type === "tool.result" && frame.event.payload.tool === "exec")?.event.payload;
      const output = exec?.result?.find?.(item => item.type === "input_text" && item.text.startsWith("[{"))?.text;
      assert.ok(output, "exec output: " + JSON.stringify(exec ?? frames.slice(-8)));
      return Object.fromEntries(JSON.parse(output).map(entry => [entry.label, entry]));
    };
    async function socketTurn(id, input) {
      const frames = [];
      const socket = new WebSocket(new URL(`/v1/agents/${id}/ws`, base).href.replace(/^http/, "ws"), { headers: { authorization: "Bearer " + tokens.alice } });
      sockets.push(socket);
      socket.on("message", data => { const frame = JSON.parse(String(data)); frames.push(frame); appendFileSync(join(evidence, "wire.jsonl"), JSON.stringify({ session: id, ...frame }) + "\n"); });
      let error; socket.on("error", value => { error = value; });
      const waitFor = async predicate => {
        const deadline = Date.now() + 60_000;
        while (!predicate()) { if (error) throw error; assert.ok(Date.now() < deadline, "WebSocket timeout: " + JSON.stringify(frames.slice(-6))); await delay(20); }
      };
      await waitFor(() => frames.some(frame => frame.type === "ready"));
      const turnId = crypto.randomUUID();
      socket.send(JSON.stringify({ type: "prompt", id: turnId, input }));
      await waitFor(() => frames.some(frame => frame.id === turnId && ["turn_completed", "turn_failed", "turn_cancelled"].includes(frame.type)));
      const terminal = frames.find(frame => frame.id === turnId && ["turn_completed", "turn_failed", "turn_cancelled"].includes(frame.type));
      assert.equal(terminal.type, "turn_completed", JSON.stringify(terminal));
      socket.close();
      return frames;
    }
    async function settled(session, turnId, token = "alice") {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const turn = await call(token, `/v1/agents/${session}/turns/${encodeURIComponent(turnId)}`);
        if (["completed", "failed", "cancelled"].includes(turn.state)) return turn;
        assert.ok(Date.now() < deadline, "turn did not settle: " + JSON.stringify(turn));
        await delay(100);
      }
    }

    // 1. Inspect, submit, replay, conflict and boundary denials from the driver.
    const first = "design-restart-" + crypto.randomUUID();
    const before = await call("alice", `/v1/agents/${target}`);
    const phase1 = results(await socketTurn(driver, program([
      ["list", { operation: "list" }],
      ["status", { operation: "status", session_id: target }],
      ["submit", { operation: "submit", session_id: target, turn_id: first, input: "TARGET_PROMPT restart design agents" }],
      ["replay", { operation: "submit", session_id: target, turn_id: first, input: "TARGET_PROMPT restart design agents" }],
      ["conflict", { operation: "submit", session_id: target, turn_id: first, input: "TARGET_PROMPT different input" }],
      ["self", { operation: "submit", session_id: driver, turn_id: "self-" + crypto.randomUUID(), input: "loop" }],
      ["self_status", { operation: "status", session_id: driver }],
      ["foreign_status", { operation: "status", session_id: foreign }],
      ["foreign_submit", { operation: "submit", session_id: foreign, turn_id: "foreign-" + crypto.randomUUID(), input: "BOB_SHOULD_NOT_SEE" }],
      ["invalid", { operation: "submit", session_id: target, turn_id: "bad id", input: "x" }],
    ])));
    record({ kind: "phase", phase: "inspect_submit_replay_denials", results: phase1 });
    assert.ok(phase1.list.ok, JSON.stringify(phase1.list));
    const listed = phase1.list.value.data;
    assert.deepEqual(listed.map(row => row.session_id).sort(), [driver, target].sort(), "only owned sessions are listed");
    assert.equal(listed.find(row => row.session_id === driver).current, true);
    assert.equal(phase1.status.value.session_id, target);
    assert.equal(phase1.status.value.accepted_turns, before.accepted_turns);
    assert.equal(phase1.submit.ok, true, JSON.stringify(phase1.submit));
    assert.equal(phase1.submit.value.created, true);
    assert.equal(phase1.submit.value.turn_id, first);
    assert.equal(phase1.replay.ok, true, JSON.stringify(phase1.replay));
    assert.equal(phase1.replay.value.created, false, "identical replay must not admit a second turn");
    assert.equal(phase1.replay.value.turn_id, first);
    assert.equal(phase1.conflict.ok, false);
    assert.match(phase1.conflict.error, /HTTP 409/);
    assert.equal(phase1.self.ok, false);
    assert.match(phase1.self.error, /current session/);
    assert.equal(phase1.self_status.ok, true, "reading the current session is allowed");
    assert.equal(phase1.foreign_status.ok, false);
    assert.match(phase1.foreign_status.error, /not found/);
    assert.equal(phase1.foreign_submit.ok, false);
    assert.match(phase1.foreign_submit.error, /not found/);
    assert.equal(phase1.invalid.ok, false);
    const firstTurn = await settled(target, first);
    assert.equal(firstTurn.state, "completed", JSON.stringify(firstTurn));
    const afterFirst = await call("alice", `/v1/agents/${target}`);
    assert.equal(afterFirst.accepted_turns, before.accepted_turns + 1, "exactly one admitted turn");
    const bobHistory = JSON.stringify(await call("bob", `/v1/agents/${foreign}/events/history`));
    assert.doesNotMatch(bobHistory, /BOB_SHOULD_NOT_SEE/);
    assert.equal((await call("bob", `/v1/agents/${foreign}`)).accepted_turns, 0);

    // 2. Read the completed turn and its events, then steer an active turn.
    const slow = "design-slow-" + crypto.randomUUID(), message = "steer-" + crypto.randomUUID();
    const phase2 = results(await socketTurn(driver, program([
      ["turn", { operation: "turn", session_id: target, turn_id: first }],
      ["events", { operation: "events", session_id: target, limit: 100 }],
      ["slow", { operation: "submit", session_id: target, turn_id: slow, input: "SLOW_TARGET keep working" }],
      ["steer", { operation: "steer", session_id: target, turn_id: slow, message_id: message, input: "STEER_TEXT also restart reviewers" }],
      ["steer_replay", { operation: "steer", session_id: target, turn_id: slow, message_id: message, input: "STEER_TEXT also restart reviewers" }],
      ["steer_receipt", { operation: "turn", session_id: target, turn_id: slow, message_id: message }],
      ["steer_conflict", { operation: "steer", session_id: target, turn_id: slow, message_id: message, input: "STEER_TEXT changed" }],
    ])));
    record({ kind: "phase", phase: "turn_events_steer", results: phase2 });
    assert.equal(phase2.turn.value.state, "completed", JSON.stringify(phase2.turn));
    assert.match(JSON.stringify(phase2.turn.value.input), /TARGET_PROMPT restart design agents/);
    assert.ok(phase2.events.ok, JSON.stringify(phase2.events));
    assert.match(JSON.stringify(phase2.events.value.data), /JOURNEY_DONE/);
    assert.ok(phase2.events.value.last_cursor);
    assert.equal(phase2.slow.value.created, true, JSON.stringify(phase2.slow));
    assert.equal(phase2.steer.ok, true, JSON.stringify(phase2.steer));
    assert.equal(phase2.steer_replay.ok, true, JSON.stringify(phase2.steer_replay));
    assert.equal(phase2.steer_receipt.value.state, "accepted", JSON.stringify(phase2.steer_receipt));
    assert.equal(phase2.steer_conflict.ok, false, JSON.stringify(phase2.steer_conflict));
    const slowTurn = await settled(target, slow);
    assert.equal(slowTurn.state, "completed", JSON.stringify(slowTurn));
    const targetHistory = JSON.stringify(await call("alice", `/v1/agents/${target}/events/history?limit=256`));
    assert.equal(targetHistory.match(/STEER_TEXT also restart reviewers/g)?.length >= 1, true, "steer reached the target");
    assert.match(targetHistory, /STEERED_REPLY/);
    const newer = results(await socketTurn(driver, program([
      ["newer", { operation: "events", session_id: target, after: String(phase2.events.value.last_cursor) }],
    ])));
    assert.match(JSON.stringify(newer.newer.value.data), /STEERED_REPLY/);
    assert.doesNotMatch(JSON.stringify(newer.newer.value.data), /TARGET_PROMPT restart design agents/);

    // 3. A turn without agents:read cannot use the tool at all.
    const denied = "denied-" + crypto.randomUUID();
    await call("aliceNoRead", `/v1/agents/${driver}/turns`, "POST", { id: denied, input: program([
      ["list", { operation: "list" }],
      ["submit", { operation: "submit", session_id: target, turn_id: "denied-submit-" + crypto.randomUUID(), input: "TARGET_DENIED" }],
    ]) }, 202);
    assert.equal((await settled(driver, denied)).state, "completed");
    const driverHistory = JSON.stringify(await call("alice", `/v1/agents/${driver}/events/history?limit=256`));
    assert.match(driverHistory, /requires current direct account root authorization with agents:read, tools:use/);
    assert.doesNotMatch(JSON.stringify(await call("alice", `/v1/agents/${target}/events/history?limit=256`)), /TARGET_DENIED/);
    const final = await call("alice", `/v1/agents/${target}`);
    assert.equal(final.accepted_turns, before.accepted_turns + 2, "only the two authorized turns reached the target");
    record({ kind: "summary", driver, target, foreign, admitted_turns: [first, slow], steer_message: message, denied_turn: denied });
    console.log(JSON.stringify({ evidence, driver, target, admitted: [first, slow], steered: message }));
  } finally {
    for (const socket of sockets) socket.terminate();
    await writeFile(join(evidence, "trace.json"), JSON.stringify({ command: "pnpm --filter nanocodex-managed-service run test:session-control", provenance, trace }, null, 2) + "\n");
    await writeFile(join(evidence, "runtime.log"), logs.join("\n") + "\n");
    await mf.dispose();
  }
});
