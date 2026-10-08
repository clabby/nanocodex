import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectRelease, readPlan, planPath, installSelected, buildSelected, scopedRelease, startBuilds } from './release-plan.mjs';
import { workerSpecs } from './worker-inputs.mjs';
const fingerprints = Object.fromEntries(Object.keys(workerSpecs).map(name => [name, 'a'.repeat(64)]));

test('selection compares each Worker with its successful fingerprint and force bypasses history', async () => {
  const queried = [];
  const ledger = { async lastSuccessfulFingerprint(name) { queried.push(name); return name === 'x' ? 'b'.repeat(64) : name === 'email' ? null : fingerprints[name]; } };
  const plan = await selectRelease(fingerprints, { ledger, revision: 'revision' });
  assert.deepEqual(plan, { schema: 1, revision: 'revision', fingerprints, selected: ['x', 'email'] });
  assert.deepEqual(queried, Object.keys(workerSpecs));
  assert.deepEqual((await selectRelease(fingerprints, { ledger: { lastSuccessfulFingerprint() { throw Error('must not query'); } }, force: true })).selected, Object.keys(workerSpecs));
  assert.deepEqual((await selectRelease(fingerprints, { ledger: { async lastSuccessfulFingerprint(name) { return fingerprints[name]; } } })).selected, []);
  await assert.rejects(selectRelease({ ...fingerprints, x: 'invalid' }, { ledger }));
  await assert.rejects(selectRelease(fingerprints, { ledger: { async lastSuccessfulFingerprint() { throw Error('unavailable'); } } }), /unavailable/);
});

test('persisted plans reject stale revisions, invalid schemas, duplicate and unknown selections', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-plan-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const plan = { schema: 1, revision: 'revision', fingerprints, selected: ['x'] };
  const save = value => writeFileSync(join(cwd, planPath), JSON.stringify(value));
  save(plan); assert.deepEqual(readPlan(cwd, 'revision'), plan);
  assert.throws(() => readPlan(cwd, 'other'));
  for (const patch of [{ schema: 2 }, { selected: ['x', 'x'] }, { selected: ['unknown'] }, { selected: 'x' }, { fingerprints: { x: 'bad' } }]) {
    save({ ...plan, ...patch }); assert.throws(() => readPlan(cwd, 'revision'));
  }
});

test('release phases reuse successfully completed targets and never cache failed tiers', () => {
  const completed = new Set(), calls = [];
  for (const selected of [['egress'], ['managed'], ['account']]) {
    buildSelected({ selected }, (command, args) => calls.push([command, args]), completed);
  }
  const filters = calls.filter(([command]) => command === 'pnpm')
    .flatMap(([, args]) => args.filter((_, i) => args[i - 1] === '--filter'));
  assert.equal(new Set(filters).size, filters.length);
  assert.ok(filters.indexOf('nanocodex') < filters.indexOf('nanocodex-web'));
  assert.deepEqual(calls.filter(([, args]) => args[0]?.startsWith('js/managed/scripts/')), [
    [process.execPath, ['js/managed/scripts/prepare-code-evaluator.mjs']],
    [process.execPath, ['js/managed/scripts/prepare-just-bash-lazy.mjs']],
  ]);
  const failed = new Set();
  assert.throws(() => buildSelected({ selected: ['account'] }, (_, args) => {
    if (args.includes('nanocodex-terminal')) throw Error('second tier failed');
  }, failed), /second tier failed/);
  assert.deepEqual([...failed], ['nanocodex-tools', 'nanocodex-connect-protocol', 'nanocodex']);
});

const commands = (fn, selected) => { const calls = []; fn({ selected }, (...args) => calls.push(args)); return calls; };
test('managed-only scope includes its private media dependency before managed', () => {
  const selected = Object.keys(workerSpecs);
  assert.deepEqual(scopedRelease(selected, 'managed'), ['media', 'managed']);
  assert.deepEqual(scopedRelease(['managed'], 'managed'), ['media', 'managed']);
  assert.deepEqual(scopedRelease(selected, 'managed,account'), ['media', 'managed', 'account']);
  assert.deepEqual(scopedRelease(selected, 'account'), ['account']);
  assert.deepEqual(scopedRelease(selected, undefined), selected);
  assert.throws(() => scopedRelease(selected, 'media'));
  assert.deepEqual(commands(installSelected, ['media'])[0][1].slice(-2), ['--filter', 'nanocodex-media-service...']);
  assert.deepEqual(commands(buildSelected, ['media'])[0][1].slice(-2), ['--filter', 'nanocodex-tools']);
});

test('background builds let early phases deploy while leaf apps bundle, and surface failures', async () => {
  const { EventEmitter } = await import('node:events');
  const started = [], pending = [];
  const launch = (command, args) => {
    const child = new EventEmitter(); child.kill = () => {};
    started.push(args.join(' ')); pending.push({ args: args.join(' '), child });
    return child;
  };
  const finish = async (match, code = 0) => {
    await new Promise(resolve => setImmediate(resolve));
    const index = pending.findIndex(row => row.args.includes(match));
    assert.ok(index >= 0, `no running step matching ${match}: ${started.join(' | ')}`);
    pending.splice(index, 1)[0].child.emit('close', code);
    await new Promise(resolve => setImmediate(resolve));
  };
  const completed = new Set();
  const builds = startBuilds({ selected: ['managed', 'account'] }, { launch, env: {}, completedTargets: completed });
  let managed = false; const managedReady = builds.ready(['managed']).then(() => { managed = true; });
  const account = builds.ready(['account']); account.catch(() => {});
  await finish('nanocodex-tools');
  await finish('prepare-code-evaluator');
  await finish('prepare-just-bash-lazy');
  await managedReady;
  assert.ok(managed, 'managed is ready before second-tier and leaf builds finish');
  assert.ok(completed.has('nanocodex') && !completed.has('nanocodex-web'));
  await finish('nanocodex-connect-ui');
  // Leaf apps only bundle: no typecheck or turbo build script.
  assert.ok(started.some(args => args === '--filter nanocodex-web exec vite build'));
  await finish('nanocodex-web', 1);
  await assert.rejects(account, /Build step failed/);
  assert.ok(!completed.has('nanocodex-web'));
});
