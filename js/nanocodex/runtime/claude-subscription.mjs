// Authority-bearing host glue only: all OAuth transitions are Rust-owned.
// Neither this bridge nor its private results belong in session/tool/model state.
const hosts = new Map();
const MAX_BYTES = 64 * 1024;
const TOKEN = 'https://platform.claude.com/v1/oauth/token';
const PROFILE = 'https://api.anthropic.com/api/oauth/profile';

export async function openSubscription(options, openRaw, { replaceHost = false } = {}) {
  if (!options || typeof options.id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(options.id)) throw new TypeError('Claude subscription requires a stable bounded id');
  if (typeof options.store?.load !== 'function' || typeof options.store?.compareAndSwap !== 'function') throw new TypeError('Claude subscription requires private CAS storage');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new TypeError('Claude subscription fetch must be a function');
  const host = { store: options.store, fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)) };
  if (!replaceHost && hosts.has(options.id)) throw new Error('Claude subscription already open');
  const id = options.id;
  hosts.set(id, host);
  globalThis.nanocodexClaudeSubscriptionHost = bridge;
  try {
    const raw = await openRaw(JSON.stringify({ id }));
    let disposed = false;
    const call = async (name, ...args) => {
      if (disposed || hosts.get(id) !== host) throw new Error('Claude subscription host is no longer owned');
      return raw[name](...args);
    };
    return Object.freeze({
      id,
      startLogin: async () => JSON.parse(await call('startLogin')),
      completeLogin: async (code) => {
        if (typeof code !== 'string' || code.length > 8192) throw new TypeError('invalid private Claude code');
        return JSON.parse(await call('completeLogin', code));
      },
      status: async () => JSON.parse(await call('status')),
      // PRIVATE outbound capability; no public account endpoint may return this.
      credential: async () => JSON.parse(await call('credential')),
      recover: async (rejectedHeaders) => call('recover', JSON.stringify(rejectedHeaders)),
      logout: async () => call('logout'),
      dispose() { if (disposed) return; disposed = true; if (hosts.get(id) === host) hosts.delete(id); raw.free(); },
    });
  } catch { if (hosts.get(id) === host) hosts.delete(id); throw new Error('Claude subscription unavailable'); }
}
const bridge = Object.freeze({
  async claudeSubscriptionLoad(id) {
    const row = await requiredHost(id).store.load(id);
    return JSON.stringify({ revision: revision(row?.revision), ...(row?.payload == null ? {} : { payload: payload(row.payload) }) });
  },
  async claudeSubscriptionCompareAndSwap(id, expectedRevision, value) {
    const result = await requiredHost(id).store.compareAndSwap(id, { expectedRevision: revision(expectedRevision), payload: payload(value) });
    if (result?.status === 'committed') return JSON.stringify({ status: 'committed', revision: revision(result.revision) });
    if (result?.status === 'conflict') return JSON.stringify({ status: 'conflict', actual_revision: revision(result.actualRevision) });
    throw new Error('Claude CAS unavailable');
  },
  async claudeSubscriptionRequest(id, encoded) {
    const host = requiredHost(id);
    const input = JSON.parse(encoded);
    if (!((input.method === 'POST' && [TOKEN, TOKEN + '/revoke'].includes(input.url)) || (input.method === 'GET' && input.url === PROFILE))) throw new Error('Claude HTTP destination denied');
    if (!Number.isSafeInteger(input.timeoutMillis) || input.timeoutMillis < 1 || input.timeoutMillis > 30000 || !Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 1 || input.maxResponseBytes > MAX_BYTES) throw new Error('Claude HTTP bounds invalid');
    const controller = new AbortController();
    let timer;
    const abort = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Claude HTTP deadline')); }, input.timeoutMillis); });
    try {
      // No retries, no redirects: an uncertain token POST is fenced in Rust CAS.
      return await Promise.race([abort, (async () => {
        const response = await host.fetch(input.url, { method: input.method, headers: input.headers,
          ...(input.method === 'POST' ? { body: input.body } : {}), redirect: 'manual', signal: controller.signal });
        if (!(response instanceof Response)) throw new Error('Claude HTTP unavailable');
        return JSON.stringify({ status: response.status, body: await readBounded(response, input.maxResponseBytes) });
      })()]);
    } catch { throw new Error('Claude private HTTP unavailable'); }
    finally { clearTimeout(timer); }
  },
});
function requiredHost(id) { const host = hosts.get(id); if (!host) throw new Error('Claude host unavailable'); return host; }
function revision(value) { if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18446744073709551615n) throw new TypeError('invalid Claude revision'); return value; }
function payload(value) { if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_BYTES) throw new TypeError('invalid Claude private state'); return value; }
async function readBounded(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let body = '';
  try { while (true) { const {done, value} = await reader.read(); if (done) return body + decoder.decode(); bytes += value.byteLength; if (bytes > limit) { await reader.cancel(); throw new Error('Claude response exceeds bound'); } body += decoder.decode(value, {stream: true}); } }
  finally { reader.releaseLock(); }
}
