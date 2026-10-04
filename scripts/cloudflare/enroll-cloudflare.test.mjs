import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const runner = fileURLToPath(new URL('./enroll-cloudflare.mjs', import.meta.url));
test('native CLI rejects unsafe inputs before remote initialization without echoing values', () => {
  for (const [owner, operation, expected] of [
    ['../foreign-sensitive', 'ed16947a-d950-4d22-b37a-0c100a3ade80', 'invalid_owner'],
    ['12345678-1234-4234-8234-123456789012', 'invalid-sensitive', 'invalid_operation'],
  ]) {
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', env: {
      ...process.env, ENROLLMENT_OWNER: owner, ENROLLMENT_OPERATION: operation,
      CLOUDFLARE_API_TOKEN: 'synthetic-private-token',
    } });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, JSON.stringify({status:expected}) + '\n');
    assert.equal(result.stderr, '');
  }
});
