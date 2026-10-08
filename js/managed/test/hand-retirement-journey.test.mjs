// The CI lifecycle entry point also exercises retained Code Mode work after
// physical owner loss. Keep these journeys selected while the broad suite is paused.
import "./code-observation-workerd-journey.test.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import WebSocket from "ws";
import { createTools } from "nanocodex/tools";
import { createAttachment } from "nanocodex-tools/attachment";
import { createNodeProcessTools } from "nanocodex-tools/node";

// Upgrade journey: an older service admitted a thread-scoped workspace Hand
// and one of its processes. After deploying the candidate, that legacy route
// leaves discovery and routing, yet the exact admitted process can finish on
// its original runtime. New thread-scoped native catalogs fail with a
// migration error; thread tool hosts may still publish non-native tools.
const root = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const owner = "00000000-0000-4000-8000-000000000071";
const thread = "00000000-0000-7000-8000-000000000072";
const organization = "00000000-0000-7000-8000-000000000073";
const team = "00000000-0000-7000-8000-000000000074";
const machine = "synthetic-account-hand";
const legacyMachine = "synthetic-legacy-workspace-hand";
const command = "pnpm --filter nanocodex-managed-service test:hand-retirement";
const baselineRef = process.env.NANOCODEX_RETIREMENT_BASELINE ?? "f8a2b451dabba74cff003d6ec54d32cb06fd113bf";
const scripts = {
  START: `
    const started=await tools.exec_command({cmd:"while [ ! -f legacy.go ]; do sleep 0.05; done; printf LEGACY_PINNED_DONE",workdir:"/${legacyMachine}",shell:"/bin/sh",login:false,yield_time_ms:1});
    if(!started.session_id) throw Error("expected retained native process");
    text({legacy_session:started.session_id});`,
  ENV: `const env=await tools.environment({});text({hands:Object.keys(env.hands)});`,
  RETIRED: `try { text(await tools.exec_command({cmd:"printf MUST_NOT_RUN_ON_RETIRED",workdir:"/${legacyMachine}",shell:"/bin/sh",login:false})); } catch(error) { text({retired:error.message}); }`,
  ACCOUNT: `text(await tools.exec_command({cmd:"printf ACCOUNT_HAND_OK",workdir:"/${machine}",shell:"/bin/sh",login:false}));`,
  POLL: `text(await tools.write_stdin({session_id:__SESSION__,yield_time_ms:5000}));`,
};
const source = `
import { DurableObject } from 'cloudflare:workers';
import { DurableAgentSession, AccountHostedTools } from './src/index.ts';
const info=console.info.bind(console);
console.info=(record,...rest)=>info(record&&typeof record==='object'?JSON.stringify(record):record,...rest);
export class FixtureAccountHostedTools extends AccountHostedTools {}
export class FixtureSession extends DurableAgentSession {
  async fetch(request) {
    if(new URL(request.url).pathname==='/__seed') {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO session_state(singleton,session_id,owner_id,organization_id,team_id,authorization_epoch,public_origin,runtime_profile,last_active) VALUES(1,?,?,?,?,1,'https://fixture.internal/','managed',?)",'${thread}','${owner}','${organization}','${team}',Date.now());
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO managed_configuration VALUES(1,?)",JSON.stringify({environment:{files:[],skills:[],setup_commands:[],network:{access:'enabled'}}}));
      this.ctx.storage.sql.exec("UPDATE managed_agent_settings SET model='gpt-6.1-sol',thinking='low'");
      await this.ctx.storage.sync(); return new Response(null,{status:204});
    }
    return super.fetch(request);
  }
}
export class FixtureModel extends DurableObject {
  async fetch(request) {
    if(request.headers.get('upgrade')!=='websocket') return Response.json({tools:[],machines:[],connections:[]});
    const [client,server]=Object.values(new WebSocketPair()); server.accept(); let scenario='',index=0;
    server.addEventListener('close',()=>server.close(1000));
    server.addEventListener('message',event=>{
      const body=JSON.parse(event.data),latest=JSON.stringify((body.input??[]).filter(item=>item.role==='user').at(-1));
      const next=Object.keys(${JSON.stringify(scripts)}).find(key=>latest?.includes('RETIREMENT_'+key));
      if(next&&next!==scenario) {scenario=next;index=0;} const call=++index;
      const session=/RETIREMENT_POLL_([0-9]+)/.exec(latest??'')?.[1]??'0';
      const outputs=(body.input??[]).filter(item=>item.type==='custom_tool_call_output'||item.type==='function_call_output');
      const output=call===1?[{type:'custom_tool_call',name:'exec',call_id:'call_retirement_'+scenario,input:${JSON.stringify(scripts)}[scenario].replace('__SESSION__',session)}]
        :[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(outputs.at(-1))}]}];
      server.send(JSON.stringify({type:'response.completed',response:{id:'resp_retirement_'+scenario+'_'+call,status:'completed',end_turn:call>1,output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
    }); return new Response(null,{status:101,webSocket:client});
  }
}
export default {fetch(request,env) {
  const url=new URL(request.url),path=url.pathname;
  if(path==='/tool-host') return env.NANOCODEX_ACCOUNT_TOOLS.getByName('${owner}').fetch(new Request('https://account-tools.internal/tool-host',request));
  return env.NANOCODEX_SESSIONS.getByName('fixture-session').fetch(new Request('https://session.internal'+path.replace('/v1/agents/${thread}','')+url.search,request));
}};
`;

