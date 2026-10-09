// Run after pnpm --filter nanocodex-vite build:wasm:
// node --test js/nanocodex/test/subagent-shutdown-race.test.mjs
// Public SDK operations and real Rust/WASM against synthetic Responses HTTP.
// The internal host lifecycle observer is needed because generic SDK clients
// do not expose release reasons; the managed journey covers durable SQL effects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Agent, Subagents, Transport } from '../host/index.mjs';

test('explicit child close overlapping root shutdown releases only that child permanently', { timeout: 30_000 }, async () => {
  const module = await WebAssembly.compile(await readFile(new URL('../pkg-web/nanocodex_bg.wasm', import.meta.url)));
  const trace = [], releases = [], bindings = new Map(), started = new Map();
  const errors = [];
  let callId = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer synthetic-close-race');
      const definitions = [...(body.tools ?? []), ...body.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools)];
      const tool = definitions.find(def => def.name === 'hold' || def.description?.startsWith('hold\n'));
      assert.ok(tool, 'child receives the blocking host tool');
      trace.push({ type: 'model_request', model: body.model });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
        id: `response-${++callId}`, status: 'completed',
        output: [{ type: 'function_call', call_id: `hold-${callId}`, name: tool.name, arguments: '{}' }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } })}\n\n`);
    } catch (error) { errors.push(String(error)); response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await Agent.create({
    module, model: 'gpt-6.1-sol', thinking: 'low', toolMode: 'direct',
    transport: Transport.openAi({ apiKey: 'synthetic-close-race', apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, stateless: true }),
    tools: [{ name: 'hold', description: 'Wait for cancellation', parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler(_input, context) {
        const id = String(context.subagent.agentId);
        trace.push({ type: 'tool_started', id });
        started.get(id).resolve();
        return new Promise(resolve => context.signal.addEventListener('abort', () => {
          trace.push({ type: 'tool_aborted', id });
          resolve('ABORTED');
        }, { once: true }));
      },
    }],
    [Symbol.for('nanocodex.browser.internalRuntime')]: { subagentSessions: {
      bind(sessionId, descriptor) {
        bindings.set(String(descriptor.agentId), sessionId);
        if (!started.has(String(descriptor.agentId))) started.set(String(descriptor.agentId), Promise.withResolvers());
      },
      release(sessionId, _context, options) {
        releases.push({ sessionId, detach: options?.detach === true });
      },
    } },
  });
  let shutdown;
  try {
    const explicit = await Subagents.spawn(root, { role: 'explicit close', task: 'Call hold.', outputSchema: { type: 'string' } });
    await started.get(String(explicit.agent_id)).promise;
    const detached = await Subagents.spawn(root, { role: 'root teardown', task: 'Call hold.', outputSchema: { type: 'string' } });
    await started.get(String(detached.agent_id)).promise;
    // Do not await close: root teardown must overlap its resource drain.
    const closing = Subagents.close(root, explicit.agent_id);
    shutdown = root.session.shutdown();
    const closed = await closing;
    await shutdown;
    assert.equal(closed.agents.find(agent => agent.agent_id === explicit.agent_id).status.state, 'closed');
    assert.deepEqual(releases.filter(row => row.sessionId === bindings.get(String(explicit.agent_id))), [
      { sessionId: bindings.get(String(explicit.agent_id)), detach: false },
    ]);
    assert.deepEqual(releases.filter(row => row.sessionId === bindings.get(String(detached.agent_id))), [
      { sessionId: bindings.get(String(detached.agent_id)), detach: true },
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await (shutdown ?? root.session.shutdown());
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const output = new URL('../../../output/subagent-shutdown-race/', import.meta.url);
    await mkdir(output, { recursive: true });
    await writeFile(new URL('trace.json', output), JSON.stringify({
      command: 'node --test js/nanocodex/test/subagent-shutdown-race.test.mjs',
      expected: 'overlapping explicit close releases its binding permanently once; sibling shutdown detaches once',
      releases, trace, errors,
    }, null, 2));
  }
});
