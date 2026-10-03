import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodeRuntime, toolResult } from '../../nanocodex-tools/runtime/code-runtime.mjs';

// Contract: openai/codex 60947e234156ac12bdb7fba2477d3965f166bd34,
// code-mode-protocol/src/session.rs:155-170. Preempt yields an observation;
// termination is a separate operation and the cell remains live for wait.
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function body(result) {
  return typeof result.output === 'string' ? result.output
    : result.output.filter(item => item.type === 'input_text').map(item => item.text).join('\n');
}
function cellId(result) {
  return body(result).match(/Script running with cell ID ([^\s]+)/)?.[1];
}
async function evaluator(kind) {
  if (kind === 'native') return undefined;
  if (kind === 'quickjs') {
    const { default: variant } = await import('@jitl/quickjs-wasmfile-release-asyncify');
    const { newQuickJSAsyncWASMModuleFromVariant } = await import('quickjs-emscripten-core');
    const { createQuickJsEvaluator } = await import('../runtime/quickjs-evaluator.mjs');
    return createQuickJsEvaluator(await newQuickJSAsyncWASMModuleFromVariant(variant));
  }
  const { NodeWebWorker } = await import('./support/node-web-worker.mjs');
  const { createWorkerEvaluator } = await import('../runtime/worker-evaluator.mjs');
  return createWorkerEvaluator({ createWorker: () => new NodeWebWorker(new URL('../runtime/code-evaluator.worker.mjs', import.meta.url)) });
}