async function bundleFor(indexSource) {
  const assets = [];
  const plugins = [{ name: "wasm", setup(builder) { builder.onResolve({ filter: /\.wasm$/ }, async args => {
    const path = join(args.resolveDir, args.path), contents = await readFile(path), name = `fixture-${assets.length}.wasm`;
    assert.ok(path.startsWith(repo)); assets.push({ type: "CompiledWasm", path: name, contents }); return { path: `./${name}`, external: true };
  }); } }];
  if (indexSource !== undefined) plugins.push({ name: "baseline-index", setup(builder) {
    builder.onLoad({ filter: /\/managed\/src\/index\.ts$/ }, () => ({ contents: indexSource, loader: "ts", resolveDir: join(root, "src") }));
  } });
  const bundle = await build({ stdin: { contents: source, resolveDir: root }, bundle: true, write: false, format: "esm", platform: "node", conditions: ["workerd"], target: "es2022",
    banner: { js: 'import { createRequire } from "node:module"; const require=createRequire("/worker.mjs");' }, external: ["cloudflare:*", "node:*"],
    alias: { "nanocodex-tools/internal/hosted-machine": join(repo, "js/nanocodex-tools/tools/hostedMachine.mjs"), "nanocodex-tools/hosted": join(repo, "js/nanocodex-tools/src/hosted/index.ts"), "node-rsa": join(root, "../nanocodex/tools/browser/unsupportedNodeRsa.mjs") },
    plugins, logLevel: "silent" });
  return { code: bundle.outputFiles[0].text, assets };
}

