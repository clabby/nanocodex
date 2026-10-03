import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

// The production SessionModelEgress handler runs inside workerd. Only external
// credential/provider services are fixtures; RPC, fetch, upgrades, frames, and
// reportChatGptLimit's deadline all use their real transports.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repository = resolve(packageDirectory, "../..");
const output = join(repository, "output/egress-chatgpt-failover-journey", `${Date.now()}-${process.pid}`);
const owner = "11111111-1111-4111-8111-111111111111";
const subject = `managed-session-v1_${"a".repeat(64)}`;
const createFrame = { type: "response.create", input: [{ type: "message", role: "user",
  content: [{ type: "input_text", text: "synthetic hello" }] }] };
let gateway;

before(async () => {
  await mkdir(output, { recursive: true });
  const bundle = await build({
    stdin: {
      contents: `import { SessionModelEgress } from ${JSON.stringify(join(packageDirectory, "src/egress.ts"))};
      export default { fetch(request, env, ctx) {
        const adapter = { ...env, USER_CREDENTIALS: { getByName: () => ({
          resolveModelCredential: (...args) => env.BROKER.resolveModelCredential(...args),
          // A broken external binding may ignore cancellation. The caller must
          // still bound both its request and response-body wait.
          fetch: (url, init) => env.BROKER.fetch(new Request(url, {
            ...init, signal: new AbortController().signal,
          })),
        }) }, CHATGPT_EGRESS: { idFromName: name => name, get: () => env.PROVIDER } };
        return new SessionModelEgress(ctx, adapter).fetch(request);
      } };`,
      resolveDir: packageDirectory,
    },
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    external: ["cloudflare:*"], logLevel: "warning",
    alias: { "node-rsa": join(repository, "js/nanocodex/tools/browser/unsupportedNodeRsa.mjs") },
  });
  gateway = bundle.outputFiles[0].text;
});

const broker = `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class FixtureBroker extends WorkerEntrypoint {
  async resolveModelCredential(recover, revision, accountId) {
    const response = await this.env.CONTROL.fetch('https://fixture.internal/credential', {
      method: 'POST', body: JSON.stringify({ recover, revision, accountId }),
    });
    return response.json();
  }
  fetch(request) { return this.env.CONTROL.fetch(request); }
}`;

const provider = `export default { async fetch(request, env) {
  const configuration = await (await env.CONTROL.fetch('https://fixture.internal/provider', {
    method: 'POST', body: JSON.stringify({ account: request.headers.get('chatgpt-account-id') }),
  })).json();
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener('close', () => server.close(1000, 'fixture close acknowledged'));
  server.addEventListener('message', async event => {
    const frame = JSON.parse(event.data);
    if (frame.type === 'fixture.finish') { server.close(1000, 'fixture finished'); return; }
    await env.CONTROL.fetch('https://fixture.internal/create', {
      method: 'POST', body: JSON.stringify({ account: configuration.account, frame }),
    });
    if (configuration.partial) server.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }));
    if (configuration.quota) {
      server.send(JSON.stringify({ type: 'error', error: { code: 'usage_limit_reached' } }));
      if (configuration.close) server.close(1000, 'fixture provider ended');
    } else server.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_synthetic_backup', output: [] } }));
  });
  return new Response(null, { status: 101, webSocket: client });
} };`;

