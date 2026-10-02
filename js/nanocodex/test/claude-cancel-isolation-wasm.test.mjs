// Real WASM + loopback Messages: cancelling one turn must not poison another.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Claude } from '../browser/index.mjs';

function sse(block, stop) {
  return [
    { type: 'message_start', message: { id: 'synthetic-response', role: 'assistant', model: 'fixture-model', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('');
}

test('actual WASM cancelling a blocking turn preserves the queued turn host signal', { timeout: 15_000 }, async t => {
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.tools[0].name, 'effect');
    requestCount++;
    const block = requestCount <= 2
      ? { type: 'tool_use', id: `effect-${requestCount}`, name: 'effect', input: { ordinal: requestCount } }
      : { type: 'text', text: 'QUEUED_TURN_OK' };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
    response.end(sse(block, requestCount <= 2 ? 'tool_use' : 'end_turn'));
  });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const observed = [];
  let firstSignal;
  const agent = await Claude.create({
    endpoint: `http://127.0.0.1:${server.address().port}/v1/messages`,
    model: 'fixture-model', auth: { apiKey: 'synthetic-only' },
    module: await readFile(new URL('../pkg-web/nanocodex_bg.wasm', import.meta.url)),
    tools: [{ name: 'effect', description: 'synthetic effect', handler(input, context) {
      observed.push({ ordinal: input.ordinal, aborted: context.signal.aborted });
      if (input.ordinal === 1) { firstSignal = context.signal; firstStarted(); return new Promise(() => {}); }
      return 'queued receipt';
    } }],
  });
  try {
    const first = agent.turn.prompt({ input: 'blocking A' });
    const firstOutcome = first.result().catch(error => error);
    await started;
    const queued = agent.turn.prompt({ input: 'independent queued B' });
    const queuedOutcome = queued.result();
    await first.cancel();
    await firstOutcome;
    assert.equal((await queuedOutcome).finalMessage, 'QUEUED_TURN_OK');
    t.diagnostic(`requests=${requestCount}; handler signals=${JSON.stringify(observed)}; cancelled turn host signal=${firstSignal.aborted}`);
    assert.deepEqual(observed, [{ ordinal: 1, aborted: false }, { ordinal: 2, aborted: false }], 'the independent queued turn was never cancelled');
    assert.equal(firstSignal.aborted, true, 'the cancelled active handler must receive its own abort signal');
  } finally { await agent.session.shutdown(); }
});

// Detach is not cancellation. These use an actual disk store and generated WASM,
// not a fake lifecycle: host/auth routes must survive until the receipt commits.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteDurabilityStore, sqliteDurabilitySchema } from '../runtime/durability-store.mjs';

function database(path) {
  const db = new DatabaseSync(path);
  sqliteDurabilitySchema.forEach(sql => db.exec(sql));
  const store = createSqliteDurabilityStore({ transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback((sql, params = []) => {
        const statement = db.prepare(sql);
        return /^\s*(SELECT|WITH)\b/i.test(sql) ? statement.all(...params).map(row => ({ ...row })) : (statement.run(...params), []);
      });
      assert.equal(typeof value?.then, 'undefined');
      db.exec('COMMIT'); return value;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } });
  return { store, close: () => db.close(), persisted: () => JSON.stringify([
    ...db.prepare('SELECT payload FROM nanocodex_durable_states').all(),
    ...db.prepare('SELECT value FROM nanocodex_durable_records').all(),
  ]) };
}