test("deploying single-Hand routing retires a thread workspace Hand without losing its admitted process", { timeout: 120_000 }, async () => {
  const output = join(repo, "output/hand-retirement-journey", `${Date.now()}-${process.pid}`);
  const workspace = join(output, "hand");
  await mkdir(workspace, { recursive: true });
  const runtime = [], wire = [], http = [], turns = {};
  let mf, base, failure;
  const sockets = [];
  const resources = [];
  const start = async ({ code, assets }) => {
    const date = "2026-07-30";
    mf = new Miniflare({ port: 0, handleRuntimeStdio(stdout, stderr) { for (const input of [stdout, stderr]) createInterface({ input }).on("line", line => runtime.push(line)); },
      durableObjectsPersist: join(output, "durable-objects"), workers: [
        { name: "managed", compatibilityDate: date, compatibilityFlags: ["nodejs_compat", "enable_request_signal"], modules: [{ type: "ESModule", path: "worker.mjs", contents: code }, ...assets], bindings: { AGENT_IDLE_TIMEOUT_MS: "60000" },
          durableObjects: { NANOCODEX_SESSIONS: { className: "FixtureSession", useSQLite: true }, NANOCODEX_ACCOUNT_TOOLS: { className: "FixtureAccountHostedTools", useSQLite: true }, MODEL: { className: "FixtureModel", useSQLite: true }, NANOCODEX_MEMORY: { className: "FixtureModel", useSQLite: true } },
          serviceBindings: { NANOCODEX: "provider" }, r2Buckets: ["NANOCODEX_HISTORY", "NANOCODEX_WORKSPACES"] },
        { name: "provider", compatibilityDate: date, modules: true, script: "export default {fetch(request,env){return env.MODEL.getByName('fixture-model').fetch(request)}}", durableObjects: { MODEL: { className: "FixtureModel", scriptName: "managed", useSQLite: true } } }] });
    base = await mf.ready;
  };
  const headers = { "x-nanocodex-owner-id": owner, "x-nanocodex-session-organization-id": organization, "x-nanocodex-session-team-id": team, "x-nanocodex-authorization-epoch": "1", "x-nanocodex-capabilities": JSON.stringify(["agents:read", "agents:write", "tools:use"]), "content-type": "application/json" };
  const request = async (path, init = {}) => {
    const response = await fetch(new URL(path, base), { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(10_000) }), body = await response.text();
    http.push({ path, status: response.status, method: init.method ?? "GET", body });
    return { status: response.status, value: body ? JSON.parse(body) : undefined };
  };
  let number = 100;
  const runTurn = async scenario => {
    const id = `00000000-0000-7000-8000-${String(number++).padStart(12, "0")}`;
    const accepted = await request(`/v1/agents/${thread}/turns`, { method: "POST", body: JSON.stringify({ id, input: `RETIREMENT_${scenario}` }) });
    assert.equal(accepted.status, 202, JSON.stringify(accepted));
    for (let i = 0; i < 1500; i++) {
      const response = await request(`/v1/agents/${thread}/turns/${accepted.value.turn_id}`);
      if (["completed", "failed", "cancelled"].includes(response.value.state)) {
        turns[scenario] = response.value; assert.equal(response.value.state, "completed", JSON.stringify(response.value));
        return JSON.stringify(response.value);
      }
      await delay(10);
    }
    throw new Error(`turn ${scenario} did not finish`);
  };
  // Publishers keep their own process runtime across a service restart; each
  // reconnect resolves the current service origin.
  const publisher = async (path, id, label, extra = {}) => {
    const native = await createNodeProcessTools({ workspace }); const tools = await createTools({ tools: native.tools });
    resources.push(() => tools.close(), () => native.close());
    const attachment = createAttachment(tools, { endpoint: new URL(path, "ws://127.0.0.1").href, transport: { connect() {
      const endpoint = new URL(path, base); endpoint.protocol = "ws:";
      const socket = new WebSocket(endpoint, { headers: path === "/tool-host" ? { "x-nanocodex-owner-id": owner } : headers });
      sockets.push(socket);
      const send = socket.send.bind(socket);
      socket.send = (data, ...args) => { wire.push({ label, direction: "host", frame: JSON.parse(String(data)) }); return send(data, ...args); };
      socket.on("message", data => wire.push({ label, direction: "broker", frame: JSON.parse(String(data)) }));
      socket.on("close", (code, reason) => wire.push({ label, event: "close", code, reason: String(reason) }));
      return socket;
    } } }, { machines: [{ id, name: id, workspace, capabilities: ["shell"] }], attachmentId: id, ...extra });
    resources.unshift(() => attachment.close());
    return attachment;
  };
  const readyCount = label => wire.filter(row => row.label === label && row.direction === "broker" && row.frame.type === "ready").length;
  try {
    const baseline = execFileSync("git", ["show", `${baselineRef}:js/managed/src/index.ts`], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 });
    // NANOCODEX_RETIREMENT_CANDIDATE=<ref> replays the journey against another
    // revision (for example the baseline) to reproduce the pre-fix failure.
    const candidateRef = process.env.NANOCODEX_RETIREMENT_CANDIDATE;
    const candidateSource = candidateRef === undefined ? undefined
      : execFileSync("git", ["show", `${candidateRef}:js/managed/src/index.ts`], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 });
    const [before, candidate] = await Promise.all([bundleFor(baseline), bundleFor(candidateSource)]);

    // 1. The older service admits a thread-scoped workspace Hand and a process.
    await start(before);
    assert.equal((await request("/__seed", { method: "POST" })).status, 204);
    const account = await publisher("/tool-host", machine, "account");
    assert.equal((await account.connect()).connected, true);
    const legacy = await publisher(`/v1/agents/${thread}/tool-host`, legacyMachine, "legacy");
    assert.equal((await legacy.connect()).connected, true);
    const started = JSON.parse(JSON.parse(JSON.parse(await runTurn("START")).terminal.final_message).output.at(-1).text);
    assert.ok(Number.isSafeInteger(started.legacy_session), JSON.stringify(started));

    // 2. Deploy the candidate on the same durable storage. Both publishers
    // reconnect with their original runtimes.
    const legacyReady = readyCount("legacy"), accountReady = readyCount("account");
    await mf.dispose();
    await start(candidate);
    for (let i = 0; i < 1000 && (readyCount("legacy") === legacyReady || readyCount("account") === accountReady); i++) await delay(10);
    assert.ok(readyCount("account") > accountReady, "account Hand reconnects");
    assert.ok(readyCount("legacy") > legacyReady, "the runtime owning an admitted process may reconnect to finish it");

    // 3. Discovery and new routing see only the account Hand.
    const env = await runTurn("ENV");
    assert.match(env, new RegExp(machine));
    assert.doesNotMatch(env, new RegExp(legacyMachine), "retired workspace Hand is not rediscovered");
    const retired = await runTurn("RETIRED");
    assert.doesNotMatch(retired, /MUST_NOT_RUN_ON_RETIRED/);
    assert.match(retired, /retired/);
    assert.match(await runTurn("ACCOUNT"), /ACCOUNT_HAND_OK/);

    // 4. The admitted process finishes on its exact original runtime.
    await writeFile(join(workspace, "legacy.go"), "");
    assert.match(await runTurn(`POLL_${started.legacy_session}`), /LEGACY_PINNED_DONE/);

    // 5. A new thread-scoped native publisher (fresh runtime) is refused with a
    // migration error, while a non-native thread catalog is still admitted.
    const fresh = await publisher(`/v1/agents/${thread}/tool-host`, "synthetic-new-workspace-hand", "fresh");
    await assert.rejects(fresh.connect(), /hand_migration_required/);
    const appEndpoint = new URL(`/v1/agents/${thread}/tool-host`, base); appEndpoint.protocol = "ws:";
    const app = new WebSocket(appEndpoint, { headers }); sockets.push(app);
    await new Promise((resolve, reject) => { app.once("open", resolve); app.once("error", reject); });
    const appReady = new Promise((resolve, reject) => { app.once("message", data => resolve(JSON.parse(String(data)))); app.once("close", (code, reason) => reject(new Error(`${code} ${reason}`))); });
    const appCatalog = { type: "catalog", attachment_id: "synthetic-app-tools", capabilities: ["turn_metadata"], tools: [{ provider: "app", remote_name: "lookup_order", parallel_safe: true, timeout_ms: 15_000,
      definition: { type: "function", name: "lookup_order", description: "Synthetic thread tool", strict: false, parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } }] };
    wire.push({ label: "app", direction: "host", frame: appCatalog }); app.send(JSON.stringify(appCatalog));
    const appFrame = await appReady; wire.push({ label: "app", direction: "broker", frame: appFrame });
    assert.equal(appFrame.type, "ready", JSON.stringify(appFrame));
  } catch (error) { failure = error; throw error; }
  finally {
    for (const socket of sockets) socket.terminate();
    for (const close of resources) await Promise.resolve().then(close).catch(() => {});
    await mf?.dispose().catch(() => {});
    await writeFile(join(output, "evidence.json"), JSON.stringify({ command, baseline: baselineRef,
      expected: "baseline admits thread Hand + process; candidate hides it from discovery/routing, finishes the exact pinned process, rejects new thread native catalogs with hand_migration_required, admits non-native thread tools",
      failure: failure ? String(failure.stack ?? failure) : null, turns, http, wire }, null, 2));
    await writeFile(join(output, "runtime.log"), runtime.join("\n"));
  }
});
