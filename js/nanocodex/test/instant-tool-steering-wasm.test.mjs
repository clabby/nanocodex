import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Agent, Transport } from '../host/index.mjs';
import { toolResult } from '../../nanocodex-tools/runtime/code-runtime.mjs';
import { createWorkerEvaluator } from '../runtime/worker-evaluator.mjs';
import { NodeWebWorker } from './support/node-web-worker.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not preempt the foreground observation`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
// Admission is setup, not observation preemption: no steer exists yet. Cold
// WASM/model dispatch and module Worker startup share the test's 30s deadline.
// Surface a real turn failure immediately instead of reporting it as latency.
async function admitted(promise, result, signal, label) {
  let onAbort;
  try {
    return await Promise.race([
      promise,
      result.then(() => { throw new Error(`${label} was never admitted before the turn finished`); }),
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("test cancelled"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
function response(index, output, endTurn = false) {
  const event = { type: 'response.completed', response: {
    id: `preempt-response-${index}`, status: 'completed', end_turn: endTurn,
    output, usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
  } };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

// Full public SDK -> Rust/WASM turn.steer -> imported host ABI -> retained JS
// cell. HTTP/SSE is fixture-only: no real provider, credential or socket is used.
test('real WASM instantToolSteering preempts exec and wait without repeating a pending write', { timeout: 30000 }, async (t) => {
  const module = await readFile(new URL('../pkg-web/nanocodex_bg.wasm', import.meta.url));
  const writeStarted = deferred();
  const releaseWrite = deferred();
  const execPreempted = deferred();
  const waitStarted = deferred();
  const waitPreempted = deferred();
  const events = [];
  let requests = 0;
  let writes = 0;
  let writeSignal;
  let id;
  const yieldedOutput = (request, callId, type) => {
    const result = request.input.filter(item => item.type === type && item.call_id === callId).at(-1);
    assert.ok(result, `missing ${callId} output: ${JSON.stringify(request.input)}`);
    return JSON.stringify(result.output);
  };
  const agent = await Agent.create({
    module, model: 'gpt-6-astra', thinking: 'low', rawApiEvents: false,
    instantToolSteering: true, mcp: false,
    codeEvaluator: createWorkerEvaluator({ createWorker: () => new NodeWebWorker(new URL('../runtime/code-evaluator.worker.mjs', import.meta.url)) }),
    tools: { write: { description: 'Perform one gated fixture write', parameters: { type: 'object' },
      async handler(_input, context) {
        writes++;
        writeSignal = context.signal;
        writeStarted.resolve();
        await releaseWrite.promise;
        return toolResult('write accepted', { accepted: true }, { metadata: { request_id: 'sdk-preempt' } });
      },
    } },
    transport: Transport.hostManaged({ stateless: true, websocketPreconnect: false,
      apiBaseUrl: 'https://provider.invalid/v1',
      createWebSocket() { assert.fail('fixture must never use a WebSocket'); },
      async createResponse(_endpoint, _session, request) {
        const input = JSON.parse(request.body);
        requests++;
        assert.equal(input.previous_response_id, undefined);
        if (requests === 1) return response(1, [{ type: 'custom_tool_call', name: 'exec', call_id: 'exec-origin',
          input: `text('before write'); await tools.write({}); text('after write');` }]);
        if (requests === 2) {
          const output = yieldedOutput(input, 'exec-origin', 'custom_tool_call_output');
          id = output.match(/Script running with cell ID ([^\\\s"]+)/)?.[1];
          assert.ok(id, output);
          assert.match(output, /before write/);
          assert.match(JSON.stringify(input.input), /STEER_EXEC/);
          assert.equal(writeSignal.aborted, false);
          assert.equal(writes, 1);
          execPreempted.resolve();
          return response(2, [{ type: 'function_call', name: 'wait', call_id: 'wait-first', arguments: JSON.stringify({ cell_id: id }) }]);
        }
        if (requests === 3) {
          const output = yieldedOutput(input, 'wait-first', 'function_call_output');
          assert.match(output, new RegExp(`Script running with cell ID ${id}`));
          assert.doesNotMatch(output, /before write/);
          assert.match(JSON.stringify(input.input), /STEER_WAIT/);
          assert.equal(writeSignal.aborted, false);
          assert.equal(writes, 1);
          waitPreempted.resolve();
          releaseWrite.resolve();
          return response(3, [{ type: 'function_call', name: 'wait', call_id: 'wait-final', arguments: JSON.stringify({ cell_id: id }) }]);
        }
        assert.equal(requests, 4);
        const output = yieldedOutput(input, 'wait-final', 'function_call_output');
        assert.match(output, /Script completed/);
        assert.match(output, /after write/);
        assert.equal(writes, 1);
        return response(4, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'STEERING_OK' }] }], true);
      },
    }),
  });
  const stop = agent.events.watch().onEvent(event => {
    events.push(event);
    if (event.type === 'tool.call' && event.payload.tool === 'wait' && event.payload.call_id === 'wait-first') waitStarted.resolve();
  });
  const promptStartedAt = performance.now();
  const turn = agent.turn.prompt({ input: 'Run one write and wait for its receipt.' });
  const result = turn.result();
  void result.catch(() => {});
  try {
    await admitted(writeStarted.promise, result, t.signal, 'write');
    const writeAdmittedAt = performance.now();
    await within((async () => {
      await turn.steer({ input: 'STEER_EXEC: keep the pending write running.', messageId: 'exec-steer' });
      await execPreempted.promise;
    })(), 'exec steering');
    const execPreemptedAt = performance.now();
    await admitted(waitStarted.promise, result, t.signal, 'wait');
    // Outer tool.call precedes host wait registration. Let that dispatch reach
    // the host without relying on a future/sticky preemption flag.
    await new Promise(resolve => setTimeout(resolve, 0));
    const waitSteeredAt = performance.now();
    await within((async () => {
      await turn.steer({ input: 'STEER_WAIT: preserve the same cell.', messageId: 'wait-steer' });
      await waitPreempted.promise;
    })(), 'wait steering');
    const waitPreemptedAt = performance.now();
    assert.equal((await result).finalMessage, 'STEERING_OK');
    assert.equal(requests, 4);
    assert.equal(writes, 1);
    const starts = events.filter(event => event.type === 'tool.call' && event.payload.tool === 'write');
    const receipts = events.filter(event => event.type === 'tool.result' && event.payload.tool === 'write');
    assert.equal(starts.length, 1);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].payload.call_id, starts[0].payload.call_id);
    assert.equal(receipts[0].payload.status, 'completed');
    assert.deepEqual(receipts[0].payload.structured_result, { accepted: true });
    assert.deepEqual(receipts[0].payload.metadata, { request_id: 'sdk-preempt' });
    t.diagnostic(JSON.stringify({
      coldAdmissionMs: Math.round(writeAdmittedAt - promptStartedAt),
      execSteeringMs: Math.round(execPreemptedAt - writeAdmittedAt),
      waitSteeringMs: Math.round(waitPreemptedAt - waitSteeredAt),
      requests, writes, writeStarts: starts.length, writeReceipts: receipts.length,
      receiptStatus: receipts[0].payload.status,
      finalMessage: 'STEERING_OK',
    }));
  } finally {
    releaseWrite.resolve();
    stop();
    await turn.cancel().catch(() => {});
    await result.catch(() => {});
    await agent.session.shutdown().catch(() => {});
  }
});