for (const kind of ['native', 'quickjs', 'worker']) {
  test(`${kind}: preempt exec and wait preserves writes, output, origin, metadata and nested promises`, { timeout: 15000 }, async () => {
    const started = deferred();
    const release = deferred();
    let writes = 0;
    let toolSignal;
    const runtime = createCodeRuntime({ write: {
      async handler(input, context) {
        writes++;
        toolSignal = context.signal;
        started.resolve();
        await release.promise;
        return toolResult('accepted', { operation: input.operation }, {
          value: { receipt: 'kept' }, metadata: { request_id: 'safe-request', outcome: 'accepted' },
        });
      },
    } }, { evaluate: await evaluator(kind) });
    try {
      runtime.beginTurn('session');
      const executing = runtime.executeCodeObserved(`text('before'); const result = await tools.write({operation:'once'}); store('receipt', result); text('after');`, 'session', 'origin');
      await started.promise;
      assert.equal(runtime.preempt('session', 'origin'), true);
      const first = JSON.parse(await executing);
      const id = cellId(first);
      assert.ok(id, body(first));
      assert.match(body(first), /before/);
      assert.equal(first.cell.origin_call_id, 'origin');
      assert.equal(first.cell.running, true);
      assert.deepEqual(first.nested_calls, []);
      assert.equal(toolSignal.aborted, false, 'preemption must not abort a pending external write');
      const start = JSON.parse(await runtime.nextCodeUpdate('session', 'origin'));
      assert.equal(start.type, 'nested_call_started');
      assert.match(start.call_id, /^origin\/code-/);
      assert.equal(await runtime.nextCodeUpdate('session', 'origin'), null);
      assert.equal(runtime.preempt('session', 'origin'), false, 'closed observers are not preemptible');

      const waiting = runtime.waitCodeObserved(JSON.stringify({ cell_id: id, yield_time_ms: 10000 }), 'session', 'wait-first');
      // Scope is observation admission, including the microtask before observeCell.
      assert.equal(runtime.preempt('session', 'wait-first'), true);
      const second = JSON.parse(await waiting);
      assert.equal(cellId(second), id);
      assert.equal(second.cell.origin_call_id, 'origin');
      assert.doesNotMatch(body(second), /before/, 'output must not be replayed');
      assert.equal(toolSignal.aborted, false);

      const finalWait = runtime.waitCodeObserved(JSON.stringify({ cell_id: id }), 'session', 'wait-final');
      release.resolve();
      const final = JSON.parse(await finalWait);
      assert.match(body(final), /Script completed/);
      assert.match(body(final), /after/);
      assert.equal(final.cell.running, false);
      assert.equal(final.cell.origin_call_id, 'origin');
      assert.equal(final.nested_calls.length, 1);
      const receipt = final.nested_calls[0];
      assert.equal(receipt.call_id, start.call_id);
      assert.equal(receipt.success, true);
      assert.deepEqual(receipt.structured_result, { operation: 'once' });
      assert.deepEqual(receipt.metadata, { request_id: 'safe-request', outcome: 'accepted' });
      assert.equal(writes, 1);
      const completion = JSON.parse(await runtime.nextCodeUpdate('session', 'wait-final'));
      assert.equal(completion.type, 'nested_call_completed');
      assert.equal(completion.call.call_id, start.call_id);
      assert.deepEqual(completion.call.metadata, receipt.metadata);
      assert.equal(await runtime.nextCodeUpdate('session', 'wait-final'), null);
      const stored = JSON.parse(await runtime.executeCode(`text(load('receipt'));`, 'session'));
      assert.match(body(stored), /kept/);
    } finally { release.resolve(); runtime.reset(); }
  });

  test(`${kind}: preempt before cell observation starts and completion racing preempt stays recoverable`, { timeout: 15000 }, async () => {
    const started = deferred();
    const release = deferred();
    let calls = 0;
    const runtime = createCodeRuntime({ once: { async handler() {
      calls++;
      started.resolve();
      await release.promise;
      return toolResult('done', { done: true }, { metadata: { request_id: 'race' } });
    } } }, { evaluate: await evaluator(kind) });
    try {
      const pending = runtime.executeCodeObserved(`await tools.once({}); text('done');`, 'race', 'exec-race');
      assert.equal(runtime.preempt('race', 'exec-race'), true);
      const initial = JSON.parse(await pending);
      const id = cellId(initial);
      assert.ok(id);
      await started.promise;
      const waiting = runtime.waitCodeObserved(JSON.stringify({ cell_id: id }), 'race', 'wait-race');
      release.resolve();
      assert.equal(runtime.preempt('race', 'wait-race'), true);
      const raced = JSON.parse(await waiting);
      const final = raced.cell.running
        ? JSON.parse(await runtime.waitCodeObserved(JSON.stringify({ cell_id: id }), 'race', 'wait-done'))
        : raced;
      assert.equal(final.cell.running, false);
      assert.match(body(final), /Script completed/);
      assert.equal(final.nested_calls.length + (raced === final ? 0 : raced.nested_calls.length), 1);
      assert.equal(calls, 1);
      assert.equal(runtime.preempt('race', 'wait-race'), false);
      assert.equal(runtime.preemptTurn('race'), 0);
    } finally { release.resolve(); runtime.reset(); }
  });

  test(`${kind}: termination after preempt remains destructive with one unknown receipt`, { timeout: 15000 }, async () => {
    const started = deferred();
    const release = deferred();
    let signal;
    let calls = 0;
    const runtime = createCodeRuntime({ write: { async handler(_input, context) {
      calls++;
      signal = context.signal;
      started.resolve();
      await release.promise;
      return 'late accepted';
    } } }, { evaluate: await evaluator(kind) });
    try {
      const pending = runtime.executeCodeObserved(`await tools.write({}); text('late');`, 'cancel', 'origin');
      await started.promise;
      runtime.preempt('cancel', 'origin');
      const id = cellId(JSON.parse(await pending));
      const final = JSON.parse(await runtime.waitCodeObserved(JSON.stringify({ cell_id: id, terminate: true }), 'cancel', 'terminate'));
      assert.match(body(final), /Script terminated/);
      assert.equal(final.cell.running, false);
      assert.equal(signal.aborted, true);
      assert.equal(final.nested_calls.length, 1);
      assert.equal(final.nested_calls[0].structured_result.outcome, 'unknown');
      assert.equal(final.nested_calls[0].structured_result.code, 'CODE_MODE_CALL_INTERRUPTED');
      const snapshot = JSON.stringify(final);
      release.resolve();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(JSON.stringify(final), snapshot);
      assert.equal(calls, 1);
      const missing = JSON.parse(await runtime.waitCodeObserved(JSON.stringify({ cell_id: id }), 'cancel', 'missing'));
      assert.equal(missing.success, false);
      assert.match(body(missing), /not found/);
    } finally { release.resolve(); runtime.reset(); }
  });
}

