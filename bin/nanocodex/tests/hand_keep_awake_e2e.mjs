// Opt-in macOS journey: temporarily toggles the real running Hand's power
// preference, verifies actual OS assertions, and restores the original setting.
// Does not restart/stop the Hand, sign in, lock/unlock, or change OS sleep policy.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
assert.equal(process.platform, 'darwin');
assert.ok(process.argv[2], 'usage: node hand_keep_awake_e2e.mjs CLI [OUTPUT_DIR]');
const cli = resolve(process.argv[2]);
const output = resolve(process.argv[3] ?? 'output/hand-keep-awake-e2e');
mkdirSync(output, { recursive: true });
const setting = join(homedir(), '.nanocodex/hand-keep-awake.json');
const original = existsSync(setting) ? readFileSync(setting) : null;
const plist = join(homedir(), 'Library/LaunchAgents/com.nanocodex.hand.plist');
const definition = readFileSync(plist);
const transcript = [];
function run(program, args, expected = 0) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 10_000 });
  transcript.push(`$ ${program} ${args.join(' ')}\nexit=${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  writeFileSync(join(output, 'transcript.log'), transcript.join('\n'));
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stderr);
  return result.stdout;
}
const owner = JSON.parse(run(cli, ['hand', 'status']));
assert.ok(owner.loaded && owner.pid);
const initial = JSON.parse(run(cli, ['hand', 'keep-awake']));
assert.equal(initial.supported_daemon, true, 'Update the running Hand before this journey');
assert.notEqual(initial.environment_override, true, 'The legacy service override must be absent');
if (original === null) assert.equal(initial.configured, true, 'Fresh setting defaults on');
let verdict = 'FAILED';
let mutated = false;
try {
  for (const enabled of [false, true, true]) {
    mutated = true;
    const changed = JSON.parse(run(cli, ['hand', 'keep-awake', enabled ? 'on' : 'off']));
    assert.equal(changed.configured, enabled);
    assert.equal(changed.active, enabled);
    assert.equal(JSON.parse(readFileSync(setting)).enabled, enabled);
    assert.equal(JSON.parse(run(cli, ['hand', 'keep-awake'])).configured, enabled,
      'A new CLI process observes the persisted preference');
    assert.deepEqual(JSON.parse(run(cli, ['hand', 'status'])), owner, 'No daemon restart');
    assert.deepEqual(readFileSync(plist), definition, 'No service configuration rewrite');
    const children = run('/bin/ps', ['-axo', 'pid=,ppid=,comm=']).split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match && Number(match[2]) === owner.pid && match[3].endsWith('/caffeinate') ? [Number(match[1])] : [];
    });
    assert.equal(children.length, enabled ? 1 : 0, 'Exactly one owned helper when enabled');
    if (enabled) {
      // The helper can exist just before macOS records its assertion.
      let assertions = '';
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        assertions = run('/usr/bin/pmset', ['-g', 'assertions']);
        if (assertions.includes(`pid ${children[0]}(caffeinate):`)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const line = assertions.split('\n').find(line => line.includes(`pid ${children[0]}(caffeinate):`));
      assert.ok(line?.includes('PreventUserIdleSystemSleep'));
      assert.ok(!line.includes('PreventUserIdleDisplaySleep'), 'Display may sleep and lock');
      assert.ok(assertions.includes(`Created for PID: ${owner.pid}.`));
    }
  }
  const beforeInvalid = readFileSync(setting);
  run(cli, ['hand', 'keep-awake', 'invalid'], 2);
  assert.deepEqual(readFileSync(setting), beforeInvalid);
  verdict = 'PASS';
} finally {
  if (mutated) {
    run(cli, ['hand', 'keep-awake', initial.configured ? 'on' : 'off']);
    if (original === null) rmSync(setting);
    else writeFileSync(setting, original);
  }
  transcript.push(`${verdict}: persisted off/on/repeated-on and invalid input; same daemon PID; actual macOS idle-system assertion, no display assertion; original preference restored. Lock-screen interaction, lid-close, and a stopped service are not exercised.`);
  writeFileSync(join(output, 'transcript.log'), transcript.join('\n'));
}
console.log(`${verdict}: ${join(output, 'transcript.log')}`);
