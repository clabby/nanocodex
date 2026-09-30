import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { startSkyHost, createSession, frame, validateRequest, providerEnvironment, desktopEnvironment, checkManagedPolicy, runProvider } from '../../src/linux_sky_host.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function client(socketPath) {
  const socket = net.createConnection(socketPath);
  await once(socket, 'connect');
  let buffer = Buffer.alloc(0), next = 1;
  const pending = new Map();
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
      const length = buffer.readUInt32LE();
      const result = JSON.parse(buffer.subarray(4, 4 + length)); buffer = buffer.subarray(4 + length);
      pending.get(result.id)?.(result); pending.delete(result.id);
    }
  });
  return { socket, call(request, split = false) {
    const id = next++;
    const result = new Promise(resolve => pending.set(id, resolve));
    const bytes = frame({ id, request });
    if (split) { socket.write(bytes.subarray(0, 2)); socket.write(bytes.subarray(2, 7)); socket.write(bytes.subarray(7)); }
    else socket.write(bytes);
    return result;
  } };
}
test('private socket preserves fragmented RPC responses and serializes desktop calls across clients', async t => {
  let active = 0, high = 0, stopped = 0;
  const host = await startSkyHost({ makeSession: () => ({ async request(r) {
    active++; high = Math.max(high, active); await delay(15); active--; return r;
  }, async stop() { stopped++; } }) });
  t.after(() => host.dispose());
  assert.equal(fs.statSync(path.dirname(host.socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(host.socketPath).mode & 0o777, 0o600);
  const a = await client(host.socketPath), b = await client(host.socketPath);
  const request = { type: 'execute', method: 'type_text', args: [{ text: 'Unicode: Ω 🙂' }] };
  const responses = await Promise.all([a.call(request, true), b.call({ type: 'setup' })]);
  assert.deepEqual(responses[0].value, request); assert.equal(high, 1);
  await host.endTurn(); assert.equal(stopped, 2);
});
test('turn completion cancels queued calls and prevents stale replies', async t => {
  let release, calls = 0;
  const entered = new Promise(resolve => { release = resolve; });
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const host = await startSkyHost({ makeSession: () => ({ async request() { calls++; release(); await blocked; return 'done'; }, async stop() { finish(); } }) });
  t.after(() => host.dispose());
  const a = await client(host.socketPath);
  void a.call({ type: 'setup' }); void a.call({ type: 'setup' });
  await entered;
  const closed = once(a.socket, 'close');
  await host.endTurn(); await closed; await delay(10);
  assert.equal(calls, 1);
});
test('oversized frames and invalid requests close without invoking Sky', async t => {
  let calls = 0;
  const host = await startSkyHost({ makeSession: () => ({ async request() { calls++; }, async stop() {} }) });
  t.after(() => host.dispose());
  for (const bytes of [Buffer.from([1, 0, 0, 1]), frame({ id: 1, request: { type: 'shell', command: 'ignored' } })]) {
    const a = await client(host.socketPath); const closed = once(a.socket, 'close'); a.socket.write(bytes); await closed;
  }
  assert.equal(calls, 0);
  assert.throws(() => validateRequest({ type: 'execute', method: 'list_windows', args: {} }));
});
test('worker releases tracked drags through the unchanged service API', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-worker-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl'), service = path.join(dir, 'service.mjs');
  fs.writeFileSync(service, `import fs from 'node:fs'; export async function handleRpc(r) { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(r)+'\\n'); return r.type; }`);
  const session = createSession(service); t.after(() => session.stop());
  await session.request({ type: 'drag_start', handle_id: 'fixture', point: { x: 4, y: 5 } });
  await session.stop();
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.at(-1), { type: 'drag_end', handle_id: 'fixture' });
  await assert.rejects(session.request({ type: 'setup' }), /closed/);
});
test('a stuck native call has bounded shutdown and its helper process group is reaped', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-worker-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'pid'), service = path.join(dir, 'service.mjs');
  fs.writeFileSync(service, `import fs from 'node:fs'; import {spawn} from 'node:child_process'; export async function handleRpc() { const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(log)},String(p.pid)); return new Promise(()=>{}); }`);
  const session = createSession(service, { cleanupMs: 50 }); t.after(() => session.stop());
  const pending = session.request({ type: 'setup' }).catch(e => e);
  for (let i = 0; i < 100 && !fs.existsSync(log); i++) await delay(10);
  assert.ok(fs.existsSync(log));
  const pid = Number(fs.readFileSync(log, 'utf8'));
  const start = Date.now(); await session.stop(); assert.ok(Date.now() - start < 2000);
  assert.match(String(await pending), /ended|exited/);
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return; throw e; } await delay(10); }
  assert.fail('Native helper remained alive after shutdown');
});

