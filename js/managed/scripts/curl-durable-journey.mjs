#!/usr/bin/env node
// Live, public HTTP journey. Every API request goes through the curl executable.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.env.NANOCODEX_ORIGIN;
const token = process.env.NANOCODEX_API_KEY;
assert.ok(origin && token, 'Set NANOCODEX_ORIGIN and NANOCODEX_API_KEY; this journey creates synthetic agents and uses live inference.');
assert.ok(new URL(origin).protocol === 'https:' || ['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
assert.ok(!/[\r\n]/.test(token), 'Invalid credential');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(process.env.NANOCODEX_JOURNEY_OUTPUT ?? resolve(root, `output/managed-curl-durability/${Date.now()}`));
await mkdir(output, { recursive: true });
const resumed = process.env.NANOCODEX_JOURNEY_RESUME
  ? JSON.parse(await readFile(resolve(process.env.NANOCODEX_JOURNEY_RESUME, 'run.json'), 'utf8')) : undefined;
const run = resumed?.run ?? randomUUID();
const attempt = randomUUID();
const settings = { model: process.env.NANOCODEX_TEST_MODEL ?? 'gpt-6.1-sol', thinking: 'low', reasoning_mode: 'standard', fast_mode: false };
const childModel = process.env.NANOCODEX_TEST_CHILD_MODEL;
const childHarness = process.env.NANOCODEX_TEST_CHILD_HARNESS;
assert.ok((!childModel && !childHarness) || (childModel && ['codex', 'claude'].includes(childHarness)), 'Provide both child model and child harness');
const childSelection = childModel ? `For every spawn_agent call explicitly select harness ${childHarness} and model ${childModel}.` : '';
const toolGuidance = 'Built-in subagent tools are directly callable as tools.spawn_agent, tools.wait_agent, tools.send_agent_message, tools.list_agents, tools.close_agent, and tools.submit_result inside exec. Inspect their full schemas in ALL_TOOLS. ToolSearch searches deferred tools, so an empty search does not mean these built-ins are unavailable. There is no codemode global.';
const checks = [];
const scenario = process.env.NANOCODEX_JOURNEY_SCENARIO ?? 'all';
assert.ok(['all', 'idle', 'restart', 'interruption'].includes(scenario));
let sequence = 0;
await writeFile(`${output}/run.json`, JSON.stringify({ run, attempt, origin, settings, childModel, childHarness, scenario, resumed_from: process.env.NANOCODEX_JOURNEY_RESUME, started_at: new Date().toISOString(), source_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), script_sha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex') }, null, 2));

function frames(raw) {
  return raw.replaceAll('\r\n', '\n').split('\n\n').slice(0, -1).flatMap(frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return [];
    return [{ type: frame.match(/^event: (.+)$/m)?.[1], id: frame.match(/^id: (.+)$/m)?.[1], data: JSON.parse(data) }];
  });
}

async function request(label, path, { method = 'GET', body, headers = {}, authenticated = true, expected = 200, disconnectAfterReceipt = false, timeout = 180 } = {}) {
  assert.ok(path.startsWith('/v1/'), 'Only public API routes');
  const name = `${String(++sequence).padStart(3, '0')}-${label}`;
  const base = `${output}/${name}`;
  if (body !== undefined) await writeFile(`${base}.request.json`, JSON.stringify(body));
  const args = ['--silent', '--show-error', '--no-buffer', '--max-time', String(timeout), '--request', method, '--dump-header', `${base}.headers`, '--config', '-', '-H', 'Content-Type: application/json', ...Object.entries(headers).flatMap(([key, value]) => ['-H', `${key}: ${value}`]), ...(body === undefined ? [] : ['--data-binary', `@${base}.request.json`]), new URL(path, origin).href];
  // The bearer travels on stdin, never in argv, shell tracing, or saved evidence.
  const config = authenticated ? `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\n` : '';
  const started = Date.now();
  const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', disconnected = false;
  child.stdout.on('data', bytes => {
    stdout += bytes.toString('utf8');
    if (disconnectAfterReceipt && !disconnected && /event: run\r?\n/.test(stdout) && /\r?\n\r?\n/.test(stdout)) {
      disconnected = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  child.stdin.on('error', () => {});
  child.stdin.end(config);
  const result = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
  const responseHeaders = await readFile(`${base}.headers`, 'utf8');
  const status = Number([...responseHeaders.matchAll(/^HTTP\/\S+ (\d+)/gm)].at(-1)?.[1]);
  await Promise.all([
    writeFile(`${base}.response`, stdout), writeFile(`${base}.stderr`, stderr),
    writeFile(`${base}.receipt.json`, JSON.stringify({ label, method, path, headers, authenticated, expected, status, ...result, disconnected, duration_ms: Date.now() - started, curl_argv: args, auth_stdin: authenticated ? 'Authorization: Bearer $NANOCODEX_API_KEY (not recorded)' : null }, null, 2)),
  ]);
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(status), `${label}: expected HTTP ${expected}, got ${status}: ${stdout.slice(0, 2000)} (${base})`);
  if (!disconnected) assert.equal(result.code, 0, `${label}: curl ${result.code}: ${stderr}`);
  checks.push({ label, status, evidence: name });
  await writeFile(`${output}/checks.json`, JSON.stringify(checks, null, 2));
  console.log(`${label}: HTTP ${status} (${Date.now() - started}ms)`);
  return { status, raw: stdout, json: () => JSON.parse(stdout), frames: () => frames(stdout), name };
}

function events(response) { return response.frames().map(frame => frame.data.event).filter(Boolean); }
function toolResults(response, tool) {
  return events(response).filter(event => event.type === 'tool.result' && event.payload.tool === tool).map(event => {
    const payload = event.payload;
    let value = payload.structured_result ?? payload.result;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch {} }
    return { ...payload, value };
  });
}
function completedOutputs(response) {
  const outputs = new Map();
  for (const result of toolResults(response, 'wait_agent')) for (const agent of result.value?.agents ?? []) {
    if (agent.status.state === 'completed') outputs.set(agent.agent_id, agent.status.output);
  }
  return outputs;
}
function assertTerminal(response, expected = 'turn_completed') {
  const receipt = response.frames().find(frame => frame.type === 'run')?.data;
  assert.ok(receipt?.agent_id && receipt?.turn_id, 'SSE admission receipt');
  const terminal = response.frames().find(frame => frame.data.turn_id === receipt.turn_id && ['turn_completed', 'turn_failed', 'turn_cancelled'].includes(frame.data.type));
  assert.equal(terminal?.data.type, expected, `${response.name}: missing expected terminal: ${response.raw.slice(-2500)}`);
  return { ...receipt, terminal_cursor: terminal.data.cursor ?? terminal.id };
}

async function readHistory(label, agent) {
  const data = [];
  let cursor = '0';
  for (let page = 0; page < 8; page++) {
    const response = (await request(`${label}-${page}`, `/v1/agents/${agent}/events/history?after=${cursor}&limit=256`)).json();
    data.push(...response.data);
    if (!response.has_more) return data;
    const next = response.data.at(-1)?.cursor;
    assert.ok(next && BigInt(next) > BigInt(cursor), 'History pagination makes progress');
    cursor = next;
  }
  assert.fail('Synthetic journey exceeded 2048 retained events; inspect the saved history pages');
}

async function lifecycleJourney() {
  const key = `curl-durable-${run}`;
  const expectedA = { marker: `curl-parent-${run}`, value: 42 };
  const expectedG = { marker: `curl-grandchild-${run}`, value: 77 };
  const expectedB = { marker: `curl-errors-${run}`, value: 17 };
  const input = `Synthetic public API durability test. Use Code Mode and actual tools. Access no external services, personal files, Hands, connectors, or existing project data. Use only /brain for the harmless exit command. No messages to parent or peers from children. Keep children open unless explicitly told to close below.
Create exactly two direct children sequentially, with roles CURL_PARENT and CURL_ERRORS. Each has output contract object {marker:string,value:integer}.
CURL_PARENT task: spawn exactly one child role CURL_GRANDCHILD with that same output contract, task submit ${JSON.stringify(expectedG)} then finish, keeping itself open. Wait until grandchild completes. Then submit ${JSON.stringify(expectedA)} and finish. Keep the grandchild open and remember its ID for a follow-up.
CURL_ERRORS task: deliberately submit {marker:${JSON.stringify(expectedB.marker)},value:"invalid-integer"} first, observe the contract rejection, then run exec_command({cmd:"exit 17",workdir:"/brain"}), observe actual exit code 17, then submit ${JSON.stringify(expectedB)} and finish. Do not repeat the shell command.
Wait for both direct children to complete. Actually attempt send_agent_message to nonexistent agent_id 999999999 and observe rejection. Explicitly close CURL_ERRORS only. Call list_agents with include_completed:true. Keep CURL_PARENT and CURL_GRANDCHILD reusable. Report IDs and results. Do not invent receipts or spawn replacement agents.`;
  const body = resumed
    ? JSON.parse(await readFile(resolve(process.env.NANOCODEX_JOURNEY_RESUME, '001-unauthenticated-create.request.json'), 'utf8'))
    : { input: input + `\n${toolGuidance}` + (childSelection ? `\n${childSelection}` : ''), settings };
  await request('unauthenticated-create', '/v1/agent-runs', { method: 'POST', body, headers: { 'Idempotency-Key': key }, authenticated: false, expected: 401 });
  await request('invalid-cursor-before-admission', '/v1/agent-runs', { method: 'POST', body, headers: { 'Idempotency-Key': key, Accept: 'text/event-stream', 'Last-Event-ID': 'invalid' }, expected: 400 });
  const disconnected = await request('disconnect-after-admission', '/v1/agent-runs', { method: 'POST', body, headers: { 'Idempotency-Key': key, Accept: 'text/event-stream' }, expected: resumed ? 200 : 201, disconnectAfterReceipt: true });
  const firstReceipt = disconnected.frames().find(frame => frame.type === 'run')?.data;
  assert.ok(firstReceipt?.agent_id);
  await writeFile(`${output}/agent.json`, JSON.stringify(firstReceipt, null, 2));
  const initial = await request('retry-same-admission', '/v1/agent-runs', { method: 'POST', body, headers: { 'Idempotency-Key': key, Accept: 'text/event-stream' } });
  const receipt = assertTerminal(initial);
  assert.equal(receipt.agent_id, firstReceipt.agent_id);
  assert.equal(receipt.turn_id, firstReceipt.turn_id);
  const agent = receipt.agent_id;
  const completed = completedOutputs(initial);
  for (const expected of [expectedA, expectedG, expectedB]) assert.ok([...completed.values()].some(value => JSON.stringify(value) === JSON.stringify(expected)), `Missing actual wait_agent output ${JSON.stringify(expected)}`);
  const admissions = toolResults(initial, 'spawn_agent').filter(result => result.status === 'completed');
  assert.equal(admissions.length, 3, 'Exactly three successful child admissions');
  assert.equal(new Set(admissions.map(result => result.value?.agent_id)).size, 3, 'Three distinct admitted child IDs');
  assert.ok(toolResults(initial, 'submit_result').some(result => result.status === 'failed' && /schema/.test(String(result.value))), 'Actual invalid result rejection');
  assert.ok(toolResults(initial, 'send_agent_message').some(result => result.status === 'failed' && /unknown agent_id/.test(String(result.value))), 'Actual unknown-child rejection');
  assert.ok(toolResults(initial, 'exec_command').some(result => result.value?.exit_code === 17), 'Actual shell exit 17');
  const parentId = [...completed].find(([, value]) => value.marker === expectedA.marker)[0];
  const grandchildId = [...completed].find(([, value]) => value.marker === expectedG.marker)[0];
  const closedId = [...completed].find(([, value]) => value.marker === expectedB.marker)[0];
  await request('changed-input-conflict', '/v1/agent-runs', { method: 'POST', body: { ...body, input: input + '\nChanged request.' }, headers: { 'Idempotency-Key': key }, expected: 409 });
  const cursorFrames = initial.frames().filter(frame => frame.id);
  const midpoint = cursorFrames[Math.floor(cursorFrames.length / 2)].id;
  const resumedStream = await request('resume-after-midpoint', '/v1/agent-runs', { method: 'POST', body, headers: { 'Idempotency-Key': key, Accept: 'text/event-stream', 'Last-Event-ID': midpoint } });
  assert.deepEqual(resumedStream.frames().filter(frame => frame.id).map(frame => frame.data), cursorFrames.filter(frame => BigInt(frame.id) > BigInt(midpoint)).map(frame => frame.data), 'Cursor reconnect returns the exact retained suffix without duplicate events');
  const terminalReplay = await request('resume-at-terminal', '/v1/agent-runs', { method: 'POST', body, headers: { 'Idempotency-Key': key, Accept: 'text/event-stream', 'Last-Event-ID': String(receipt.terminal_cursor) } });
  assert.equal(terminalReplay.frames().length, 1, 'Terminal cursor returns only original receipt then EOF');
  await request('unauthenticated-restart', `/v1/agents/${agent}/restart`, { method: 'POST', authenticated: false, expected: 401 });
  await request('unknown-agent', `/v1/agents/${randomUUID()}`, { expected: 404 });
  let idle;
  if (scenario !== 'restart') {
    const settled = (await request('settled-state', `/v1/agents/${agent}`)).json();
    // Replaying combined admission prepares the runtime again without changing
    // last_active. Allow its preparation lease to expire as well as the turn's.
    const idleDeadline = Math.max(settled.last_active, Date.now()) + 300_000;
    console.log(`Waiting for real idle teardown; next state check after ${new Date(idleDeadline + 5000).toISOString()}. Agent ${agent}`);
    if (scenario === 'all') await interruptionJourney();
    while (Date.now() < idleDeadline + 5000) await delay(Math.min(30_000, idleDeadline + 5000 - Date.now()));
    for (let i = 0; i < 7; i++) {
      idle = (await request(`idle-state-${i}`, `/v1/agents/${agent}`)).json();
      if (!idle.agent_loaded) break;
      await delay(10_000);
    }
    assert.equal(idle.agent_loaded, false, 'Actual graceful idle teardown, not an operator restart');
  }
  const followup = `Continue the synthetic durability test. Access no files, services, Hands, or connectors. Spawn no new agents. First call list_agents with include_completed:true. Attempt sending a message to closed child ${closedId}; it must be rejected. Delegate to existing child ${parentId}: ask your existing grandchild to recall its own original marker and integer from retained history and submit them again; wait for its result, then recall and submit your own original marker and integer from retained history. Include no marker or value in the message to either child. Keep both children open. Wait for child ${parentId} to complete and report actual results. Do not message peers or parents from child tasks. ${toolGuidance}`;
  if (scenario !== 'restart') {
    const recalled = await request('nested-recall-after-idle', `/v1/agents/${agent}/turns`, { method: 'POST', body: { input: followup }, headers: { Accept: 'text/event-stream', 'Idempotency-Key': `recall-${attempt}` }, expected: 202 });
    assertTerminal(recalled);
    assert.equal(events(recalled).filter(event => event.type === 'tool.call' && event.payload.tool === 'spawn_agent').length, 0);
    const after = completedOutputs(recalled);
    assert.deepEqual(after.get(parentId), expectedA);
    assert.deepEqual(after.get(grandchildId), expectedG);
    assert.ok(toolResults(recalled, 'send_agent_message').some(result => result.status === 'failed' && /closed/i.test(String(result.value))), 'Explicitly closed child remains closed');
    for (const event of events(recalled).filter(event => event.type === 'tool.call' && event.payload.tool === 'send_agent_message')) {
      const args = JSON.stringify(event.payload.arguments);
      assert.ok(!args.includes(expectedA.marker) && !args.includes(expectedG.marker), 'Delegation must not supply remembered answers');
    }
  }
  const beforeRestart = (await request('state-before-restart', `/v1/agents/${agent}`)).json();
  assert.equal(beforeRestart.agent_loaded, true, 'A live completed runtime is available to restart');
  await request('restart-nested-runtime', `/v1/agents/${agent}/restart`, { method: 'POST', expected: 202 });
  let restartedState;
  for (let i = 0; i < 20; i++) {
    restartedState = (await request(`restart-state-${i}`, `/v1/agents/${agent}`)).json();
    if (!restartedState.agent_loaded) break;
    await delay(250);
  }
  assert.equal(restartedState.agent_loaded, false, 'Acknowledged restart actually unloads the completed runtime');
  const restarted = await request('nested-recall-after-restart', `/v1/agents/${agent}/turns`, { method: 'POST', body: { input: followup }, headers: { Accept: 'text/event-stream', 'Idempotency-Key': `restart-recall-${attempt}` }, expected: 202 });
  assertTerminal(restarted);
  const restartedOutputs = completedOutputs(restarted);
  assert.deepEqual(restartedOutputs.get(parentId), expectedA);
  assert.deepEqual(restartedOutputs.get(grandchildId), expectedG);
  assert.equal(events(restarted).filter(event => event.type === 'tool.call' && event.payload.tool === 'spawn_agent').length, 0);
  assert.ok(toolResults(restarted, 'send_agent_message').some(result => result.status === 'failed' && /closed/i.test(String(result.value))));
  for (const event of events(restarted).filter(event => event.type === 'tool.call' && event.payload.tool === 'send_agent_message')) {
    const args = JSON.stringify(event.payload.arguments);
    assert.ok(!args.includes(expectedA.marker) && !args.includes(expectedG.marker), 'Delegation must not supply remembered answers');
  }
  await request('final-capacity', `/v1/agents/${agent}/capacity`);
  await writeFile(`${output}/${scenario === 'restart' ? 'restart' : 'idle'}-result.json`, JSON.stringify({ passed: true, agent, parentId, grandchildId, closedId, idle, restartedState, expected: [expectedA, expectedG, expectedB], checks }, null, 2));
}

async function interruptionJourney() {
  const proof = `/brain/curl-proof-${attempt}.txt`;
  const settledCommand = `echo settled >> ${proof}`;
  const pendingCommand = `echo pending >> ${proof}; sleep 45`;
  const body = { settings, input: `Synthetic interruption test. Access only the new synthetic file ${proof} in /brain, no other files, services, Hands or connectors. Use actual tools. Spawn exactly one child role CURL_INTERRUPTED with output contract integer. Child task: execute ${JSON.stringify(settledCommand)} in /brain and wait for its result; then execute ${JSON.stringify(pendingCommand)} in /brain and wait for its result; then submit integer 1. Never repeat either command, even on failure or an uncertain receipt. Do not message parent or peers. Parent must wait for that child to become terminal, report actual state, and keep it open. No other tool actions or replacement agents.` };
  if (childSelection) body.input += `\n${childSelection}`;
  body.input += `\n${toolGuidance}`;
  const created = (await request('active-create', '/v1/agent-runs', { method: 'POST', body, headers: { 'Idempotency-Key': `active-${attempt}` }, expected: 201 })).json();
  const agent = created.agent_id;
  const turn = created.turn_id;
  assert.ok(agent && turn);
  await writeFile(`${output}/active-agent.json`, JSON.stringify(created, null, 2));
  let childId;
  // Observe actual dispatch and the synthetic effect through the public API before eviction.
  for (let i = 0; i < 60; i++) {
    const history = (await request(`active-dispatch-${i}`, `/v1/agents/${agent}/events/history?after=0&limit=256`)).json();
    for (const row of history.data ?? []) {
      const event = row.event;
      if (event?.type === 'tool.result' && event.payload.tool === 'spawn_agent') {
        const value = event.payload.structured_result ?? JSON.parse(event.payload.result);
        childId = value.agent_id;
      }
    }
    const proofResponse = await request(`active-proof-${i}`, `/v1/agents/${agent}/files?path=${encodeURIComponent(proof)}`, { expected: [200, 404] });
    if (proofResponse.status === 200 && proofResponse.raw === 'settled\npending\n') break;
    const earlyTerminal = history.data?.find(row => row.turn_id === turn && ['turn_completed', 'turn_failed', 'turn_cancelled'].includes(row.type));
    assert.ok(!earlyTerminal, `Turn ended before the pending effect: ${JSON.stringify(earlyTerminal)}`);
    assert.ok(i < 59, 'Child never reached the pending effect');
    await delay(1000);
  }
  assert.ok(childId, 'Actual child admission');
  await request('restart-active-runtime', `/v1/agents/${agent}/restart`, { method: 'POST', expected: 202 });
  let terminal;
  for (let i = 0; i < 60; i++) {
    terminal = (await request(`active-terminal-${i}`, `/v1/agents/${agent}/turns/${turn}`)).json();
    if (['completed', 'failed', 'cancelled'].includes(terminal.state)) break;
    await delay(2000);
  }
  assert.ok(['completed', 'failed'].includes(terminal.state), 'Interrupted turn must reach an explicit terminal state');
  const afterProof = await request('proof-after-restart', `/v1/agents/${agent}/files?path=${encodeURIComponent(proof)}`);
  assert.equal(afterProof.raw, 'settled\npending\n', 'Neither completed nor uncertain effect may be blindly repeated');
  const history = await readHistory('recovery-history', agent);
  await request('recovery-diagnostics', `/v1/agents/${agent}/diagnostics?limit=256`);
  const recoveryError = history.find(row => row.event?.type === 'tool.result'
    && row.event.payload.status === 'failed'
    && /outcome["\s:]*unknown|outcome.*uncertain/i.test(JSON.stringify(row.event.payload.structured_result ?? row.event.payload.result)));
  const pendingCalls = history.filter(row => row.agent_id === childId && row.event?.type === 'tool.call'
    && row.event.payload.tool === 'exec_command' && row.event.payload.arguments?.cmd === pendingCommand);
  // A child restored from a portable checkpoint receives a runtime-authored
  // input.accepted warning, rather than a fabricated result for its lost call.
  const recoveryNotice = history.find(row => row.agent_id === childId && row.event?.type === 'input.accepted'
    && pendingCalls.some(call => row.event.payload.input?.includes(`call_id ${call.event.payload.call_id}; started; no result was observed`)));
  assert.ok(recoveryError || recoveryNotice, 'Public runtime evidence identifies the unknown outcome; model narration is not evidence');
  await writeFile(`${output}/recovery-evidence.json`, JSON.stringify({
    kind: recoveryError ? 'tool_result' : 'runtime_resume_notice',
    event: recoveryError ?? recoveryNotice,
    pending_call_ids: pendingCalls.map(row => row.event.payload.call_id),
  }, null, 2));
  const recovered = await request('explicit-child-recovery', `/v1/agents/${agent}/turns`, { method: 'POST', expected: 202, headers: { Accept: 'text/event-stream', 'Idempotency-Key': `recover-${run}` }, body: { input: `New synthetic task. Do not execute or repeat any previous shell command, or access files, Hands, services or connectors. Do not spawn replacements. Use explicit delegation to existing child ${childId}, task: submit integer 2 using existing output contract, then finish; no other actions and no parent or peer messages. Wait until child ${childId} completes, keeping it open. Report actual result.` } });
  assertTerminal(recovered);
  assert.equal(completedOutputs(recovered).get(childId), 2, 'Original child reusable after interrupted work');
  assert.equal(events(recovered).filter(event => event.type === 'tool.call' && event.payload.tool === 'spawn_agent').length, 0);
  const cancelInput = `Synthetic cancellation test. Use your declared shell command tool through Code Mode in /brain exactly once with command ${JSON.stringify(`echo cancel-ready >> ${proof}; sleep 45; echo MUST_NOT_RUN >> ${proof}`)} and a command timeout of at least 60 seconds. Inspect ALL_TOOLS for its schema if needed. Access no other files, Hands, services or connectors; do not spawn agents. Do not retry any command.`;
  const cancelTurn = (await request('cancel-admit', `/v1/agents/${agent}/turns`, { method: 'POST', expected: 202, headers: { 'Idempotency-Key': `cancel-${run}` }, body: { input: cancelInput } })).json();
  for (let i = 0; i < 45; i++) {
    const response = await request(`cancel-ready-${i}`, `/v1/agents/${agent}/files?path=${encodeURIComponent(proof)}`);
    if (response.raw === 'settled\npending\ncancel-ready\n') break;
    assert.ok(i < 44, 'Cancellation command did not start');
    await delay(1000);
  }
  const cancelledAt = Date.now();
  await request('cancel-active-turn', `/v1/agents/${agent}/turns/${cancelTurn.turn_id}/cancel`, { method: 'POST', expected: 202, headers: { 'Idempotency-Key': `cancel-command-${run}` } });
  let cancelled;
  for (let i = 0; i < 30; i++) {
    cancelled = (await request(`cancel-terminal-${i}`, `/v1/agents/${agent}/turns/${cancelTurn.turn_id}`)).json();
    if (cancelled.state === 'cancelled') break;
    await delay(1000);
  }
  assert.equal(cancelled.state, 'cancelled');
  const cancelProof = await request('cancel-proof', `/v1/agents/${agent}/files?path=${encodeURIComponent(proof)}`);
  assert.equal(cancelProof.raw, 'settled\npending\ncancel-ready\n');
  const next = await request('next-turn-after-cancel', `/v1/agents/${agent}/turns`, { method: 'POST', expected: 202, headers: { Accept: 'text/event-stream', 'Idempotency-Key': `after-cancel-${run}` }, body: { input: 'New synthetic task: reply with exactly CURL_NEXT_TURN_OK. Use no tools and do not continue or repeat any prior command.' } });
  assertTerminal(next);
  assert.match(next.frames().find(frame => frame.data.type === 'turn_completed').data.final_message, /CURL_NEXT_TURN_OK/);
  // Cancellation must stop the tail of the command, not merely close its turn.
  while (Date.now() < cancelledAt + 46_000) await delay(Math.min(10_000, cancelledAt + 46_000 - Date.now()));
  const lateProof = await request('cancel-proof-after-command-deadline', `/v1/agents/${agent}/files?path=${encodeURIComponent(proof)}`);
  assert.equal(lateProof.raw, 'settled\npending\ncancel-ready\n');
  await writeFile(`${output}/interruption-result.json`, JSON.stringify({ passed: true, agent, childId, proof, terminal, cancelled, checks }, null, 2));
}

try {
  if (scenario === 'interruption') await interruptionJourney();
  else await lifecycleJourney();
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, scenario, checks }, null, 2));
  console.log(`PASS: curl durability journey (${scenario}). Evidence: ${output}`);
} catch (error) {
  await writeFile(`${output}/failure.json`, JSON.stringify({ error: error.stack, checks }, null, 2));
  console.error(error);
  process.exitCode = 1;
}
