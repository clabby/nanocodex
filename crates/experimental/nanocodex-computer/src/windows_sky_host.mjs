// Windows native-pipe transport fixtures for upstream WindowsHelperTransport.
// Production launch is disabled: the Windows native helper policy contract has
// not been verified without an official Codex executable/app-server.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const LIMIT = 8 * 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const turnKey = meta => record(meta) && ['session_id', 'turn_id'].every(k => typeof meta[k] === 'string' && meta[k].trim())
  ? `${meta.session_id}\0${meta.turn_id}` : null;

export function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 64 * 1024 * 1024) throw new Error('Computer Use native pipe response exceeds 64 MiB');
  const result = Buffer.allocUnsafe(body.length + 4);
  result.writeUInt32LE(body.length);
  body.copy(result, 4);
  return result;
}

export async function startSkyHost({ makeTransport, pipePath = `\\\\.\\pipe\\nanocodex-sky-${randomUUID()}`, approvalTimeoutMs = 300000 }) {
  const sockets = new Set();
  const approvals = new Map();
  let transport = null, active = null, generation = 0, closing = null, disposed = false;
  const send = (socket, value) => { if (!socket.destroyed) socket.write(frame(value)); };
  const rejectApprovals = reason => {
    for (const entry of approvals.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    approvals.clear();
  };
  async function closeHelper(reason = 'Computer Use turn ended') {
    generation++;
    rejectApprovals(reason);
    const previous = transport;
    transport = null;
    active = null;
    if (closing) await closing;
    if (previous) {
      const operation = Promise.resolve().then(() => previous.close());
      closing = operation;
      try { await operation; } finally { if (closing === operation) closing = null; }
    }
  }
  function approve(socket, params, epoch) {
    if (disposed || generation !== epoch || socket.destroyed) return Promise.reject(new Error('Computer Use request ended'));
    return new Promise((resolve, reject) => {
      const id = `computer-use-approval:${randomUUID()}`;
      const timer = setTimeout(() => { approvals.delete(id); reject(new Error('Computer Use app approval timed out')); }, approvalTimeoutMs);
      approvals.set(id, { socket, resolve, reject, timer });
      send(socket, { jsonrpc: '2.0', id, method: 'requestComputerUseApproval', params });
    });
  }
  async function dispatch(socket, message) {
    if (!record(message) || message.jsonrpc !== '2.0') throw new Error('Invalid native pipe message');
    if (typeof message.id === 'string' && message.id.startsWith('computer-use-approval:')) {
      const pending = approvals.get(message.id);
      // Replies are bound to the connection that requested human approval.
      if (!pending || pending.socket !== socket || message.method !== undefined) return;
      approvals.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(String(message.error.message)));
      else if (!record(message.result) || !['accept', 'decline', 'cancel'].includes(message.result.action)) pending.reject(new Error('Invalid approval response'));
      else pending.resolve(message.result);
      return;
    }
    if (!['string', 'number'].includes(typeof message.id)) return;
    const reply = result => send(socket, { jsonrpc: '2.0', id: message.id, result });
    let owned = null;
    try {
      if (message.method === 'close') { await closeHelper(); reply(null); return; }
      if (message.method === 'request' && message.params?.method === 'end_turn') {
        if (active && turnKey(message.params.codexTurnMetadata) !== active.key) throw new Error('Computer Use turn mismatch');
        await closeHelper(); reply(null); return;
      }
      if (active?.busy || closing) throw new Error('Computer Use helper already has an active request');
      if (message.method === 'ping') { reply('pong'); return; }
      const request = message.params;
      if (message.method !== 'request' || !record(request) || typeof request.method !== 'string' || !request.method.trim() || !record(request.params)) throw new Error('Invalid Computer Use request');
      const key = turnKey(request.codexTurnMetadata);
      if (!key) throw new Error('Computer Use requires host turn metadata');
      if (Object.hasOwn(request.codexTurnMetadata, 'x-oai-cua-approved-app')) throw new Error('Computer Use approval must come from the host elicitation');
      if (active && active.key !== key) await closeHelper();
      const epoch = generation;
      active = owned = { key, socket, busy: true };
      transport ??= makeTransport();
      const result = await transport.request(request.method, request.params, {
        codexTurnMetadata: request.codexTurnMetadata,
        createElicitation: params => approve(socket, params, epoch),
      });
      if (generation === epoch && !socket.destroyed) reply(result);
    } catch (error) {
      send(socket, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } });
    } finally {
      if (owned && active === owned) active.busy = false;
    }
  }
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE();
        if (length > LIMIT) { socket.destroy(); return; }
        if (buffer.length < length + 4) break;
        const body = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4);
        try { void dispatch(socket, JSON.parse(body)).catch(() => socket.destroy()); }
        catch { socket.destroy(); return; }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      if (active?.socket === socket || sockets.size === 0) void closeHelper('Computer Use native pipe client disconnected').catch(() => {});
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
  return {
    pipePath,
    endTurn: closeHelper,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const socket of sockets) socket.destroy();
      await closeHelper('Computer Use native pipe is shutting down');
      await new Promise(resolve => server.close(resolve));
    },
  };
}

// Keep the injectable framing/approval bridge testable, but never launch an
// unverified helper or reuse a legacy receipt that depends on Codex. The JS
// transport alone does not prove the native helper's policy dependencies.
export const WINDOWS_NATIVE_CONTRACT_BLOCKER = 'Windows upstream CUA is unsupported: the native helper policy contract without Codex has not been verified. No provider or helper was started.';
export async function runProvider() {
  throw new Error(WINDOWS_NATIVE_CONTRACT_BLOCKER);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runProvider();
}