test('preemptTurn is session/turn scoped and never sticky for future cells or waits', { timeout: 10000 }, async () => {
  const releases = new Map();
  const runtime = createCodeRuntime({ blocked: { supportsParallelToolCalls: true, handler({ id }) {
    const gate = deferred();
    releases.set(id, gate);
    return gate.promise;
  } } });
  try {
    runtime.beginTurn('a');
    runtime.beginTurn('b');
    const a = runtime.executeCodeObserved(`await tools.blocked({id:'a'});`, 'a', 'same-call');
    const b = runtime.executeCodeObserved(`await tools.blocked({id:'b'});`, 'b', 'same-call');
    assert.equal(runtime.preemptTurn('a'), 1);
    assert.equal(runtime.preemptTurn('a'), 0);
    const aid = cellId(JSON.parse(await a));
    let bReturned = false;
    b.then(() => { bReturned = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(bReturned, false);
    assert.equal(runtime.preemptTurn('b'), 1);
    const bid = cellId(JSON.parse(await b));
    const wait = runtime.waitCodeObserved(JSON.stringify({ cell_id: aid }), 'a', 'fresh-wait');
    let returned = false;
    wait.then(() => { returned = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(returned, false);
    runtime.beginTurn('a');
    assert.equal(runtime.preemptTurn('a'), 0, 'older-turn observers must not be signaled');
    assert.equal(runtime.preempt('a', 'fresh-wait'), true);
    assert.equal(cellId(JSON.parse(await wait)), aid);
    releases.get('a').resolve();
    releases.get('b').resolve();
    await runtime.waitCodeObserved(JSON.stringify({ cell_id: aid }), 'a', 'a-final');
    await runtime.waitCodeObserved(JSON.stringify({ cell_id: bid }), 'b', 'b-final');
    assert.equal(runtime.preempt('a', 'future'), false);
    const future = JSON.parse(await runtime.executeCodeObserved(`text('future completed');`, 'a', 'future'));
    assert.equal(future.cell.running, false);
    assert.match(body(future), /future completed/);
  } finally { for (const gate of releases.values()) gate.resolve(); runtime.reset(); }
});

test('cancelTurn during a live observer still aborts; preemption does not replace cancellation', { timeout: 10000 }, async () => {
  const started = deferred();
  const release = deferred();
  let signal;
  const runtime = createCodeRuntime({ write: { async handler(_input, context) {
    signal = context.signal;
    started.resolve();
    await release.promise;
    return 'late';
  } } });
  try {
    runtime.beginTurn('cancel-live');
    const execution = runtime.executeCodeObserved(`await tools.write({});`, 'cancel-live', 'live');
    await started.promise;
    runtime.cancelTurn('cancel-live');
    const final = JSON.parse(await execution);
    assert.equal(signal.aborted, true);
    assert.equal(final.cell.running, false);
    assert.equal(final.success, false);
    assert.equal(final.nested_calls.length, 1);
    assert.equal(final.nested_calls[0].structured_result.outcome, 'unknown');
    assert.equal(runtime.preempt('cancel-live', 'live'), false);
  } finally { release.resolve(); runtime.reset(); }
});

test('preempted output clipping does not drop receipt metadata or repeat a write', { timeout: 10000 }, async () => {
  const done = deferred();
  const release = deferred();
  let writes = 0;
  const runtime = createCodeRuntime({ write: { handler() {
    writes++;
    done.resolve();
    return toolResult('x'.repeat(5000), { accepted: true }, { metadata: { request_id: 'bounded' } });
  } }, blocked: { handler() { return release.promise; } } });
  try {
    const execution = runtime.executeCodeObserved(`// @exec: {"max_output_tokens": 1}\ntext('x'.repeat(5000)); await tools.write({}); await tools.blocked({});`, 'bounded', 'origin');
    await done.promise;
    // Let the successful receipt enter the observation before preempting.
    await new Promise(resolve => setTimeout(resolve, 0));
    runtime.preempt('bounded', 'origin');
    const first = JSON.parse(await execution);
    assert.equal(first.nested_calls.length, 1);
    assert.deepEqual(first.nested_calls[0].metadata, { request_id: 'bounded' });
    assert.deepEqual(first.nested_calls[0].structured_result, { accepted: true });
    release.resolve();
    const final = JSON.parse(await runtime.waitCodeObserved(JSON.stringify({ cell_id: cellId(first), max_tokens: 1 }), 'bounded', 'wait'));
    assert.equal(final.nested_calls.filter(call => call.name === 'write').length, 0);
    assert.equal(writes, 1);
  } finally { release.resolve(); runtime.reset(); }
});

// A busy child Worker is separate from the observer's event loop. Do not use
// an interrupt/worker termination to obtain a foreground response: the write
// promise and guest continuation must both survive the response.
test('busy worker yields its foreground observer without destroying pending guest promises', { timeout: 15000 }, async () => {
  const busy = deferred();
  const release = deferred();
  const started = deferred();
  let writes = 0;
  let signal;
  const runtime = createCodeRuntime({ write: { async handler(_input, context) {
    writes++;
    signal = context.signal;
    started.resolve();
    await release.promise;
    return { accepted: true };
  } } }, { evaluate: await evaluator('worker'), notify() { busy.resolve(); } });
  try {
    const executing = runtime.executeCodeObserved(`
      const pending = tools.write({});
      notify('busy');
      const start = Date.now();
      while (Date.now() - start < 1000) {}
      text('busy finished');
      store('busy-receipt', await pending);
    `, 'busy', 'origin');
    await busy.promise;
    await started.promise;
    runtime.preempt('busy', 'origin');
    const first = JSON.parse(await executing);
    assert.equal(first.cell.running, true);
    assert.doesNotMatch(body(first), /busy finished/, 'observation must return while worker JS is still busy');
    assert.equal(signal.aborted, false);
    release.resolve();
    const final = JSON.parse(await runtime.waitCodeObserved(JSON.stringify({ cell_id: cellId(first) }), 'busy', 'wait'));
    assert.match(body(final), /busy finished/);
    assert.equal(final.cell.running, false);
    assert.equal(final.nested_calls.length, 1);
    assert.equal(final.nested_calls[0].success, true);
    assert.equal(writes, 1);
    const stored = JSON.parse(await runtime.executeCode(`text(load('busy-receipt'));`, 'busy'));
    assert.match(body(stored), /accepted/);
  } finally { release.resolve(); runtime.reset(); }
});

for (const kind of ['node', 'browser']) {
  test(`${kind} host ABI preempts exec/wait and resumes the same cell without repeated effects`, { timeout: 15000 }, async () => {
    const started = deferred();
    const release = deferred();
    let writes = 0;
    let signal;
    const options = {
      tools: { write: { async handler(_input, context) {
        writes++;
        signal = context.signal;
        started.resolve();
        await release.promise;
        return toolResult('accepted', { accepted: true }, { metadata: { request_id: 'host-abi' } });
      } } },
      createWebSocket() { throw new Error('unexpected provider request in host ABI test'); },
    };
    const host = kind === 'node'
      ? (await import('../node/host.mjs')).createNodeHost(options)
      : (await import('../browser/host.mjs')).createBrowserHost({ ...options, codeEvaluator: await evaluator('worker') });
    try {
      await host.ready();
      host.beginCodeTurn('host-session');
      const executing = host.executeCode(`text('early'); await tools.write({}); text('resumed');`, 'host-session', 'host-origin');
      await started.promise;
      assert.equal(host.preemptCodeTurn('host-session'), 1);
      const first = JSON.parse(await executing);
      assert.equal(first.cell.running, true);
      assert.match(body(first), /early/);
      assert.equal(signal.aborted, false);
      const id = cellId(first);
      const waiting = host.waitCode(JSON.stringify({ cell_id: id }), 'host-session', 'host-wait');
      assert.equal(host.preemptCode('host-session', 'host-wait'), true);
      const second = JSON.parse(await waiting);
      assert.equal(cellId(second), id);
      assert.equal(second.cell.origin_call_id, 'host-origin');
      release.resolve();
      const final = JSON.parse(await host.waitCode(JSON.stringify({ cell_id: id }), 'host-session', 'host-final'));
      assert.equal(final.cell.running, false);
      assert.match(body(final), /resumed/);
      assert.equal(final.nested_calls.length, 1);
      assert.match(final.nested_calls[0].call_id, /^host-origin\/code-/);
      assert.deepEqual(final.nested_calls[0].metadata, { request_id: 'host-abi' });
      assert.equal(writes, 1);
      assert.equal(host.preemptCodeTurn('host-session'), 0);
    } finally { release.resolve(); await host.dispose(); }
  });
}
