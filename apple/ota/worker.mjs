/** Same-origin streaming IPA transport. Static assets: 25 MiB/file, no R2/remote fetch.
 * https://developers.cloudflare.com/workers/platform/limits/
 * https://developers.cloudflare.com/workers/static-assets/binding/
 * Metadata and every 1 MiB verification block are bounded. Corruption terminates the
 * stream (never releases the offending block); headers cannot be replaced mid-stream.
 */
const CHUNK = 24 * 1024 * 1024;
const BLOCK = 1024 * 1024;
const META_LIMIT = 65536;
const HASH = /^[0-9a-f]{64}$/;
const IPA = /^\/builds\/([0-9]+)\/Nanocodex\.ipa$/;

function exactKeys(obj, keys) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) &&
    Object.keys(obj).sort().join(',') === [...keys].sort().join(',');
}
function validate(meta, path, build) {
  if (!exactKeys(meta, ['version', 'path', 'size', 'sha256', 'chunkSize', 'blockSize', 'chunks']) ||
      meta.version !== 1 || meta.path !== path || typeof meta.sha256 !== 'string' || !HASH.test(meta.sha256) ||
      !Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size > CHUNK * 20 ||
      meta.chunkSize !== CHUNK || meta.blockSize !== BLOCK || !Array.isArray(meta.chunks) ||
      meta.chunks.length !== Math.ceil(meta.size / CHUNK)) throw new Error('Invalid metadata');
  meta.chunks.forEach((chunk, i) => {
    const size = Math.min(CHUNK, meta.size - i * CHUNK);
    if (!exactKeys(chunk, ['path', 'size', 'sha256', 'blocks']) || chunk.size !== size ||
        chunk.path !== `/__ota_chunks/${build}/${meta.sha256}/${String(i).padStart(4, '0')}.bin` ||
        typeof chunk.sha256 !== 'string' || !HASH.test(chunk.sha256) || !Array.isArray(chunk.blocks) ||
        chunk.blocks.length !== Math.ceil(size / BLOCK) || !chunk.blocks.every(h => typeof h === 'string' && HASH.test(h))) {
      throw new Error('Invalid chunk');
    }
  });
  return meta;
}
function assetRequest(request, path, method = 'GET') {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = '';
  // Never forward user-controlled Range, auth, redirects or conditional headers internally.
  return new Request(url, {method, headers: {'Accept-Encoding': 'identity'}, redirect: 'manual'});
}
async function boundedText(response) {
  const declared = response.headers.has('Content-Length') ? Number(response.headers.get('Content-Length')) : null;
  // ASSETS may omit Content-Length. Always bound and check the actual body.
  if ((declared !== null && (!Number.isSafeInteger(declared) || declared <= 0 || declared > META_LIMIT)) ||
      (response.headers.has('Content-Encoding') && response.headers.get('Content-Encoding') !== 'identity')) {
    await response.body?.cancel();
    throw new Error('Invalid metadata transport');
  }
  if (!response.body) throw new Error('Missing metadata body');
  const reader = response.body.getReader();
  const arrays = [];
  let total = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      total += value.length;
      if (total > META_LIMIT) throw new Error('Oversized metadata');
      arrays.push(value);
    }
  } finally { await reader.cancel(); }
  if (declared !== null && total !== declared) throw new Error('Truncated/overlong metadata');
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { buffer.set(a, offset); offset += a.length; }
  return new TextDecoder('utf-8', {fatal: true}).decode(buffer);
}
function range(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const a = match[1] ? Number(match[1]) : null;
  const b = match[2] ? Number(match[2]) : null;
  if ((a !== null && !Number.isSafeInteger(a)) || (b !== null && !Number.isSafeInteger(b))) return null;
  if (a === null) return b > 0 ? [Math.max(0, size - b), size - 1] : null;
  if (a >= size || (b !== null && b < a)) return null;
  return [a, b === null ? size - 1 : Math.min(b, size - 1)];
}
function checkAsset(response, size) {
  if (response.status !== 200 || (response.headers.has('Content-Length') && response.headers.get('Content-Length') !== String(size)) ||
      (response.headers.has('Content-Encoding') && response.headers.get('Content-Encoding') !== 'identity')) {
    throw new Error('Missing or invalid chunk asset');
  }
}
async function* verifiedBlocks(response, chunk) {
  checkAsset(response, chunk.size);
  if (!response.body) throw new Error('Missing chunk body');
  const reader = response.body.getReader();
  let pending, offset = 0, consumed = 0;
  try {
    for (let index = 0; index < chunk.blocks.length; index++) {
      const length = Math.min(BLOCK, chunk.size - consumed);
      const block = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        if (!pending || offset === pending.length) {
          const next = await reader.read();
          if (next.done) throw new Error('Truncated chunk');
          pending = next.value;
          offset = 0;
          // Asset streams normally deliver ~64 KiB. Reject a provider that attempts
          // to give us a whole IPA/chunk buffer: retain at most BLOCK + BLOCK bytes.
          if (pending.length > BLOCK) throw new Error('Oversized transport block');
          if (!pending.length) continue;
        }
        const n = Math.min(length - filled, pending.length - offset);
        block.set(pending.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
      }
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', block));
      const hex = Array.from(hash, v => v.toString(16).padStart(2, '0')).join('');
      if (hex !== chunk.blocks[index]) throw new Error('Chunk integrity failure');
      consumed += length;
      // Verify EOF BEFORE releasing the final block; never return extra/truncated bytes.
      if (consumed === chunk.size) {
        if (pending && offset < pending.length) throw new Error('Overlong chunk');
        if (!(await reader.read()).done) throw new Error('Overlong chunk');
      }
      yield block;
    }
  } finally { await reader.cancel(); }
}
function stream(request, assets, meta, start, end) {
  const iterator = (async function* () {
    for (let i = Math.floor(start / CHUNK); i <= Math.floor(end / CHUNK); i++) {
      const chunk = meta.chunks[i];
      const response = await assets.fetch(assetRequest(request, chunk.path));
      let blockStart = i * CHUNK;
      for await (const block of verifiedBlocks(response, chunk)) {
        const lo = Math.max(0, start - blockStart);
        const hi = Math.min(block.length, end + 1 - blockStart);
        if (hi > lo) yield block.subarray(lo, hi);
        blockStart += block.length;
        if (blockStart > end) break;
      }
    }
  })();
  const readable = new ReadableStream({
    async pull(controller) {
      try {
        const {value, done} = await iterator.next();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { controller.error(error); await iterator.return(); }
    },
    async cancel() { await iterator.return(); },
  }, {highWaterMark: 0});
  // Workers calculates Content-Length from FixedLengthStream, not a manually set
  // header on a generic stream. Native Node tests use the generic stream fallback.
  if (typeof FixedLengthStream !== 'undefined') {
    const fixed = new FixedLengthStream(end - start + 1);
    readable.pipeTo(fixed.writable).catch(() => {}); // propagates abort to readable
    return fixed.readable;
  }
  return readable;
}
async function smallAssetSize(request, assets, head, path) {
  if (head.headers.has('Content-Length')) {
    const size = Number(head.headers.get('Content-Length'));
    return Number.isSafeInteger(size) && size > 0 && size <= CHUNK;
  }
  // ASSETS may strip Content-Length. Bound actual bytes for legacy direct small
  // IPAs; ALL new IPAs use authenticated chunk metadata above. This legacy
  // native-asset compatibility fallback does not guarantee HEAD length or Range
  // handling when the binding strips/ignores those headers; it is not new-transport evidence.
  const response = await assets.fetch(assetRequest(request, path));
  if (response.status !== 200 || !response.body ||
      (response.headers.has('Content-Encoding') && response.headers.get('Content-Encoding') !== 'identity')) {
    await response.body?.cancel(); return false;
  }
  const reader = response.body.getReader(); let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) return size > 0;
      if (value.length > BLOCK) return false;
      size += value.length;
      if (size > CHUNK) return false;
    }
  } finally { await reader.cancel(); }
}
function failure(status = 503, headers = {}) {
  return new Response(null, {status, headers: {'Cache-Control': 'no-store', ...headers}});
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    // Internal chunks/metadata are not externally accessible through this Worker.
    // Static asset routing decodes percent escapes; never allow an encoded URL
    // to bypass the private-path guard. OTA public paths are plain ASCII.
    if (path.includes('%') || path === '/__ota_chunks' || path.startsWith('/__ota_chunks/') ||
        path.split('/').some(part => part.endsWith('.chunks.json'))) return failure(404);
    const match = IPA.exec(path);
    if (!match) return env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405, {Allow: 'GET, HEAD'});
    try {
      const response = await env.ASSETS.fetch(assetRequest(request, path + '.chunks.json'));
      if (response.status === 404) {
        const direct = await env.ASSETS.fetch(assetRequest(request, path, 'HEAD'));
        const okay = direct.status === 404 || (direct.status === 200 && await smallAssetSize(request, env.ASSETS, direct, path));
        await direct.body?.cancel();
        return okay ? env.ASSETS.fetch(request) : failure(); // existing direct small IPA only
      }
      if (response.status !== 200) return failure();
      const meta = validate(JSON.parse(await boundedText(response)), path, match[1]);
      // Sequential HEAD preflight finds missing chunks and declared size mismatches.
      // ASSETS can omit length; GET checks every block and exact EOF while streaming.
      // At most 20 HEAD + 20 GET + metadata fetch: below free-plan subrequest limit 50.
      for (const chunk of meta.chunks) {
        const head = await env.ASSETS.fetch(assetRequest(request, chunk.path, 'HEAD'));
        try { checkAsset(head, chunk.size); } finally { await head.body?.cancel(); }
      }
      const etag = `"sha256-${meta.sha256}"`;
      const headers = new Headers({
        'Content-Type': 'application/octet-stream', 'Content-Length': String(meta.size),
        'ETag': etag, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      if ((request.headers.get('If-None-Match') || '').split(',').some(v => v.trim() === etag || v.trim() === 'W/' + etag || v.trim() === '*')) {
        headers.delete('Content-Length');
        return new Response(null, {status: 304, headers});
      }
      let start = 0, end = meta.size - 1, status = 200;
      const wanted = request.headers.get('Range');
      const ifRange = request.headers.get('If-Range');
      // HTTP Range applies to GET; HEAD describes the complete representation.
      if (request.method === 'GET' && wanted && (!ifRange || ifRange === etag)) {
        const parsed = range(wanted, meta.size);
        if (!parsed) return failure(416, {'Content-Range': `bytes */${meta.size}`, 'Accept-Ranges': 'bytes'});
        [start, end] = parsed;
        status = 206;
        headers.set('Content-Range', `bytes ${start}-${end}/${meta.size}`);
        headers.set('Content-Length', String(end - start + 1));
      }
      return new Response(request.method === 'HEAD' ? null : stream(request, env.ASSETS, meta, start, end), {status, headers});
    } catch { return failure(); }
  },
};
