// Desktop-user host for the unmodified @oai/sky/service on Linux.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function validateRequest(r) {
  if (!record(r)) throw new Error('Invalid Sky request');
  if (r.type === 'setup') return;
  if (r.type === 'execute' && typeof r.method === 'string' && Array.isArray(r.args)) return;
  if (['drag_start', 'drag_move', 'drag_end'].includes(r.type) && typeof r.handle_id === 'string' && r.handle_id.length > 0 && r.handle_id.length <= 256 && (r.type === 'drag_end' || record(r.point))) return;
  throw new Error('Invalid Sky request');
}
export function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 64 * 1024 * 1024) throw new Error('Sky response exceeds 64 MiB');
  const result = Buffer.allocUnsafe(body.length + 4);
  result.writeUInt32LE(body.length); body.copy(result, 4); return result;
}
export function createSession(servicePath, { cleanupMs = 3000 } = {}) {
  const child = fork(path.join(here, 'linux_sky_lease.mjs'), [path.join(here, 'linux_sky_worker.mjs'), servicePath], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [], env: desktopEnvironment(),
  });
  // Drain bounded native diagnostics without placing desktop data in host logs.
  child.stderr.resume();
  let nextId = 1, closed = false, stopping;
  const pending = new Map();
  const fail = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Sky desktop service exited')));
  child.on('message', message => {
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    message.error ? p.reject(new Error(message.error)) : p.resolve(message.value);
  });
  function send(message) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send({ id, ...message }, error => {
        if (error) { pending.delete(id); reject(error); }
      });
    });
  }
  return {
    pid: child.pid,
    async request(request) {
      if (closed) throw new Error('Sky session is closed');
      validateRequest(request);
      return send({ request });
    },
    stop() {
      if (stopping) return stopping;
      closed = true;
      stopping = (async () => {
        let timer;
        try {
          await Promise.race([send({ cleanup: true }), new Promise(resolve => { timer = setTimeout(resolve, cleanupMs); })]);
        } catch { /* Always reap the process group even after native failure. */ }
        finally { clearTimeout(timer); }
        fail(new Error('Sky session ended'));
        const kill = signal => { if (!child.pid) return; try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
        const exited = new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
        kill('SIGTERM');
        const force = setTimeout(() => kill('SIGKILL'), 1500);
        await exited;
        clearTimeout(force);
        // Reap a helper that outlived its service parent.
        kill('SIGKILL');
      })();
      return stopping;
    },
  };
}
export async function startSkyHost({ servicePath, directory, makeSession = () => createSession(servicePath) }) {
  const ownDirectory = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nanocodex-sky-'));
  fs.chmodSync(ownDirectory, 0o700);
  const socketPath = path.join(ownDirectory, 'sky.sock');
  const peers = new Map();
  let queue = Promise.resolve(), disposed = false, disposing;
  const serialize = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const server = net.createServer(socket => {
    if (disposed || peers.size >= 16) { socket.destroy(); return; }
    const session = makeSession();
    const peer = { session, closed: false, count: 0, stop: undefined };
    peers.set(socket, peer);
    const stop = () => {
      if (peer.stop) return peer.stop;
      peer.closed = true;
      peer.stop = session.stop().finally(() => peers.delete(socket));
      return peer.stop;
    };
    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('end', () => { void stop().catch(() => {}); });
    socket.on('close', () => { void stop().catch(() => {}); });
    socket.on('data', chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE();
          if (length > 8 * 1024 * 1024) throw new Error('Sky request exceeds 8 MiB');
          if (buffer.length < length + 4) break;
          const message = JSON.parse(buffer.subarray(4, length + 4));
          buffer = buffer.subarray(length + 4);
          if (!record(message) || !Number.isSafeInteger(message.id)) throw new Error('Invalid Sky frame');
          validateRequest(message.request);
          if (++peer.count > 16) throw new Error('Sky request queue is full');
          void serialize(async () => {
            if (peer.closed) return;
            let response;
            try { response = { id: message.id, value: await session.request(message.request) }; }
            catch (error) { response = { id: message.id, error: String(error.message ?? error) }; }
            if (!peer.closed && !socket.destroyed) socket.write(frame(response));
          }).catch(() => socket.destroy()).finally(() => { peer.count--; });
        }
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  const endTurn = async () => {
    const closing = [];
    for (const [socket, peer] of peers) {
      peer.closed = true; socket.destroy();
      closing.push(peer.stop ??= peer.session.stop().finally(() => peers.delete(socket)));
    }
    await Promise.allSettled(closing);
  };
  return { socketPath, endTurn, dispose() {
    return disposing ??= Promise.resolve().then(async () => {
    disposed = true; await endTurn();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(socketPath, { force: true });
    if (!directory) fs.rmdirSync(ownDirectory);
    });
  } };
}
// Standalone upstream node_repl is not a Codex-managed execution sandbox.
// Only desktop/runtime paths cross the boundary; never inherit Codex, tokens,
// NODE_OPTIONS, browser services, or model-controlled bootstrap overrides.
export function desktopEnvironment(env = process.env) {
  const result = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']) {
    if (env[key]) result[key] = env[key];
  }
  return result;
}
export function providerEnvironment(env, socketPath) {
  const surfaces = (env.CUA_REPL_ENABLED_SURFACES ?? 'computer').split(',').map(s => s.trim()).filter(Boolean);
  if (surfaces.length !== 1 || surfaces[0] !== 'computer') throw new Error('Linux standalone CUA supports computer only; browser requires a separate no-Codex port');
  const modules = env.NODE_REPL_NODE_MODULE_DIRS;
  if (!modules || !path.isAbsolute(modules)) throw new Error('An absolute verified OpenAI module directory is required');
  return { ...desktopEnvironment(env),
    CUA_REPL_ENABLED_SURFACES: 'computer',
    CUA_REPL_NODE_REPL_PATH: env.CUA_REPL_NODE_REPL_PATH,
    NODE_REPL_NODE_PATH: env.NODE_REPL_NODE_PATH,
    NODE_REPL_NODE_MODULE_DIRS: modules,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: path.join(here, 'linux_sky_proxy.mjs') }),
    NODE_REPL_TRUSTED_CODE_PATHS: [modules, here].join(path.delimiter),
    NANOCODEX_LINUX_SKY_SOCKET: socketPath,
    NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: 'NANOCODEX_LINUX_SKY_SOCKET',
    NODE_REPL_DISABLE_ANALYTICS: '1',
  };
}
// Metadata-only administrative policy detection. Do not read owner preferences
// or auth. Known enforced policy and ambiguous filesystem failures fail closed.
export async function checkManagedPolicy({ home = os.homedir(), codexHome = process.env.CODEX_HOME,
  inspect = fs.promises.lstat, follow = fs.promises.stat, uid = process.getuid() } = {}) {
  if (codexHome && !path.isAbsolute(codexHome)) throw new Error('CODEX_HOME policy path must be absolute; Linux CUA is disabled');
  const homes = [...new Set([path.join(home, '.codex'), codexHome].filter(Boolean))];
  const files = ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml'];
  for (const directory of homes) {
    files.push(path.join(directory, 'requirements.toml'), path.join(directory, 'managed_config.toml'));
    const config = path.join(directory, 'config.toml');
    try {
      const metadata = await inspect(config);
      if (metadata.uid !== uid || (metadata.isSymbolicLink?.() && (await follow(config)).uid !== uid)) throw new Error('Externally owned computer policy requires integration; Linux CUA is disabled');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const file of files) {
    try { await inspect(file); throw new Error('Managed computer policy requires integration; Linux CUA is disabled'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function runProvider(providerPath, providerArgs = [], {
  env = process.env, platform = process.platform, inputStream = process.stdin,
  outputStream = process.stdout, managedCheck = checkManagedPolicy,
} = {}) {
  if (platform !== 'linux') throw new Error('Linux Sky host requires Linux');
  // Validate before opening a desktop socket or launching any child.
  const childEnv = providerEnvironment(env);
  await managedCheck();
  const servicePath = path.join(childEnv.NODE_REPL_NODE_MODULE_DIRS, '@oai/sky/dist/project/cua/sky_js/src/service.js');
  const host = await startSkyHost({ servicePath });
  childEnv.NANOCODEX_LINUX_SKY_SOCKET = host.socketPath;
  const child = fork(path.join(here, 'linux_sky_lease.mjs'), ['--cleanup-socket', host.socketPath, os.tmpdir(), providerPath, ...providerArgs], {
    detached: true, stdio: ['pipe', 'pipe', 'inherit', 'ipc'], execArgv: [], env: childEnv,
  });
  child.stdout.pipe(outputStream, { end: false });
  const input = createInterface({ input: inputStream });
  let stopping;
  const stop = () => stopping ??= Promise.resolve().then(async () => {
    input.close(); inputStream.pause();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    const kill = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    const exited = new Promise(resolve => { if (!child.pid || child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', resolve); });
    kill('SIGTERM');
    const force = setTimeout(() => kill('SIGKILL'), 1500);
    try { await Promise.all([exited, host.dispose()]); }
    finally { clearTimeout(force); kill('SIGKILL'); }
  });
  const onSignal = () => { void stop(); };
  child.once('error', error => { console.error(error.message); process.exitCode = 1; void stop(); });
  child.once('exit', code => { if (!stopping) process.exitCode = code ?? 1; else process.exitCode ??= 0; void stop(); });
  child.stdin.on('error', () => { void stop(); });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  input.on('close', () => { void stop(); });
  let forwarding = Promise.resolve();
  input.on('line', line => {
    forwarding = forwarding.then(async () => {
      const message = JSON.parse(line);
      if (message.method === 'notifications/cancelled' || (message.method === 'tools/call' && ['js_reset', 'turn_ended'].includes(message.params?.name))) await host.endTurn();
      if (!stopping) child.stdin.write(line + '\n');
    }).catch(error => { console.error(error.message); void stop(); });
  });
  return { child, host, stop };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Expected the official CUA provider entry point');
  await runProvider(process.argv[2], process.argv.slice(3));
}
