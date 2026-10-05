import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Exercise the same curl/HTTP, account authorization, Session SQLite, Rust WASM
// and normal Egress boundary used by the benchmark. Only external identity/model
// dependencies are synthetic. The harness retains request/response transcripts,
// contract assertions and source hashes under ignored output/managed-api-ttft/.
test('one production agent-run POST streams durable output and recovers safely', { timeout: 120_000 }, async () => {
  const label = `stream-contract-${Date.now()}-${process.pid}`;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../benchmark/curl-ttft.mjs', import.meta.url)),
    '--family=claude', '--mode=stream', '--samples=1', '--process-samples=0', `--label=${label}`,
  ], { maxBuffer: 8 * 1024 * 1024 });
  console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  console.log(`Evidence: output/managed-api-ttft/${label}/contract-checks.json`);
});
