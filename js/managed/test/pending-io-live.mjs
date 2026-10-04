import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Live Cloudflare test: explicitly deploys and deletes a synthetic Worker.
// Local workerd does not reproduce hosted idle-eviction behavior.
// Real HTTP -> Durable Object -> service binding / DO RPC / timer. The client
// receives 202 and disconnects; no requests or alarms keep the object active
// during the wait. Run beyond the documented 70–140s idle eviction window.
const delay = 160_000;
const source = `
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
export class Session extends DurableObject {
  boot = crypto.randomUUID();
  async fetch(request) {
    const mode = new URL(request.url).pathname.slice(1);
    if (request.method === 'POST') {
      await this.ctx.storage.put('accepted', { boot: this.boot, mode });
      this.ctx.waitUntil((async () => {
        if (mode === 'service') await this.env.DELAY.fetch('https://delay/');
        else if (mode === 'rpc') await this.env.DELAYS.getByName(mode).finish();
        else await new Promise(resolve => setTimeout(resolve, ${delay}));
        await this.ctx.storage.put('completed', { boot: this.boot, mode });
      })());
      return new Response(null, { status: 202 });
    }
    return Response.json({ accepted: await this.ctx.storage.get('accepted'),
      completed: await this.ctx.storage.get('completed'), boot: this.boot });
  }
}
export class Delay extends DurableObject {
  async finish() { await new Promise(resolve => setTimeout(resolve, ${delay})); }
}
export class DelayService extends WorkerEntrypoint {
  async fetch() { await new Promise(resolve => setTimeout(resolve, ${delay})); return new Response('done'); }
}
export default { fetch(request, env) {
  if (!['/service', '/rpc', '/timer'].includes(new URL(request.url).pathname)) return new Response(null, { status: 404 });
  return env.SESSIONS.getByName(new URL(request.url).pathname).fetch(request);
} };
`;

test('accepted work completes after the HTTP client leaves across pending I/O', { timeout: 300_000 }, async () => {
  const name = 'nanocodex-pending-io-' + crypto.randomUUID().slice(0, 8);
  const output = new URL('../../../output/pending-io/' + name + '/', import.meta.url);
  await mkdir(output, { recursive: true });
  const config = new URL('wrangler.json', output);
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const run = promisify(execFile);
  const trace = [];
  try {
    await writeFile(new URL('worker.mjs', output), source);
    await writeFile(config, JSON.stringify({ name, main: './worker.mjs', compatibility_date: '2026-07-29',
      compatibility_flags: ['durable_object_io_tasks_prevent_eviction'], workers_dev: true,
      durable_objects: { bindings: [{ name: 'SESSIONS', class_name: 'Session' }, { name: 'DELAYS', class_name: 'Delay' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Session', 'Delay'] }],
      services: [{ binding: 'DELAY', service: name, entrypoint: 'DelayService' }] }, null, 2));
    const deployed = await run(process.execPath, [wrangler, 'deploy', '--config', fileURLToPath(config)], { timeout: 60_000 });
    await writeFile(new URL('deploy.log', output), deployed.stdout + deployed.stderr);
    const origin = deployed.stdout.match(/https:\/\/[^\s]+\.workers\.dev/);
    assert.ok(origin, 'deployment returns a workers.dev origin');
    const url = new URL(origin[0]);
    // Newly published workers.dev routes can take a few seconds to propagate.
    // Read-only readiness probes precede admission; submitted work is never retried.
    const readyUntil = Date.now() + 30_000;
    for (;;) {
      const ready = await fetch(new URL('timer', url), { signal: AbortSignal.timeout(10_000) });
      if (ready.ok && (ready.headers.get('content-type') ?? '').includes('application/json')) {
        await ready.json();
        break;
      }
      await ready.arrayBuffer();
      assert.ok(Date.now() < readyUntil, 'published fixture becomes ready');
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    for (const mode of ['service', 'rpc', 'timer']) {
      const response = await fetch(new URL(mode, url), { method: 'POST', headers: { connection: 'close' }, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 202);
      await response.arrayBuffer();
      trace.push({ mode, status: response.status, acceptedAt: Date.now() });
    }
    await new Promise(resolve => setTimeout(resolve, delay + 2_000));
    for (const mode of ['service', 'rpc', 'timer']) {
      const response = await fetch(new URL(mode, url), { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      const receipt = await response.json();
      trace.push({ mode, receipt, observedAt: Date.now() });
      assert.equal(receipt.completed?.mode, mode);
      assert.equal(receipt.completed.boot, receipt.accepted.boot);
    }
  } finally {
    await writeFile(new URL('journey.json', output), JSON.stringify(trace, null, 2));
    const deleted = await run(process.execPath, [wrangler, 'delete', '--config', fileURLToPath(config), '--force'], { timeout: 60_000 });
    await writeFile(new URL('cleanup.log', output), deleted.stdout + deleted.stderr);
  }
});
