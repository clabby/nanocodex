import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runProvider, WINDOWS_NATIVE_CONTRACT_BLOCKER } from '../../src/windows_sky_host.mjs';

const source = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8');
test('production provider fails closed regardless of inherited legacy CLI setting', async () => {
  // A supplied path cannot authorize a fallback to the old official CLI host.
  for (const value of [undefined, '/fixture/legacy-codex']) {
    const env = { ...process.env };
    if (value) env.CODEX_CLI_PATH = value; else delete env.CODEX_CLI_PATH;
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../src/windows_sky_host.mjs', import.meta.url)), '/fixture/provider'], { env, encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /native helper policy contract without Codex has not been verified/);
    assert.equal(child.stdout, '');
  }
  await assert.rejects(runProvider('/fixture/provider'), { message: WINDOWS_NATIVE_CONTRACT_BLOCKER });
});
test('Windows installer stops without Store installation, copying files or support advertisement', () => {
  const code = source('provision_windows.ps1').split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n').trim();
  assert.match(code, /^\$ErrorActionPreference = 'Stop'\nthrow '/);
  assert.match(code, /No installation or configuration was changed/);
  assert.doesNotMatch(code, /winget|Get-AppxPackage|Copy-Item|New-Item|Move-Item|Remove-Item|installed|CODEX_CLI_PATH|browser,computer|ConvertTo-Json/);
});
test('host contains no executable discovery, CLI env forwarding or app-server emulation', () => {
  const code = source('windows_sky_host.mjs').split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /CODEX_CLI_PATH|node:child_process|WindowsHelperTransport\(|configRequirements\/read|config\/read|app-server/);
});
test('legacy live probe fails before opening cached receipts or spawning providers', () => {
  const filename = fileURLToPath(new URL('./live-probe.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [filename], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /native helper policy contract without Codex has not been verified/);
  assert.equal(child.stdout, '');
  assert.doesNotMatch(readFileSync(filename, 'utf8'), /node:fs|node:child_process|provider\.json/);
});

test('Windows managed discovery is refused while explicit custom MCP transport remains enabled', () => {
  const lib = source('lib.rs');
  const selection = lib.slice(lib.indexOf('fn discover_for_platform('));
  const explicit = selection.indexOf('if let Some(path) = explicit');
  const windows = selection.indexOf('if platform == "windows"');
  const managed = selection.indexOf('provision::managed_provider_path()');
  assert.ok(explicit >= 0 && explicit < windows && windows < managed);
  const setup = lib.slice(lib.indexOf('pub async fn discover_or_install()'));
  assert.ok(setup.indexOf('std::env::var_os("NANOCODEX_COMPUTER")') < setup.indexOf('cfg!(target_os = "windows")'));
  assert.ok(setup.indexOf('cfg!(target_os = "windows")') < setup.indexOf('provision::provision_upstream(false)'));
  assert.doesNotMatch(lib, /windows_local_provider_blocker|windows_legacy_provider_tests/);
  const provision = source('provision.rs');
  const provider = provision.slice(provision.indexOf('pub fn managed_provider_path()'));
  assert.ok(provider.indexOf('target_os = "macos", target_os = "linux"') < provider.indexOf('runtime_root()'));
});