test('computer-only environment never inherits Codex, browser, secrets or bootstrap overrides', () => {
  const env = { HOME: '/fixture', DISPLAY: ':77', NODE_REPL_NODE_MODULE_DIRS: '/upstream/modules',
    CODEX_CLI_PATH: '/never-run', CODEX_HOME: '/policy-only', TOKEN: 'private', NODE_OPTIONS: '--require=evil',
    CUA_REPL_ENABLED_SURFACES: 'computer', NODE_REPL_JS_BANNER: 'evil',
    NODE_REPL_TRUSTED_SERVICES: '{"browser":"evil"}', NODE_REPL_TRUSTED_CODE_PATHS: '/evil',
    NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: 'TOKEN' };
  const result = providerEnvironment(env, '/private/sky.sock');
  assert.equal(result.HOME, env.HOME); assert.equal(result.DISPLAY, env.DISPLAY);
  for (const key of ['CODEX_CLI_PATH', 'CODEX_HOME', 'TOKEN', 'NODE_OPTIONS', 'NODE_REPL_JS_BANNER']) assert.equal(result[key], undefined);
  assert.deepEqual(Object.keys(JSON.parse(result.NODE_REPL_TRUSTED_SERVICES)), ['sky']);
  assert.equal(result.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST, 'NANOCODEX_LINUX_SKY_SOCKET');
  assert.equal(result.NODE_REPL_DISABLE_ANALYTICS, '1');
  assert.ok(!result.NODE_REPL_TRUSTED_CODE_PATHS.includes('/evil'));
  assert.equal(desktopEnvironment(env).CODEX_CLI_PATH, undefined);
  for (const surfaces of ['browser', 'browser,computer', '', 'computer,computer', 'unknown']) {
    assert.throws(() => providerEnvironment({ ...env, CUA_REPL_ENABLED_SURFACES: surfaces }), /computer only/);
  }
});
test('known administrative Linux policy fails closed using metadata only', async () => {
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  const options = { home: '/fixture', codexHome: '/external', uid: 42, inspect: missing, follow: missing };
  await checkManagedPolicy(options);
  await assert.rejects(checkManagedPolicy({ ...options, codexHome: 'relative' }), /absolute/);
  for (const filename of ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml',
    '/fixture/.codex/requirements.toml', '/fixture/.codex/managed_config.toml', '/external/requirements.toml']) {
    await assert.rejects(checkManagedPolicy({ ...options, inspect: async file => file === filename ? { uid: 42 } : missing() }), /policy requires integration/);
  }
  const inspect = async file => file.endsWith('/config.toml') ? { uid: 42, isSymbolicLink: () => false } : missing();
  await checkManagedPolicy({ ...options, inspect }); // ordinary owner preferences aren't read
  await assert.rejects(checkManagedPolicy({ ...options, inspect: async file => file.endsWith('/config.toml') ? { uid: 43 } : missing() }), /Externally owned/);
  await assert.rejects(checkManagedPolicy({ ...options, inspect: async file => file.endsWith('/config.toml') ? { uid: 42, isSymbolicLink: () => true } : missing(), follow: async () => ({ uid: 43 }) }), /Externally owned/);
  await assert.rejects(checkManagedPolicy({ ...options, inspect: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
});
test('real wrapper preserves MCP/catalog/meta and child environment, resets Sky peers and reaps children on EOF', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-provider-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modules = path.join(dir, 'modules'), service = path.join(modules, '@oai/sky/dist/project/cua/sky_js/src/service.js');
  fs.mkdirSync(path.dirname(service), { recursive: true });
  fs.writeFileSync(service, `exports.handleRpc = async () => ({ cli: process.env.CODEX_CLI_PATH ?? null });`);
  const provider = path.join(dir, 'provider.mjs');
  fs.writeFileSync(provider, `import {createInterface} from 'node:readline';
    const catalog={tools:[{name:'js',inputSchema:{type:'object'},_meta:{upstream:'unmodified'}}],_meta:{catalog:7}};
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      const result=m.method==='tools/list'?catalog:m.method==='env'?process.env:{echo:m,_meta:{trace:'upstream'}};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output });
  const wrapper = await runProvider(provider, [], { platform: 'linux', env: {
    HOME: dir, NODE_REPL_NODE_MODULE_DIRS: modules, CODEX_CLI_PATH: '/never-run',
    NODE_REPL_TRUSTED_SERVICES: '{"browser":"evil"}',
  }, inputStream: input, outputStream: output, managedCheck: async () => {} });
  t.after(() => wrapper.stop()); t.after(() => lines.close());
  const call = async message => { const response = once(lines, 'line'); input.write(JSON.stringify(message)+'\n'); return JSON.parse((await response)[0]); };
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { _meta: { trusted: true }, capabilities: {} } };
  const response = await call(initialize);
  assert.deepEqual(response.result.echo, initialize); assert.deepEqual(response.result._meta, { trace: 'upstream' });
  assert.deepEqual((await call({ id: 2, method: 'tools/list' })).result,
    { tools: [{ name: 'js', inputSchema: { type: 'object' }, _meta: { upstream: 'unmodified' } }], _meta: { catalog: 7 } });
  const env = (await call({ id: 3, method: 'env' })).result;
  assert.equal(env.CODEX_CLI_PATH, undefined); assert.equal(env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.deepEqual(Object.keys(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES)), ['sky']);
  for (const message of [{ id: 4, method: 'tools/call', params: { name: 'js_reset' } },
    { id: 5, method: 'tools/call', params: { name: 'turn_ended' } }, { id: 6, method: 'notifications/cancelled', params: { requestId: 77 } }]) {
    const peer = await client(wrapper.host.socketPath);
    assert.deepEqual((await peer.call({ type: 'setup' })).value, { cli: null });
    const closed = once(peer.socket, 'close');
    assert.deepEqual((await call(message)).result.echo, message);
    await closed;
  }
  const socketPath = wrapper.host.socketPath;
  input.end(); await wrapper.stop();
  assert.equal(fs.existsSync(socketPath), false);
  assert.throws(() => process.kill(wrapper.child.pid, 0), { code: 'ESRCH' });
});
test('wrapper refuses browser or managed policy before starting a provider', async () => {
  await assert.rejects(runProvider('/never-launch', [], { platform: 'linux', env: { CUA_REPL_ENABLED_SURFACES: 'browser,computer' } }), /computer only/);
  await assert.rejects(runProvider('/never-launch', [], { platform: 'linux', env: { NODE_REPL_NODE_MODULE_DIRS: '/verified' }, managedCheck: async () => { throw new Error('policy denied'); } }), /policy denied/);
});
test('SIGKILL of wrapper owner reaps provider and Sky groups including TERM-ignoring descendants', async t => {
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-owner-death-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modules = path.join(dir, 'modules'), service = path.join(modules, '@oai/sky/dist/project/cua/sky_js/src/service.js');
  fs.mkdirSync(path.dirname(service), { recursive: true });
  const nativeLog = path.join(dir, 'native.json'), providerLog = path.join(dir, 'provider.json');
  const ignoring = 'process.on("SIGTERM",()=>{}); process.send({ready:true}); setInterval(()=>{},1000);';
  fs.writeFileSync(service, `const fs=require('node:fs');const {fork}=require('node:child_process');
    exports.handleRpc=async()=>{const helper=fork(${JSON.stringify(path.join(dir, 'ignore.mjs'))},[],{stdio:['ignore','ignore','ignore','ipc']});
    await new Promise(r=>helper.once('message',r));fs.writeFileSync(${JSON.stringify(nativeLog)},JSON.stringify([process.pid,helper.pid]));return true;};`);
  fs.writeFileSync(path.join(dir, 'ignore.mjs'), ignoring);
  const provider = path.join(dir, 'provider.mjs');
  fs.writeFileSync(provider, `import fs from 'node:fs';import net from 'node:net';import {fork} from 'node:child_process';
    process.on('SIGTERM',()=>{});
    const helper=fork(${JSON.stringify(path.join(dir, 'ignore.mjs'))},[],{stdio:['ignore','ignore','ignore','ipc']});
    await new Promise(r=>helper.once('message',r));fs.writeFileSync(${JSON.stringify(providerLog)},JSON.stringify({pids:[process.pid,helper.pid],socket:process.env.NANOCODEX_LINUX_SKY_SOCKET}));
    const peer=net.createConnection(process.env.NANOCODEX_LINUX_SKY_SOCKET);
    peer.on('error',()=>{});peer.on('connect',()=>{const b=Buffer.from(JSON.stringify({id:1,request:{type:'setup'}}));
      const f=Buffer.alloc(b.length+4);f.writeUInt32LE(b.length);b.copy(f,4);peer.write(f);});
    setInterval(()=>{},1000);`);
  const hostModule = new URL('../../src/linux_sky_host.mjs', import.meta.url).href;
  const owner = spawn(process.execPath, ['--input-type=module', '-e',
    `import {runProvider} from ${JSON.stringify(hostModule)};await runProvider(${JSON.stringify(provider)},[],{platform:'linux',env:{HOME:${JSON.stringify(dir)},NODE_REPL_NODE_MODULE_DIRS:${JSON.stringify(modules)}},managedCheck:async()=>{}});`],
    { stdio: ['pipe', 'ignore', 'pipe'] });
  owner.stderr.resume();
  let pids = [];
  t.after(() => { owner.kill('SIGKILL'); for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {} });
  for (let i=0;i<300 && !fs.existsSync(nativeLog);i++) await delay(10);
  assert.ok(fs.existsSync(nativeLog), 'provider and native fixtures started');
  const providerEvidence = JSON.parse(fs.readFileSync(providerLog));
  pids = [...providerEvidence.pids, ...JSON.parse(fs.readFileSync(nativeLog))];
  const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
  const alive = pid => {
    try {
      process.kill(pid, 0);
      // Linux container PID1 may delay adopting/reaping an already dead orphan.
      // A zombie has no executable/input authority and is not a live descendant.
      if (process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
      return true;
    } catch (e) { if (e.code === 'ESRCH' || e.code === 'ENOENT') return false; throw e; }
  };
  for (let i=0;i<400 && pids.some(alive);i++) await delay(10);
  assert.deepEqual(pids.filter(alive), [], 'no provider/service or TERM-ignoring descendant survived owner death');
  for (let i=0;i<100 && fs.existsSync(path.dirname(providerEvidence.socket));i++) await delay(10);
  assert.equal(fs.existsSync(path.dirname(providerEvidence.socket)), false, 'provider lease removed private socket directory after owner death');
});
test('provider lease cleanup never removes substituted files or symlink directories', async t => {
  const { fork } = await import('node:child_process');
  const lease = new URL('../../src/linux_sky_lease.mjs', import.meta.url);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocodex-sky-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-lease-safety-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const provider = path.join(other, 'exit.mjs'); fs.writeFileSync(provider, 'process.exit(0);');
  const file = path.join(directory, 'sky.sock'); fs.writeFileSync(file, 'must remain');
  const launch = async socket => {
    const watchdog = fork(lease, ['--cleanup-socket', socket, os.tmpdir(), provider], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    assert.deepEqual(await once(watchdog, 'exit'), [0, null]);
  };
  await launch(file); assert.equal(fs.readFileSync(file, 'utf8'), 'must remain');
  fs.rmSync(directory, { recursive: true });
  fs.writeFileSync(path.join(other, 'sky.sock'), 'symlink target must remain');
  fs.symlinkSync(other, directory, 'dir');
  await launch(file);
  assert.equal(fs.readFileSync(path.join(other, 'sky.sock'), 'utf8'), 'symlink target must remain');
  assert.ok(fs.lstatSync(directory).isSymbolicLink());
});
