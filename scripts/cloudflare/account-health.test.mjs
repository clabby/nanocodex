import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { AccountHealthError, accountHealth, accountHealthMessages, releaseWorkers } from './release-workers.mjs';

const SECRET = 'sk-live-SECRET-1234';
const REVISION = 'b'.repeat(40);
const healthy = { service: 'nanocodex', runtime: 'cloudflare-workers', status: 'ok', deployment_sha: REVISION };

// Real loopback HTTP boundary; `handler` decides how the Worker endpoint misbehaves.
async function serve(handler, body) {
  const sockets = new Set();
  const server = createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  try { return await body(url); } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(done => server.close(done));
  }
}
const json = (value, status = 200) => (_request, response) => {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(typeof value === 'string' ? value : JSON.stringify(value));
};
async function category(handler, expected, options = {}) {
  return serve(handler, async url => {
    const error = await accountHealth(expected, { url, timeoutMs: 2_000, ...options }).then(() => assert.fail('expected rejection'), error => error);
    assert.ok(error instanceof AccountHealthError, `unexpected ${error?.name}`);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(`${error.message}${error.stack}${JSON.stringify(error)}`, new RegExp(`${SECRET}|127\\.0\\.0\\.1|ECONN`));
    return error;
  });
}

test('healthy real HTTP response passes with and without revision', async () => {
  await serve(json(healthy), async url => {
    await accountHealth(undefined, { url }); await accountHealth(REVISION, { url });
  });
});

test('real HTTP status failures expose only the bounded numeric status, never the body', async () => {
  for (const status of [401, 404, 500, 503]) {
    const error = await category(json({ secret: SECRET, ...healthy }, status), REVISION);
    assert.equal(error.category, 'http_status'); assert.equal(error.httpStatus, status);
    assert.equal(error.message, `${accountHealthMessages.http_status} (HTTP ${status})`);
  }
  assert.equal((await category(json(healthy, 201), REVISION)).category, 'http_status');
  assert.equal(new AccountHealthError('http_status', 99999).httpStatus, undefined);
  assert.equal(new AccountHealthError('http_status', '503 ' + SECRET).message, accountHealthMessages.http_status);
  assert.equal(new AccountHealthError('timeout', 503).httpStatus, undefined);
  assert.throws(() => new AccountHealthError(SECRET), /Unknown account health category/);
});

test('real HTTP body and identity failures map to fixed categories', async () => {
  const cases = [
    [json(`not json ${SECRET}`), 'invalid_json'], [json(''), 'invalid_json'],
    [json('null'), 'invalid_shape'], [json('[]'), 'invalid_shape'], [json('"' + SECRET + '"'), 'invalid_shape'], [json('7'), 'invalid_shape'],
    [json({ ...healthy, service: SECRET }), 'service_mismatch'],
    [json({ ...healthy, runtime: SECRET }), 'runtime_mismatch'],
    [json({ ...healthy, status: SECRET }), 'status_mismatch'],
    [json({ ...healthy, deployment_sha: undefined }), 'revision_missing'],
    [json({ ...healthy, deployment_sha: null }), 'revision_missing'],
    [json({ ...healthy, deployment_sha: SECRET }), 'revision_mismatch'],
    [json({ ...healthy, deployment_sha: 'c'.repeat(40) }), 'revision_mismatch'],
  ];
  for (const [handler, expected] of cases) {
    const error = await category(handler, REVISION);
    assert.equal(error.category, expected); assert.equal(error.message, accountHealthMessages[expected]);
  }
  // Revision is only checked when the release expects one.
  await serve(json({ ...healthy, deployment_sha: SECRET }), url => accountHealth(undefined, { url }));
});

