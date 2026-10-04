import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = createRequire(require.resolve('wrangler/package.json'))('miniflare');
const root = new URL('../', import.meta.url).pathname;

// The production Worker and encrypted credential Durable Objects execute in workerd.
// Only the remote recipient and unrelated WhatsApp network dependency are fixtures.
test('Vault request transport signs privately, escapes values, and enforces ownership and revocation', { timeout: 120_000 }, async () => {
  const bundle = await build({
    entryPoints: [root + 'src/egress.ts'], bundle: true, write: false,
    format: 'esm', platform: 'node', external: ['cloudflare:*', 'node:*'],
    alias: { 'node-rsa': root + '../nanocodex/tools/browser/unsupportedNodeRsa.mjs' },
    plugins: [{ name: 'external-transports', setup(b) {
      b.onResolve({ filter: /^nanocodex\/wasm$/ }, () => ({ path: './nanocodex.wasm', external: true }));
      b.onResolve({ filter: /^\.\/whatsapp-runtime$/ }, () => ({ path: root + 'test/whatsapp/runtime.fixture.ts' }));
    } }],
  });
  const logs = [];
  class CapturedLog extends Log { logWithLevel(level, message) { logs.push(String(message)); } }
  const trace = [];
  const secretOutputs = [];
  let expected;
  let outboundCalls = 0;
  const owner = 'vault-signing-synthetic-owner';
  const subject = 'A'.repeat(43), other = 'B'.repeat(43);
  const mf = new Miniflare(convertV4MiniflareOptions({
    log: new CapturedLog(LogLevel.DEBUG),
    handleStructuredLogs: log => { logs.push(JSON.stringify(log)); },
    workers: [{ name: 'vault-signing-journey',
      modules: [
        { type: 'ESModule', path: root + 'output/vault-signing-broker.js', contents: bundle.outputFiles[0].text },
        { type: 'CompiledWasm', path: root + 'output/nanocodex.wasm', contents: await readFile(process.env.NANOCODEX_TEST_WASM ?? root + '../nanocodex/pkg-web/nanocodex_bg.wasm') },
      ], compatibilityDate: '2026-07-29', compatibilityFlags: ['nodejs_compat'],
      bindings: { ENVIRONMENT: 'test', ALLOW_LOCAL_CREDENTIAL_CLAIM: 'true', CREDENTIAL_ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url') },
      durableObjects: Object.fromEntries(Object.entries({ USER_CREDENTIALS: 'UserCredentialBroker', AGENT_SUBJECTS: 'AgentSubjectDirectory', USER_CONNECTORS: 'UserConnectorBroker', MCP_CONNECTIONS: 'McpConnectionDirectory', WHATSAPP_ACCOUNTS: 'WhatsAppAccount', SPOTIFY_RATE_LIMITS: 'SpotifyRateLimit', GMAIL_PUSH_MAILBOXES: 'GmailPushMailbox' }).map(([key, className]) => [key, { className, useSQLite: true }])),
      outboundService: async request => {
        outboundCalls++;
        assert.ok(expected, 'no denied request may reach the recipient');
        assert.equal(request.headers.get('x-nanocodex-subject'), null);
        const body = await request.text();
        const credential = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? request.headers.get('x-signature');
        if (expected.hmac) {
          const correct = createHmac(expected.hmac, expected.key).update(expected.message).digest(expected.encoding);
          assert.equal(credential, correct);
        } else if (expected.publicKey) {
          const jwt = credential.split('.');
          const message = expected.jwt ? jwt.slice(0, 2).join('.') : expected.message;
          const signature = expected.jwt ? jwt[2] : credential;
          if (expected.jwt) {
            assert.equal(jwt.length, 3);
            assert.deepEqual(JSON.parse(Buffer.from(jwt[0], 'base64url')), { typ: 'JWT', alg: expected.algorithm });
            assert.deepEqual(JSON.parse(Buffer.from(jwt[1], 'base64url')), { iss: 'synthetic', aud: 'recipient', exp: 2_000_000_000 });
          }
          assert.equal(verify(expected.algorithm === 'EdDSA' ? null : 'sha256', Buffer.from(message), { key: expected.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, expected.encoding ?? 'base64url')), true);
        }
        if (expected.bodyEncoding === 'json') assert.deepEqual(JSON.parse(body), { nested: [expected.key], unchanged: 42, ['__proto__']: 'literal' });
        if (expected.bodyEncoding === 'form') assert.deepEqual([...new URLSearchParams(body)], [['key', expected.key], ['key', 'literal+value']]);
        if (expected.raw) assert.equal(body, expected.key);
        if (credential) secretOutputs.push(credential);
        trace.push({ boundary: 'recipient', algorithm: expected.algorithm ?? expected.hmac ?? 'injection', signature_verified: Boolean(expected.publicKey || expected.hmac), body_encoding: expected.bodyEncoding ?? 'raw' });
        // Deliberately reflect every credential in all response surfaces.
        const echo = [credential, body, expected.key].filter(Boolean).join('|');
        return new Response(echo, { status: expected.status ?? 201, headers: { 'x-reflected-credential': credential ?? 'body', location: 'https://attacker.example/' + encodeURIComponent(credential ?? body) } });
      },
    }],
  }));
  async function request(url, method, body, status = 200, headers = {}) {
    const response = await mf.dispatchFetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    trace.push({ boundary: 'broker', method, route: new URL(url).pathname.replace(owner, ':owner').replace(/[A-Za-z0-9_-]{22,}/g, ':id'), expected_status: status, observed_status: response.status, result: data });
    assert.equal(response.status, status, JSON.stringify(data));
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('x-reflected-credential'), null);
    return data;
  }
  async function save(key, kind = 'api_key') {
    secretOutputs.push(key);
    const metadata = await request(`https://broker.internal/users/${owner}/credentials/vault/${kind}`, 'POST', kind === 'api_key' ? { name: 'Synthetic signing key', api_key: key } : { name: 'Synthetic login', username: 'synthetic', password: key }, 201);
    assert.equal(JSON.stringify(metadata).includes(key), false);
    return metadata.id;
  }
  const send = (envelope, status = 200, selected = subject, route = '/v1/request') => request('https://vault-egress.internal' + route, 'POST', envelope, status, selected ? { 'x-nanocodex-subject': selected } : {});
  const envelope = (id, signing, extra = {}) => ({ vault_id: id, url: 'https://recipient.example.com/sign', method: 'POST', headers: { authorization: signing?.jwt ? 'Bearer {{NANOCODEX_VAULT_JWT}}' : 'Bearer {{NANOCODEX_VAULT_SIGNATURE}}' }, signing, ...extra });
  try {
    await request(`https://broker.internal/subjects/${subject}`, 'PUT', { user_id: owner });
    await request(`https://broker.internal/subjects/${other}`, 'PUT', { user_id: 'vault-signing-other' });
    let id, good;
    for (const [algorithm, hmac, keyEncoding, encoding] of [
      ['HMAC-SHA256', 'sha256', 'utf8', 'hex'],
      ['HMAC-SHA512', 'sha512', 'base64', 'base64'],
      ['HMAC-SHA256', 'sha256', 'hex', 'base64url'],
    ]) {
      const key = 'synthetic-key-雪-+/="&';
      id = await save(keyEncoding === 'utf8' ? key : Buffer.from(key).toString(keyEncoding));
      good = envelope(id, { algorithm, message: 'POST\n/payment\n雪', key_encoding: keyEncoding, encoding });
      expected = { hmac, key, message: good.signing.message, encoding };
      assert.deepEqual(await send(good), { status: 201, ok: true });
    }
    // Direct-owner service binding route uses the same core and does not need a subject.
    expected.status = 302;
    const preRedirectCalls = outboundCalls;
    assert.deepEqual(await send(good, 200, null, `/v1/users/${owner}/request`), { status: 302, ok: false });
    assert.equal(outboundCalls, preRedirectCalls + 1, 'redirect was not followed');
    expected.status = 500;
    const preFailureCalls = outboundCalls;
    assert.deepEqual(await send(good), { status: 500, ok: false });
    assert.equal(outboundCalls, preFailureCalls + 1, 'failed upstream request was not retried');
    const before = outboundCalls;
    expected = undefined;
    assert.deepEqual(await send(good, 409, other), { error: 'vault_entry_unavailable' });
    assert.deepEqual(await send(good, 409, null, '/v1/users/vault-signing-other/request'), { error: 'vault_entry_unavailable' });
    await send(good, 403, null);
    await send(good, 400, null, '/v1/users/%2F/request');
    for (const signing of [
      { algorithm: 'none', message: 'hello' },
      { algorithm: ['HMAC-SHA256'], message: 'x' },
      { algorithm: 'HMAC-SHA256', message: 'x', encoding: ['hex'] },
      { algorithm: 'HMAC-SHA256' },
      { algorithm: 'HMAC-SHA256', message: 'x', jwt: { header: {}, payload: {} } },
      { algorithm: 'HMAC-SHA256', jwt: { header: {}, payload: {} } },
      { algorithm: 'RS256', jwt: { header: { alg: 'none' }, payload: {} } },
      { algorithm: 'RS256', jwt: { header: { b64: false }, payload: {} } },
      { algorithm: 'ES256', message: '{{NANOCODEX_VAULT_API_KEY}}' },
    ]) await send(envelope(id, signing), 400);
    await send({ ...good, signing: undefined }, 400);
    await send({ ...good, headers: { authorization: 'Bearer {{NANOCODEX_VAULT_JWT}}' } }, 400);
    for (const url of ['http://recipient.example.com/plaintext', 'https://127.0.0.1/private', 'https://service.internal/private', 'https://api.github.com/user']) {
      await send({ ...good, url }, 403);
    }
    assert.equal(outboundCalls, before);
    await request(`https://broker.internal/users/${owner}/credentials/vault/api_key/${id}`, 'DELETE', undefined, 204);
    assert.deepEqual(await send(good, 409), { error: 'vault_entry_unavailable' });
    assert.equal(outboundCalls, before);
    for (const [algorithm, type, options, keyEncoding] of [
      ['RS256', 'rsa', { modulusLength: 2048 }, 'pkcs8'],
      ['ES256', 'ec', { namedCurve: 'prime256v1' }, 'base64'],
      ['EdDSA', 'ed25519', {}, 'hex'],
    ]) {
      const { privateKey, publicKey } = generateKeyPairSync(type, options);
      const key = keyEncoding === 'pkcs8' ? privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() : privateKey.export({ type: 'pkcs8', format: 'der' }).toString(keyEncoding);
      const keyId = await save(key);
      for (const jwt of [false, true]) {
        const signing = { algorithm, key_encoding: keyEncoding, ...(jwt ? { jwt: { header: { typ: 'JWT' }, payload: { iss: 'synthetic', aud: 'recipient', exp: 2_000_000_000 } } } : { message: 'independently verified message 雪' }) };
        expected = { publicKey, algorithm, jwt, message: signing.message };
        assert.deepEqual(await send(envelope(keyId, signing)), { status: 201, ok: true });
      }
    }
    const special = 'synthetic "quoted" \\ backslash\n雪 & = + %';
    const specialId = await save(special);
    for (const bodyEncoding of ['json', 'form', 'raw']) {
      const body = bodyEncoding === 'json' ? '{"nested":["{{NANOCODEX_VAULT_API_KEY}}"],"unchanged":42,"__proto__":"literal"}' : bodyEncoding === 'form' ? 'key=%7B%7BNANOCODEX_VAULT_API_KEY%7D%7D&key=literal%2Bvalue' : '{{NANOCODEX_VAULT_API_KEY}}';
      expected = { key: special, bodyEncoding, raw: bodyEncoding === 'raw' };
      assert.deepEqual(await send({ vault_id: specialId, url: 'https://recipient.example.com/body', method: 'POST', headers: {}, body, body_encoding: bodyEncoding }), { status: 201, ok: true });
    }
    expected = undefined;
    const badKey = await save('synthetic-invalid-pkcs8');
    assert.deepEqual(await send(envelope(badKey, { algorithm: 'RS256', message: 'x' }), 400), { error: 'vault_signing_failed' });
    const loginId = await save('synthetic-login-secret', 'login');
    assert.deepEqual(await send(envelope(loginId, { algorithm: 'HMAC-SHA256', message: 'x' }), 403), { error: 'vault_entry_kind_mismatch' });
    for (const [body_encoding, body] of [['json', '{bad'], ['json', '{"{{NANOCODEX_VAULT_API_KEY}}":"value"}'], ['form', 'key=%ZZ'], ['form', '{{NANOCODEX_VAULT_API_KEY}}=value']]) {
      await send({ vault_id: specialId, url: 'https://recipient.example.com/body', method: 'POST', headers: {}, body, body_encoding }, 400);
    }
    assert.ok(logs.some(line => line.includes('egress.request')), 'Worker audit logs were captured');
    // The artifact records only safe status receipts and verification outcomes.
    for (const secret of secretOutputs) {
      for (const representation of [secret, JSON.stringify(secret).slice(1, -1)]) {
        assert.equal(JSON.stringify(trace).includes(representation), false, 'credential leaked in broker receipt');
        assert.equal(logs.join('\n').includes(representation), false, 'credential leaked in Worker logs');
      }
    }
    await mkdir(root + 'output', { recursive: true });
    await writeFile(root + 'output/vault-signing-worker.log', logs.join('\n'));
  } finally {
    await mkdir(root + 'output', { recursive: true });
    await writeFile(root + 'output/vault-signing-journey.json', JSON.stringify(trace, null, 2));
    await mf.dispose();
  }
});
