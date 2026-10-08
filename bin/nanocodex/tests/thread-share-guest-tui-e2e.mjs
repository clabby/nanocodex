// Black-box guest PTY journey using the shipped executable and real HTTP/SSE.
// The transport fixture is synthetic; Worker authorization is separately covered
// by js/managed/test/thread-share-links.test.ts against the real Worker/DO.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../js/managed/package.json', import.meta.url));
const { Terminal } = require('@xterm/headless');
const dir = resolve('output/thread-share-guest-tui'); mkdirSync(dir, { recursive: true });
const id = '019fc927-b280-79a7-8445-1b9996ad2fb0';
const token = `nsl_${'c'.repeat(43)}`;
const ownerKey = `ncx_live_${'a'.repeat(12)}_${'b'.repeat(43)}`;
let permission = 'read', revoked = false, streams = [], requests = [], terminals = [];
const trace = { command: 'cargo build -p nanocodex2-bin --bin nanocodex2 && node bin/nanocodex/tests/thread-share-guest-tui-e2e.mjs', stages: [] };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push({ method: req.method, path: url.pathname, after: url.searchParams.get('after'), before: url.searchParams.get('before'),
    auth: req.headers.authorization === `Bearer ${token}` ? 'guest' : req.headers.authorization === `Bearer ${ownerKey}` ? 'OWNER_LEAK' : 'none' });
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (!url.pathname.startsWith(`/v1/shared/${id}`)) return json(500, { error: 'owner_route_forbidden' });
  if (revoked || req.headers.authorization !== `Bearer ${token}`) return json(404, { error: 'not_found' });
  if (url.pathname.endsWith('/events/history') && url.searchParams.get('before') === '1') return json(200, { data: [
    { cursor: '0', type: 'turn_completed', id: 'older', final_message: 'Earlier archived answer' },
  ], has_more: false, next_cursor: null });
  if (url.pathname.endsWith('/events/history')) return json(200, { data: [
    { cursor: '1', type: 'turn_accepted', id: 'old', input: 'Historical owner question' },
    { cursor: '2', type: 'turn_completed', id: 'old', final_message: 'Historical answer' },
  ], has_more: true, next_cursor: '1' });
  if (url.pathname.endsWith('/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n'); streams.push(res); return;
  }
  if (url.pathname.endsWith('/turns')) {
    if (permission !== 'write') return json(403, { error: 'forbidden' });
    assert.equal(req.headers.origin, origin);
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes); assert.equal(body.input, 'Guest asks a question'); assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(body).sort(), ['id', 'input']);
    broadcast({ cursor: '5', type: 'turn_accepted', id: body.id, author: 'guest', input: body.input });
    return json(202, { id: body.id, status: 'accepted' });
  }
  return json(200, { agent_id: id, title: 'Shared synthetic thread', permission, latest_event_cursor: '2' });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const broadcast = event => { const bytes = Buffer.from(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  // Split every UTF-8 byte, including the non-ASCII live delta.
  for (const stream of streams) if (!stream.destroyed) for (const byte of bytes) stream.write(Buffer.from([byte])); };
const wait = async (predicate, message) => { const end = Date.now() + 20000; while (!predicate()) {
  if (Date.now() > end) throw new Error(message); await new Promise(r => setTimeout(r, 25));
} };
const allFiles = root => readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? allFiles(join(root, e.name)) : [join(root, e.name)]);
async function launch(hidden) {
  const workspace = mkdtempSync(join(dir, 'run-'));
  const child = spawn('python3', [new URL('./share-pty-bridge.py', import.meta.url).pathname,
    resolve('target/debug/nanocodex2'), 'attach', `${origin}/share/${id}${hidden ? '' : `#token=${token}`}`], {
    cwd: workspace, env: { ...process.env, HOME: workspace, CODEX_HOME: join(workspace, '.codex'),
      NANOCODEX_RELOAD_DIR: join(workspace, '.reload'), NANOCODEX_API_KEY: ownerKey, NC_API_KEY: ownerKey,
      TERM: 'xterm-256color', SSH_TTY: '/dev/synthetic-pty', TMUX: '', TMUX_PANE: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const emulator = new Terminal({ cols: 160, rows: 32, allowProposedApi: true });
  const state = { child, workspace, emulator, raw: '', errors: '', get screen() {
    return Array.from({ length: emulator.rows }, (_, i) => emulator.buffer.active.getLine(i)?.translateToString() ?? '').join('\n');
  } }; terminals.push(state);
  child.stdout.on('data', b => { state.raw += b; emulator.write(b); }); child.stderr.on('data', b => state.errors += b);
  if (hidden) { await wait(() => state.screen.includes('Paste shared token'), 'hidden prompt'); child.stdin.write(`${token}\r`); }
  await wait(() => state.screen.includes('Historical answer'), 'history visible');
  return state;
}
try {
  let terminal = await launch(true);
  await wait(() => streams.length === 1, 'read SSE connected');
  assert.equal(requests.find(r => r.path.endsWith('/events')).after, '2');
  terminal.child.stdin.write('\x1b[H');
  await wait(() => terminal.screen.includes('Earlier archived answer'), 'older history loaded');
  terminal.child.stdin.write('read-only cannot submit\r');
  broadcast({ cursor: '3', turn_id: 'live', type: 'event', event: { type: 'assistant.delta', payload: { text: 'Live café update' } } });
  await wait(() => terminal.screen.includes('Live café update'), 'live delta rendered before completion');
  broadcast({ cursor: '4', turn_id: 'live', type: 'event', event: { type: 'reasoning.summary.delta', payload: { text: 'Reasoning now visible' } } });
  await wait(() => terminal.screen.includes('Reasoning now visible'), 'live reasoning rendered');
  streams[0].end();
  await wait(() => streams.length === 2, 'SSE reconnected');
  assert.equal(requests.filter(r => r.path.endsWith('/events')).at(-1).after, '4');
  assert.equal(requests.filter(r => r.method === 'POST').length, 0);
  revoked = true; for (const stream of streams) stream.end();
  await wait(() => terminal.screen.includes('Access revoked'), 'read revocation visible');
  writeFileSync(join(dir, 'read-revoked-screen.txt'), terminal.screen);
  terminal.child.stdin.write('\x03');
  trace.stages.push({ mode: 'hidden token / read', history: true, olderHistory: true, liveAssistantBeforeCompletion: true, liveReasoning: true, resumedAfter: '4', submissions: 0, revoked: true });
  streams = []; permission = 'write'; revoked = false;
  terminal = await launch(false);
  await wait(() => streams.length === 1, 'write SSE connected');
  terminal.child.stdin.write('Guest asks a question\r');
  await wait(() => terminal.screen.includes('Guest: Guest asks a question')
    && terminal.emulator.buffer.active.getLine(30).translateToString(true) === '│' + ' '.repeat(158) + '│', 'guest admission visible and composer cleared');
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
  broadcast({ cursor: '6', turn_id: 'guest', type: 'event', event: { type: 'assistant.delta', payload: { item_id: 'answer', text: 'Guest response arrives live' } } });
  await wait(() => terminal.screen.includes('Guest response arrives live'), 'guest delta rendered');
  broadcast({ cursor: '7', turn_id: 'guest', type: 'event', event: { type: 'assistant.message', payload: { item_id: 'answer', text: 'Guest response arrives live' } } });
  broadcast({ cursor: '8', turn_id: 'guest', type: 'turn_completed', id: 'guest', final_message: 'Guest response arrives live' });
  await wait(() => terminal.screen.includes('Guest response arrives live'), 'guest answer rendered');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(terminal.screen.split('Guest response arrives live').length - 1, 1, 'completion reconciles streamed answer');
  revoked = true; for (const stream of streams) stream.end();
  await wait(() => terminal.screen.includes('Access revoked'), 'write revocation visible');
  assert.equal(requests.filter(r => r.path.endsWith('/events')).at(-1).after, '8');
  assert.equal(terminal.screen.split('Guest response arrives live').length - 1, 1, 'completed answer remains unique after cursor 8');
  terminal.child.stdin.write('forbidden after revoke\r');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
  trace.stages.push({ mode: 'URL token / write', guestPosts: 1, liveCompletion: true, completionRenderedOnce: true, revoked: true, postRevocationPosts: 0 });
  for (const terminal of terminals) {
    assert.ok(!terminal.raw.includes(token)); assert.ok(!terminal.screen.includes(token)); assert.ok(!terminal.errors.includes(token));
    for (const file of allFiles(terminal.workspace)) { const content = readFileSync(file, 'utf8'); assert.ok(!content.includes(token), `token persisted: ${file}`); }
  }
  assert.ok(requests.every(r => r.auth === 'guest' && r.path.startsWith(`/v1/shared/${id}`)), 'guest must never use owner account or endpoints');
  trace.stages.push({ authority: 'guest only despite configured owner credential', tokenInOutputOrFiles: false });
  console.log('Guest PTY read/write, live assistant/reasoning SSE, replay, revocation and credential isolation passed.');
} finally {
  for (const terminal of terminals) {
    writeFileSync(join(dir, `screen-${terminals.indexOf(terminal)}.txt`), terminal.screen.replaceAll(token, '[redacted]'));
    writeFileSync(join(dir, `transcript-${terminals.indexOf(terminal)}.ansi`), (terminal.raw + terminal.errors).replaceAll(token, '[redacted]'));
    terminal.emulator.dispose(); terminal.child.stdin.end(); terminal.child.kill(); rmSync(terminal.workspace, { recursive: true, force: true });
  }
  trace.requests = requests; writeFileSync(join(dir, 'trace.json'), JSON.stringify(trace, null, 2) + '\n');
  for (const stream of streams) stream.end(); server.closeAllConnections(); server.close();
}