test('real HTTP timeouts and network failures are classified without error text', async () => {
  assert.equal((await category(() => {}, REVISION, { timeoutMs: 50 })).category, 'timeout');
  // Headers arrive but the body stalls: the same deadline still covers body reading.
  const stalled = (_request, response) => { response.writeHead(200, { 'content-length': '500' }); response.write('{'); };
  assert.equal((await category(stalled, REVISION, { timeoutMs: 100 })).category, 'timeout');
  assert.equal((await category((_request, response) => response.socket.destroy(), REVISION)).category, 'network');
  const truncated = (_request, response) => { response.writeHead(200, { 'content-length': '500' }); response.write('{'); setTimeout(() => response.socket.destroy(), 10); };
  assert.equal((await category(truncated, REVISION)).category, 'network');
  const closedPort = await serve(json(healthy), async url => url);
  const error = await accountHealth(REVISION, { url: closedPort, timeoutMs: 2_000 }).catch(error => error);
  assert.equal(error.category, 'network'); assert.equal(error.message, accountHealthMessages.network);
});

test('injected transport errors are classified only by controlled name, never echoed', async () => {
  const named = (name, message = SECRET) => Object.assign(new Error(message, { cause: new Error(SECRET) }), { name });
  for (const [thrown, expected] of [[named('TimeoutError'), 'timeout'], [named('AbortError'), 'timeout'], [named('TypeError'), 'network'],
    [named('Error', `${SECRET} timeout`), 'network'], ['string ' + SECRET, 'network'], [null, 'network']]) {
    const error = await accountHealth(REVISION, { request: async () => { throw thrown; } }).catch(error => error);
    assert.ok(error instanceof AccountHealthError); assert.equal(error.category, expected);
    assert.equal(error.cause, undefined); assert.doesNotMatch(`${error.message}${error.stack}`, new RegExp(SECRET));
    const body = await accountHealth(REVISION, { request: async () => ({ status: 200, json: async () => { throw thrown; } }) }).catch(error => error);
    assert.equal(body.category, thrown instanceof SyntaxError ? 'invalid_json' : expected);
  }
  const syntax = await accountHealth(REVISION, { request: async () => ({ status: 200, json: async () => { throw new SyntaxError(SECRET); } }) }).catch(error => error);
  assert.equal(syntax.category, 'invalid_json'); assert.doesNotMatch(syntax.message, new RegExp(SECRET));
});

test('release annotation names the health category and never leaks response or error content', async t => {
  const annotations = [];
  t.mock.method(console, 'error', line => annotations.push(String(line)));
  t.mock.method(console, 'log', () => {});
  const run = (health) => {
    const events = [];
    const plan = { revision: REVISION, selected: ['account'], fingerprints: { account: 'a'.repeat(64) } };
    return { events, release: releaseWorkers(plan, { env: {}, isCurrent: async () => true, prepare: async () => {}, run: async () => true, health,
      ledger: { start: async name => name, finish: async (name, state) => events.push([state, name]) } }) };
  };
  const cases = [
    [() => serve(json({ secret: SECRET }, 503), url => accountHealth(REVISION, { url })), 'account account health check: Account health returned an unexpected HTTP status (HTTP 503)'],
    [() => serve(json({ ...healthy, deployment_sha: SECRET }), url => accountHealth(REVISION, { url })), 'account account health check: Account health must identify the released revision'],
    [() => serve(json(`<html>${SECRET}`), url => accountHealth(REVISION, { url })), 'account account health check: Account health response was not valid JSON'],
    [() => serve(() => {}, url => accountHealth(REVISION, { url, timeoutMs: 50 })), 'account account health check: Account health request timed out'],
    [() => accountHealth(REVISION, { request: async () => { throw new Error(SECRET); } }), 'account account health check: Account health request failed before a valid response'],
  ];
  for (const [health, expected] of cases) {
    annotations.length = 0;
    const { events, release } = run(health);
    const error = await release.then(() => assert.fail('expected rejection'), error => error);
    assert.deepEqual(annotations, [`::error title=Worker release failed::${expected}`]);
    assert.ok(error.message.includes(expected)); assert.deepEqual(events, [['failure', 'account']]);
    assert.doesNotMatch(annotations.join('') + error.message, new RegExp(SECRET));
  }
  // Untyped health errors stay opaque exactly as before.
  annotations.length = 0;
  const { release } = run(async () => { throw new Error(SECRET); });
  const error = await release.catch(error => error);
  assert.deepEqual(annotations, ['::error title=Worker release failed::account account health check']);
  assert.doesNotMatch(error.message, new RegExp(SECRET));
});
