#!/usr/bin/env node
/** Authenticated decision-inbox HTTP evidence. Never sends, approves, archives,
 * changes filters, or deploys. Native CLI precedence/store contract:
 * bin/nanocodex/account-auth/src/{lib,store}.rs and nanocodex2/README.md.
 * Run: node js/managed/scripts/decision-inbox-e2e.mjs --live-read
 * Optional authorized self draft: --prepare-self-draft --mailbox me@example.com
 * Read-only existing fixture: --reopen-self-draft --draft-id UUID --mailbox me@example.com
 * Existing native environment credentials are consumed only in memory. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const output = resolve(option('--output') ?? fileURLToPath(new URL('../../../output/mobile-decision-inbox/e2e', import.meta.url)));
const repeats = Number(option('--samples') ?? 7);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 30, 'samples must be 3..30');
if (!args.includes('--live-read')) throw Error('explicit --live-read required');
assert.ok(!(args.includes('--prepare-self-draft') && args.includes('--reopen-self-draft')), 'choose create OR reopen, never both');
const report = { timestamp: new Date().toISOString(), mode: 'live_authenticated_http', branch_deployed: false,
  auth: {}, privacy: 'No auth material, unrelated correspondence content, cookies, or response headers retained.',
  transport: 'native Node fetch, redirects forbidden, 30s timeout, JSON body fully consumed',
  timing_semantics: { cold: 'first observed request per route; actual Worker cold-start status unknown',
    warm: 'subsequent sequential client requests; server instance reuse unknown', p95: 'nearest-rank; small sample descriptive only' },
  calls: [], timings: {}, checks: [], send_gate: { status: 'blocked', reason: 'No exact current-draft user approval. Harness has no approve or send path.', provider_send_calls: 0 } };
let token;
try {
  // Ask the shipped CLI to validate its own selected credential without returning a secret.
  const status = spawnSync('nanocodex', ['account', 'status'], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  assert.equal(status.status, 0, 'native account status failed (output suppressed)');
  let selected; try { selected = JSON.parse(status.stdout); } catch { throw Error('native account status invalid JSON'); }
  assert.equal(selected.authenticated, true, 'native account is not authenticated');
  const base = new URL(selected.origin);
  assert.ok(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'unsafe account origin');
  assert.equal(base.origin, selected.origin, 'noncanonical account origin');
  report.auth = { authenticated: true, origin: base.origin, source: selected.source, boundary: 'shipped native CLI account status, documented CLI credential selection' };
  let environment = process.env;
  if (['NANOCODEX_API_KEY', 'NC_API_KEY'].includes(selected.source) && !Object.hasOwn(process.env, selected.source)) {
    // Shipped native main.rs calls dotenvy::dotenv(): nearest ancestor .env,
    // without overriding explicit environment. JS parser matches desktop runtime.
    let directory = process.cwd();
    while (true) {
      let bytes;
      try { bytes = await readFile(join(directory, '.env')); }
      catch (e) { if (e.code !== 'ENOENT') throw Error('native dotenv loading failed'); }
      if (bytes) {
        try { environment = { ...parseEnv(bytes.toString()), ...process.env }; }
        finally { bytes.fill(0); }
        report.auth.loading = 'native nearest-ancestor dotenv convention, node:util parseEnv matching desktop runtime';
        break;
      }
      if (directory === dirname(directory)) break;
      directory = dirname(directory);
    }
  }
  if (['NANOCODEX_API_KEY', 'NC_API_KEY'].includes(selected.source)) {
    token = environment[selected.source];
    assert.ok(token?.trim(), 'selected environment credential unavailable');
  } else if (selected.source === 'saved') {
    // Documented established store only. No scanning, mutations, or credential copies.
    const path = environment.NANOCODEX_ACCOUNT_FILE ?? join(environment.CODEX_HOME || join(homedir(), '.codex'), 'nanocodex-account.json');
    const st = await lstat(path); assert.ok(st.isFile() && !st.isSymbolicLink() && !(st.mode & 0o077) && st.size <= 65536, 'unsafe account store');
    const bytes = await readFile(path);
    try { const saved = JSON.parse(bytes.toString()); assert.equal(saved.version, 1, 'unsupported store'); token = saved.accounts?.[base.origin]?.api_key; } finally { bytes.fill(0); }
    assert.ok(token?.trim(), 'saved credential unavailable');
  } else throw Error('unsupported native credential source');

  async function call(path, method = 'GET', body, expected = 200, label = path.split('?')[0]) {
    assert.ok(path.startsWith('/v1/todo'), 'only TODO routes allowed');
    assert.ok(method === 'GET' || method === 'POST' && path === '/v1/todo/mail/drafts', 'only read and isolated draft persistence allowed');
    const start = performance.now();
    let response;
    try { response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw Error(`${label} transport outcome unknown; do not retry writes automatically`); }
    let data; try { data = await response.json(); } catch { throw Error(`${label} non-JSON response (suppressed)`); }
    const elapsed = Number((performance.now() - start).toFixed(2));
    report.calls.push({ route: label, method, status: response.status, duration_ms: elapsed, response_shape: Object.keys(data).sort() });
    assert.equal(response.status, expected, `${label} HTTP ${response.status} (response body suppressed)`);
    return data;
  }
  function timings(route) {
    const values = report.calls.filter(c => c.route === route).map(c => c.duration_ms), warm = values.slice(1).sort((a, b) => a - b);
    report.timings[route] = { first_observed_ms: values[0], warm_n: warm.length, warm_p50_ms: warm[Math.ceil(warm.length * .5) - 1], warm_p95_ms: warm[Math.ceil(warm.length * .95) - 1] };
  }
  const accountRoute = '/v1/todo/mail/accounts';
  const accounts = (await call(accountRoute)).accounts;
  assert.ok(Array.isArray(accounts), 'accounts shape');
  report.account_shape = { count: accounts.length, gmail_available: accounts.some(a => a.email) };
  for (let i = 0; i < repeats; i++) await call(accountRoute);
  timings(accountRoute);
  const mailbox = option('--mailbox');
  const account = mailbox ? accounts.find(a => a.email?.toLowerCase() === mailbox.toLowerCase()) : accounts.find(a => a.email);
  assert.ok(account, 'requested mailbox unavailable');
  const connection = account.connection_id;
  // Read queue counts, not titles, body, participant identities, or private sources.
  for (let i = 0; i <= repeats; i++) {
    const data = await call('/v1/todo');
    if (!i) report.inbox_shape = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? { count: v.length } : { type: typeof v }]));
  }
  timings('/v1/todo');
  const from = new Date().toISOString(), to = new Date(Date.now() + 86400000).toISOString();
  for (let i = 0; i <= repeats; i++) {
    const data = await call(`/v1/todo/schedule?connection_id=${encodeURIComponent(connection)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!i) report.schedule_shape = { events_count: data.events?.length, partial: data.partial, errors_count: data.errors?.length };
  }
  timings('/v1/todo/schedule');
  // Empty fixture-tag query avoids pulling arbitrary inbox mail into evidence.
  const tag = 'NANOCODEX-DECISION-INBOX-E2E';
  for (let i = 0; i <= repeats; i++) {
    const data = await call(`/v1/todo/mail/threads?connection_id=${encodeURIComponent(connection)}&q=${encodeURIComponent('subject:"' + tag + '"')}`);
    if (!i) report.fixture_threads_shape = { count: data.threads?.length, has_next_page: Boolean(data.next_page_token) };
  }
  timings('/v1/todo/mail/threads');
  report.checks.push({ name: 'existing production authenticated read routes', status: 'passed' });
  await mkdir(output, { recursive: true });
  // Publish baseline before draft side effects, so progress remains available.
  await writeFile(join(output, 'live-read.json'), JSON.stringify(report, null, 2) + '\n');
  if (args.includes('--prepare-self-draft')) {
    assert.ok(mailbox, 'self draft requires exact --mailbox selection');
    assert.equal(account.email.toLowerCase(), mailbox.toLowerCase());
    const stateFile = join(output, 'self-draft-operation.json');
    let input;
    try { input = JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw Error('cannot read fixture operation'); }
    if (!input) {
      input = { id: crypto.randomUUID(), version: 0, connection_id: connection, mode: 'compose', to: [account.email], cc: [], bcc: [],
        subject: `[${tag}] exact approval fixture`, body_text: 'This is an isolated self-addressed Nanocodex mobile decision inbox test fixture.\nNo outgoing send is authorized until you approve this exact draft.\nFixture stage: prepared.', thread_id: null, reply_message_id: null };
      await writeFile(stateFile, JSON.stringify(input, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } else throw Error('fixture operation already exists: inspect saved draft rather than automatically repeating write');
    const created = (await call('/v1/todo/mail/drafts', 'POST', input, 201, 'fixture_create')).draft;
    assert.equal(created.id, input.id); assert.equal(created.version, 1); assert.equal(created.status, 'draft');
    const reopened = (await call('/v1/todo/mail/drafts/' + input.id, 'GET', undefined, 200, 'fixture_reopen_v1')).draft;
    assert.equal(reopened.body_text, input.body_text); assert.deepEqual(reopened.to, input.to);
    const editedBody = input.body_text.replace('Fixture stage: prepared.', 'Fixture stage: edited and reopened.');
    const edited = (await call('/v1/todo/mail/drafts', 'POST', { ...input, version: created.version, body_text: editedBody }, 200, 'fixture_edit')).draft;
    assert.equal(edited.version, 2); assert.equal(edited.status, 'draft');
    const final = (await call('/v1/todo/mail/drafts/' + input.id, 'GET', undefined, 200, 'fixture_reopen_v2')).draft;
    assert.equal(final.body_text, editedBody); assert.deepEqual(final.to, input.to); assert.equal(final.version, 2);
    // Deliberately stale save, not approval/send. Genuine optimistic concurrency rejection.
    await call('/v1/todo/mail/drafts', 'POST', { ...input, version: 1 }, 409, 'fixture_stale_edit');
    const unchanged = (await call('/v1/todo/mail/drafts/' + input.id, 'GET', undefined, 200, 'fixture_read_after_conflict')).draft;
    assert.equal(unchanged.body_text, editedBody); assert.equal(unchanged.version, 2);
    report.fixture = { draft_id: final.id, version: final.version, recipient: final.to[0], cc: [], bcc: [], subject: final.subject, body_text: final.body_text,
      mode: final.mode, status: final.status, persistence: 'managed account draft; not claiming Gmail draft synchronization',
      exact_send_preview: { draft_id: final.id, version: final.version, operation_id: null }, approval: 'not obtained', sent: false };
    report.checks.push({ name: 'live self-addressed draft create, reopen, edit, reopen, stale-write rejection', status: 'passed' });
  }
  if (args.includes('--reopen-self-draft')) {
    const draftID = option('--draft-id');
    assert.ok(mailbox && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draftID ?? ''), 'reopen requires exact --draft-id and --mailbox');
    const draft = (await call('/v1/todo/mail/drafts/' + draftID, 'GET', undefined, 200, 'fixture_readonly_reopen')).draft;
    assert.equal(draft.id, draftID); assert.equal(draft.connection_id, connection);
    assert.deepEqual(draft.to, [account.email]); assert.deepEqual(draft.cc, []); assert.deepEqual(draft.bcc, []);
    assert.equal(draft.subject, '[' + tag + '] exact approval fixture');
    assert.equal(draft.status, 'draft', 'existing fixture no longer an unsent draft');
    report.fixture = { draft_id: draft.id, version: draft.version, recipient: draft.to[0], cc: [], bcc: [], subject: draft.subject, body_text: draft.body_text,
      mode: draft.mode, status: draft.status, persistence: 'managed account draft; not claiming Gmail draft synchronization',
      approval: 'not obtained', sent: false, writes_this_run: 0 };
    report.checks.push({ name: 'existing live self fixture reopened read-only; no duplicate draft or send', status: 'passed' });
  }
  await writeFile(join(output, 'live-read.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: 'passed', auth: report.auth, timings: report.timings, fixture: report.fixture, send_gate: report.send_gate, evidence: join(output, 'live-read.json') }, null, 2));
} catch (error) {
  // Never log raw network/provider response or stacks; controlled assertion messages only.
  report.failure = String(error.message).replace(/ncx_live_[A-Za-z0-9_-]+/g, '[REDACTED]');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'live-read.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(JSON.stringify({ result: 'failed', failure: report.failure, evidence: join(output, 'live-read.json') }));
  process.exitCode = 1;
} finally { token = undefined; }
