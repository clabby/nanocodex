// Run with: node bin/nanocodex/tests/update_source_e2e.mjs target/debug/nanocodex
// Git and Cargo are real; only the GitHub URL and PR metadata point at a local fixture.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const binary = resolve(process.argv[2] ?? 'target/debug/nanocodex');
const fixture = mkdtempSync(join(tmpdir(), 'nanocodex-source-e2e-'));
const output = resolve('output/update-source-e2e');
mkdirSync(output, { recursive: true });
const transcript = [];

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? fixture,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: 300_000,
  });
  transcript.push(`$ ${program} ${args.join(' ')}\nexit: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n`);
  if (options.success !== false) {
    assert.equal(result.status, 0, `${program} ${args.join(' ')}: ${result.stderr}`);
  }
  return result;
}

try {
  const source = join(fixture, 'source');
  const remote = join(fixture, 'remote.git');
  const store = join(fixture, 'install');
  const home = join(fixture, 'home');
  const tools = join(fixture, 'tools');
  mkdirSync(source);
  mkdirSync(store);
  mkdirSync(home);
  mkdirSync(tools);
  writeFileSync(join(store, 'automatic-updates-disabled'), '');
  run('git', ['init', '--bare', remote]);
  run('git', ['init', '-b', 'topic'], { cwd: source });
  writeFileSync(join(source, 'Cargo.toml'), '[workspace]\nresolver = "2"\nmembers = ["cli", "hand"]\n');
  for (const [dir, packageName, binaryName] of [
    ['cli', 'nanocodex-bin', 'nanocodex'],
    ['hand', 'nanocodex2-bin', 'nanocodex2'],
  ]) {
    const path = join(source, dir);
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'Cargo.toml'), `[package]\nname = "${packageName}"\nversion = "0.1.0"\nedition = "2024"\n[[bin]]\nname = "${binaryName}"\npath = "src/main.rs"\n[features]\ntempo = []\n`);
    writeFileSync(join(path, 'src/main.rs'), `fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--version") {
        println!("${binaryName} Version: 0.1.0-dev\\nCommit SHA: {}", env!("STABLE_GIT_COMMIT"));
    } else if args.get(1).map(String::as_str) == Some("__device-hand") {
        println!("{{\\"serviceProtocol\\":1}}");
    }
}
`);
  }
  writeFileSync(join(source, 'nanocodex-vm.entitlements'), '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>');
  run('cargo', ['generate-lockfile', '--offline'], { cwd: source });
  run('git', ['add', '.'], { cwd: source });
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic source'], { cwd: source });
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim();
  run('git', ['push', remote, 'HEAD:refs/heads/topic', 'HEAD:refs/pull/42/head'], { cwd: source });

  const gh = join(tools, 'gh');
  writeFileSync(gh, '#!/bin/sh\nprintf \'{"headRefOid":"%s","state":"%s"}\\n\' "$FIXTURE_PR_SHA" "$FIXTURE_PR_STATE"\n', { mode: 0o755 });
  const env = {
    HOME: home,
    CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.HOME, '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.HOME, '.rustup'),
    NANOCODEX_DIR: store,
    PATH: `${tools}:${process.env.PATH}`,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/gakonst/nanocodex.git',
    FIXTURE_PR_SHA: sha,
    FIXTURE_PR_STATE: 'OPEN',
  };
  const update = (args, changes = {}) => run(binary, ['update', ...args], { env: { ...env, ...changes }, success: false });

  let result = update(['--branch', 'topic']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(store, 'versions', `branch-${sha}`, 'nanocodex2')));
  assert.match(run(join(store, 'versions', `branch-${sha}`, 'nanocodex'), ['--version']).stdout, new RegExp(sha));

  result = update(['--pr', '42']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(store, 'versions', `pr-42-${sha}`, 'nanocodex2')));
  assert.match(run(join(store, 'versions', `pr-42-${sha}`, 'nanocodex2'), ['--version']).stdout, new RegExp(sha));

  result = update(['--pr', '42'], { FIXTURE_PR_STATE: 'CLOSED' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to build a stale head/);
  result = update(['--pr', '42'], { FIXTURE_PR_SHA: '0'.repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /head changed while fetching/);
  result = update(['--branch', 'missing']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to fetch Nanocodex source/);

  writeFileSync(join(source, 'cli/src/main.rs'), 'this is invalid Rust\n');
  run('git', ['add', '.'], { cwd: source });
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'broken build'], { cwd: source });
  run('git', ['push', remote, 'HEAD:refs/heads/broken'], { cwd: source });
  result = update(['--branch', 'broken']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cargo failed while compiling nanocodex/);
  assert.ok(existsSync(join(store, 'versions', `branch-${sha}`, 'nanocodex2')));
  const active = existsSync(join(store, 'pending-update'))
    ? readFileSync(join(store, 'pending-update'), 'utf8').trim()
    : readlinkSync(join(store, 'current')).split('/').at(-1);
  assert.equal(active, `pr-42-${sha}`);
  transcript.push(`expected: branch and PR binaries built at ${sha}; closed, changed, missing and broken heads rejected; previous bundle preserved\nobserved: ${active}\n`);
  process.stdout.write(`source update journeys passed; transcript: ${join(output, 'transcript.log')}\n`);
} finally {
  writeFileSync(join(output, 'transcript.log'), transcript.join('\n'));
  rmSync(fixture, { recursive: true, force: true });
}