for (const target of ['node', 'browser']) {
  for (const held of ['tool', 'model']) {
    test(`actual ${target} WASM dispose during held ${held} retains execution and disk terminal replay`, { timeout: 15_000 }, async t => {
      const SDK = target === 'browser' ? Claude : (await import('../node/index.mjs')).Claude;
      const directory = await mkdtemp(join(tmpdir(), 'nanoclaude-detach-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const path = join(directory, 'state.sqlite');
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      const requests = [];
      const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
        if (held === 'model' && requests.length === 1) { started.resolve(); await release.promise; }
        const useTool = held === 'tool' && requests.length === 1;
        response.end(sse(useTool ? { type: 'tool_use', id: 'effect-once', name: 'effect', input: {} }
          : { type: 'text', text: 'DETACHED_RECEIPT' }, useTool ? 'tool_use' : 'end_turn'));
      });
      const sockets = new Set();
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
      let effects = 0;
      let authCalls = 0;
      let signal;
      const tool = { name: 'effect', description: 'Synthetic held effect', strict: true, deferLoading: false,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: async (_input, context) => {
          effects++; signal = context.signal; started.resolve(); await release.promise;
          assert.equal(signal.aborted, false, 'detaching must not abort accepted execution');
          return 'persisted effect receipt';
        } };
      const options = {
        endpoint: `http://127.0.0.1:${server.address().port}/v1/messages`, model: 'fixture-model',
        ...(target === 'browser' ? { module: await readFile(new URL('../pkg-web/nanocodex_bg.wasm', import.meta.url)) } : {}),
        auth: { headers: () => { authCalls++; return { 'x-api-key': 'synthetic-only' }; } },
        tools: [tool], durabilityId: `detach-${target}-${held}`,
      };
      let disk = database(path);
      let agent;
      try {
        agent = await SDK.create({ ...options, durability: disk.store });
        const turn = agent.turn.prompt({ input: 'complete accepted effect', id: 'detach-request' });
        assert.equal(await turn.accepted(), 'detach-request');
        await started.promise;
        agent.dispose(); agent.dispose(); agent = undefined;
        // No caller result waiter before detach: runtime observation must be proactive.
        if (signal) assert.equal(signal.aborted, false);
        release.resolve();
        const result = await turn.result();
        assert.equal(result.finalMessage, 'DETACHED_RECEIPT');
        assert.equal(requests.length, held === 'tool' ? 2 : 1);
        assert.equal(requests[0].tools[0].strict, true);
        assert.equal(requests[0].tools[0].defer_loading ?? false, false, 'native serialization omits the default false flag');
        assert.match(disk.persisted(), /DETACHED_RECEIPT/);
        if (held === 'tool') assert.match(disk.persisted(), /persisted effect receipt/);
        assert.doesNotMatch(disk.persisted(), /synthetic-only|x-api-key/);
        disk.close(); disk = database(path);
        const beforeAuth = authCalls;
        const beforeEffects = effects;
        const beforeRequests = requests.length;
        agent = await SDK.create({ ...options, durability: disk.store,
          auth: { headers: () => { authCalls++; throw new Error('replay must not authenticate'); } },
          tools: [{ ...tool, handler: () => { effects++; throw new Error('replay must not dispatch'); } }],
        });
        const replay = await agent.turn.prompt({ input: 'complete accepted effect', id: 'detach-request' }).result();
        assert.equal(replay.finalMessage, result.finalMessage);
        assert.equal(authCalls, beforeAuth); assert.equal(effects, beforeEffects); assert.equal(requests.length, beforeRequests);
        t.diagnostic(`held=${held}; requests=${requests.length}; effects=${effects}; terminal replay auth/network/tool deltas=0`);
      } finally { release.resolve(); if (agent) await agent.session.shutdown().catch(() => {}); disk.close(); }
    });
  }
}

test('actual WASM cancelling queued anonymous turn does not abort active host invocation', { timeout: 15_000 }, async t => {
  const started = Promise.withResolvers();
  let signal;
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
    response.end(sse({ type: 'tool_use', id: 'active-effect', name: 'effect', input: {} }, 'tool_use'));
  });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const agent = await Claude.create({
    endpoint: `http://127.0.0.1:${server.address().port}/v1/messages`, model: 'fixture-model', auth: { apiKey: 'synthetic-only' },
    module: await readFile(new URL('../pkg-web/nanocodex_bg.wasm', import.meta.url)),
    tools: [{ name: 'effect', description: 'Held synthetic effect', handler(_input, context) {
      signal = context.signal; started.resolve(); return new Promise(() => {});
    } }],
  });
  try {
    const active = agent.turn.prompt({ input: 'hold A' });
    await started.promise;
    const queued = agent.turn.prompt({ input: 'cancel queued B only' });
    await queued.cancel();
    await assert.rejects(queued.result(), /cancel/i);
    assert.equal(signal.aborted, false, 'queued cancellation must not abort the active signal');
    assert.equal(requests, 1, 'queued cancellation must not dispatch a model request');
    await active.cancel();
    await assert.rejects(active.result(), /cancel/i);
    assert.equal(signal.aborted, true, 'active anonymous turn has its own host abort identity');
  } finally { await agent.session.shutdown(); }
});