function within(promise, milliseconds, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} exceeded ${milliseconds}ms`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function fixture(t, { mode = "stalled", partial = false, pinned = false } = {}) {
  const trace = [];
  const peers = [];
  let selected = "synthetic-primary", release, reportStarted, bodyController;
  let reportingReleased = false;
  const gate = new Promise(resolve => { release = resolve; });
  const reporting = new Promise(resolve => { reportStarted = resolve; });
  const record = (kind, value) => trace.push({ kind, ...value, elapsed_ms: Math.round(performance.now() - began) });
  const began = performance.now();
  const control = async request => {
    const pathname = new URL(request.url).pathname;
    const body = await request.json();
    if (pathname === "/credential") {
      record("credential", { account: selected, ...body });
      return Response.json({ status: 200, credential: { kind: "chatgpt", revision: 1,
        secret: `synthetic-${selected}`, accountId: selected } });
    }
    if (pathname === "/provider") {
      record("upgrade", body);
      return Response.json({ account: body.account, partial, quota: mode !== "recovery" || body.account === "synthetic-primary",
        close: mode !== "recovery" });
    }
    if (pathname === "/create") { record("create", body); return new Response(null, { status: 204 }); }
    assert.equal(pathname, "/v1/chatgpt/limit", "unexpected fixture request");
    record("report", body);
    reportStarted();
    if (mode === "recovery") {
      selected = "synthetic-backup";
      return Response.json({ available: true });
    }
    if (mode === "malformed") return new Response("synthetic invalid JSON", { status: 200 });
    if (mode === "body") return new Response(new ReadableStream({ start(controller) {
      bodyController = controller;
      controller.enqueue(new TextEncoder().encode('{"available":'));
    } }), { status: 200 });
    await gate;
    return Response.json({ available: false });
  };
  const runtime = { modules: true, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"] };
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { ...runtime, name: "gateway", script: gateway, serviceBindings: { BROKER: "broker", PROVIDER: "provider" } },
    { ...runtime, name: "broker", script: broker, serviceBindings: { CONTROL: control } },
    { ...runtime, name: "provider", script: provider, serviceBindings: { CONTROL: control } },
  ] }));
  const releaseReporting = () => {
    if (reportingReleased) return;
    reportingReleased = true;
    record("release", {});
    release();
    if (bodyController) {
      try { bodyController.enqueue(new TextEncoder().encode("false}")); bodyController.close(); } catch { /* Caller canceled its body. */ }
    }
  };
  t.after(async () => {
    releaseReporting();
    try {
      for (const peer of peers) if (peer.socket.readyState === 1) peer.socket.send(JSON.stringify({ type: "fixture.finish" }));
      await within(Promise.all(peers.map(peer => peer.closed)), 2000, "fixture provider shutdown");
    } finally {
      await mf.dispose();
      await writeFile(join(output, `${t.name.replaceAll(/[^a-z0-9]+/gi, "-")}.json`), JSON.stringify({
        command: "node --test js/egress/test/chatgpt-failover-journey.test.mjs", mode, partial, pinned, trace,
      }, null, 2) + "\n");
      t.diagnostic(`Transport transcript: ${output}`);
    }
  });
  async function connect() {
    const response = await mf.dispatchFetch("https://nanocodex.internal/v1/responses", { headers: {
      upgrade: "websocket", authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
      "openai-beta": "responses_websockets=2026-02-06", "x-nanocodex-subject": subject,
      "x-nanocodex-session-model-owner": owner,
      ...(pinned ? { "x-nanocodex-chatgpt-account-id": "synthetic-primary" } : {}),
    } });
    assert.equal(response.status, 101, `model upgrade rejected: ${response.status}`);
    const egressRequestId = response.headers.get("x-nanocodex-egress-request-id");
    assert.match(egressRequestId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    record("gateway_upgrade", { egress_request_id: egressRequestId });
    const socket = response.webSocket;
    socket.accept();
    let error, completed, closed;
    const peer = { socket, frames: [], error: new Promise(resolve => { error = resolve; }),
      completed: new Promise(resolve => { completed = resolve; }), closed: new Promise(resolve => { closed = resolve; }) };
    peers.push(peer);
    socket.addEventListener("message", event => {
      const frame = JSON.parse(event.data);
      peer.frames.push(frame);
      record("frame", { peer: peers.indexOf(peer), frame });
      if (frame.type === "error") error(frame);
      if (frame.type === "response.completed") completed(frame);
    });
    socket.addEventListener("close", event => {
      record("close", { peer: peers.indexOf(peer), code: event.code });
      closed(event);
    });
    socket.send(JSON.stringify(createFrame));
    return peer;
  }
  return { connect, reporting, releaseReporting, trace, reportingReleased: () => reportingReleased };
}

for (const mode of ["stalled", "malformed"]) test(`partial output preserves quota and provider close with ${mode} bookkeeping`, { timeout: 15_000 }, async t => {
  const f = await fixture(t, { mode, partial: true });
  const peer = await f.connect();
  const error = await within(peer.error, 1500, "original quota frame after partial output");
  assert.equal(error.error.code, "usage_limit_reached");
  assert.equal(peer.frames[0].type, "response.output_text.delta");
  assert.equal((await within(peer.closed, 1500, "provider close after partial output")).code, 1000);
  await within(f.reporting, 1500, "limit reporting invocation");
  assert.equal(f.reportingReleased(), false);
});

test("pinned quota before output is forwarded while bookkeeping remains pending", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { pinned: true });
  const peer = await f.connect();
  assert.equal((await within(peer.error, 1500, "pinned provider quota frame")).error.code, "usage_limit_reached");
  assert.equal((await within(peer.closed, 1500, "pinned provider close")).code, 1000);
  await within(f.reporting, 1500, "pinned limit reporting");
  assert.equal(f.trace.find(event => event.kind === "report").select, false);
  assert.equal(f.reportingReleased(), false);
});

for (const mode of ["stalled", "body"]) test(`eligible quota before output bounds unfinished broker ${mode === "body" ? "body" : "fetch"}`, { timeout: 15_000 }, async t => {
  const f = await fixture(t, { mode });
  const peer = await f.connect();
  await within(f.reporting, 1500, "limit reporting invocation");
  const began = performance.now();
  assert.equal((await within(peer.error, 7500, "five-second limit-report deadline")).error.code, "usage_limit_reached");
  const elapsed = performance.now() - began;
  assert.ok(elapsed >= 4000 && elapsed < 7500, `expected bounded five-second decision; observed ${Math.round(elapsed)}ms`);
  assert.equal((await within(peer.closed, 1500, "provider close after deadline")).code, 1000);
  assert.equal(f.reportingReleased(), false, "client recovery depended on finishing broker work");
  t.diagnostic(`Original quota and provider close recovered after ${Math.round(elapsed)}ms while broker remained pending`);
});

test("successful account failover requests recovery and a full-history reconnect completes", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { mode: "recovery" });
  const first = await f.connect();
  const recovery = await within(first.error, 1500, "account-switch recovery frame");
  assert.equal(recovery.error.code, "server_error");
  assert.equal(recovery.error.retry_after, 0);
  assert.equal((await within(first.closed, 1500, "account-switch close")).code, 1012);
  const second = await f.connect();
  assert.equal((await within(second.completed, 1500, "backup-account model completion")).response.id, "resp_synthetic_backup");
  assert.deepEqual(f.trace.filter(event => event.kind === "upgrade").map(event => event.account), ["synthetic-primary", "synthetic-backup"]);
  assert.deepEqual(f.trace.filter(event => event.kind === "create").map(event => event.frame), [createFrame, createFrame]);
});
