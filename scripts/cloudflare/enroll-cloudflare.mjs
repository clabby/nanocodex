#!/usr/bin/env node
// Run only from an explicitly authorized protected native job. No deployment.
import { fork } from 'node:child_process';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { enrollCloudflare, validateEnrollment } from './enroll-credential.mjs';

const input = { owner: process.env.ENROLLMENT_OWNER, operation: process.env.ENROLLMENT_OPERATION, token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.ENROLLMENT_ACCOUNT_ID || undefined };
const smoke = process.argv[2] === '--smoke';
const child = process.argv[2] === '--private-child';
const safeCodes = new Set(['invalid_account', 'invalid_owner', 'invalid_operation', 'invalid_token', 'invalid_mode', 'remote_binding_failed', 'remote_binding_ready', 'connected', 'enrollment_failed', 'enrollment_outcome_unknown']);
function report(code) { process.stdout.write(JSON.stringify({ status: code }) + '\n'); }
if (!child) {
  try {
    if (process.argv.length > (smoke ? 3 : 2)) throw { code: 'invalid_mode' };
    if (!smoke) validateEnrollment(input, true);
    // All library/subprocess output is discarded, including startup failures.
    // IPC receives only a locally selected code; never forward an error object.
    const worker = fork(fileURLToPath(import.meta.url), ['--private-child'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ENROLLMENT_SMOKE: smoke ? 'true' : 'false' },
    });
    delete process.env.CLOUDFLARE_API_TOKEN;
    input.token = undefined;
    let receipt;
    worker.on('message', value => { if (safeCodes.has(value)) receipt = value; });
    worker.on('error', () => { /* exit/close determines the fixed failure receipt */ });
    worker.on('close', code => {
      report(receipt ?? 'enrollment_outcome_unknown');
      process.exitCode = code === 0 && ['connected', 'remote_binding_ready'].includes(receipt) ? 0 : 1;
    });
  } catch (error) {
    report(safeCodes.has(error?.code) ? error.code : 'enrollment_failed');
    process.exitCode = 1;
  }
} else {
  let platform, scratch, result = 'remote_binding_failed';
  try {
    const readOnly = process.env.ENROLLMENT_SMOKE === 'true';
    if (!readOnly) validateEnrollment(input, true);
    scratch = await mkdtemp(join(tmpdir(), 'nanocodex-enrollment-'));
    // Wrangler always creates a debug log, even at log level none. Direct it to
    // the null device before importing Wrangler; the directory holds no secrets.
    const log = join(scratch, 'wrangler.log');
    await symlink('/dev/null', log);
    process.env.WRANGLER_LOG_PATH = log;
    process.env.WRANGLER_LOG = 'none';
    process.env.WRANGLER_SEND_METRICS = 'false';
    process.env.WRANGLER_LOG_SANITIZE = 'true';
    const require = createRequire(new URL('../../js/egress/package.json', import.meta.url));
    const { getPlatformProxy } = require('wrangler');
    platform = await getPlatformProxy({
      configPath: fileURLToPath(new URL('./enroll-cloudflare.wrangler.jsonc', import.meta.url)),
      envFiles: [], persist: false, remoteBindings: true,
    });
    delete process.env.CLOUDFLARE_API_TOKEN;
    if (readOnly) {
      const response = await platform.env.EGRESS.fetch('https://broker.internal/users/enrollment-read-only-smoke/connectors');
      const body = await response.json();
      if (!response.ok || typeof body?.connectors?.cloudflare?.connected !== 'boolean') throw new Error();
      result = 'remote_binding_ready';
    } else {
      result = 'enrollment_outcome_unknown';
      await enrollCloudflare(platform.env.EGRESS, input);
      result = 'connected';
    }
  } catch (error) {
    // Only fixed errors from our journey cross IPC; remote messages never do.
    if (error?.code && /_outcome_unknown$/.test(error.code)) result = 'enrollment_outcome_unknown';
    else if (result === 'enrollment_outcome_unknown') result = 'enrollment_failed';
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN;
    input.token = undefined;
    try { await platform?.dispose(); } catch { /* receipt still reflects operation */ }
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  process.send?.(result);
  process.exitCode = ['connected', 'remote_binding_ready'].includes(result) ? 0 : 1;
  process.disconnect?.();
}
