import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';

// Exercise the shipped frontdoor forwarding function, regional selection and
// exact production DO classes over TCP WebSockets. Enrollment/authentication
// and the full account/managed entrypoints are outside this transport fixture.
const owner = '00000000-0000-4000-8000-000000000081';
const source = `
export { AccountHostedTools } from './src/account-hosted-tools';
export { RegionalHandRelay } from './src/regional-hand-relay';
import { routeRegionalToolHost } from './src/regional-hand-routing';
import { routeManaged } from '../account/worker/managedProxy';
export default {fetch(request, env) {
  if (env.NANOCODEX_BACKEND) return routeManaged(request, env, new URL(request.url));
  return routeRegionalToolHost(new Request(request, {
    cf: {continent:'EU', country:'DE', longitude:'8.68'}
  }), '${owner}', env);
}};`;

async function probe(base, mf, trace, regional, hibernate) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(new URL('/v1/account/tool-host', base).href.replace(/^http/, 'ws'), {
      perMessageDeflate: false,
      headers: regional ? {
        'x-nanocodex-hand-machine-id': 'synthetic-hand',
        'x-nanocodex-hand-runtime-id': randomUUID(),
      } : {},
    });
    let pong = false;
    const record = event => trace.push({ regional, hibernate, ...event });
    const fail = error => { clearTimeout(timeout); ws.terminate(); reject(error); };
    const timeout = setTimeout(() => fail(new Error(`transport timeout: regional=${regional}, hibernate=${hibernate}`)), 5000);
    ws.on('upgrade', response => record({ event: 'upgrade', status: response.statusCode }));
    ws.on('open', () => { record({ event: 'open' }); ws.ping('probe'); });
    ws.once('pong', async data => {
      try {
        assert.equal(data.toString(), 'probe');
        pong = true;
        record({ event: 'pong' });
        if (hibernate) {
          await mf.unsafeEvictDurableObject('managed', regional ? 'RegionalHandRelay' : 'AccountHostedTools', {
            name: regional ? `${owner}:hand-relay:v1:weur` : owner,
            webSockets: 'hibernate',
          });
          record({ event: 'hibernated' });
        }
        // The protocol rejection proves application-frame dispatch, including
        // inherited websocket handlers after reconstruction from hibernation.
        ws.send(JSON.stringify({ type: 'diagnostic-invalid-frame' }));
      } catch (error) { fail(error); }
    });
    ws.on('error', fail);
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      record({ event: 'close', code, reason: String(reason) });
      try {
        assert.equal(pong, true);
        assert.equal(code, 1008);
        assert.match(String(reason), /^unknown_message:/);
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

test('production proxy and relay preserve pre-catalog frames across hibernation', { timeout: 60000 }, async () => {
  const output = fileURLToPath(new URL(`../../../output/regional-hand-transport/${Date.now()}-${randomUUID()}/`, import.meta.url));
  await mkdir(output, { recursive: true });
  const trace = [];
  let mf;
  try {
    const bundle = await build({
      stdin: { contents: source, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
      bundle: true, write: false, format: 'esm', platform: 'node', conditions: ['workerd'],
      target: 'es2022', minify: true,
      alias: { 'node-rsa': fileURLToPath(new URL('../../nanocodex/tools/browser/unsupportedNodeRsa.mjs', import.meta.url)) },
      banner: { js: 'import {createRequire} from "node:module";const require=createRequire("/worker.mjs");' },
      external: ['cloudflare:*', 'node:*'],
    });
    await writeFile(output + 'worker.mjs', bundle.outputFiles[0].text);
    const worker = { script: bundle.outputFiles[0].text, modules: true };
    mf = new Miniflare({ workers: [
      {
        ...worker, name: 'edge', serviceBindings: { NANOCODEX_BACKEND: 'managed' },
        compatibilityDate: '2026-05-22', compatibilityFlags: ['nodejs_compat'],
      },
      {
        ...worker, name: 'managed', bindings: { NANOCODEX_REGIONAL_HAND_RELAYS: 'true' },
        compatibilityDate: '2026-07-29',
        compatibilityFlags: ['nodejs_compat', 'durable_object_io_tasks_prevent_eviction', 'global_fetch_strictly_public', 'enable_request_signal'],
        durableObjects: {
          NANOCODEX_ACCOUNT_TOOLS: { className: 'AccountHostedTools', useSQLite: true },
          NANOCODEX_HAND_RELAYS: { className: 'RegionalHandRelay', useSQLite: true },
        },
      },
    ] });
    const base = await mf.ready;
    for (const regional of [false, true]) {
      for (const hibernate of [false, true]) await probe(base, mf, trace, regional, hibernate);
    }
  } finally {
    await writeFile(output + 'trace.json', JSON.stringify(trace, null, 2));
    await mf?.dispose();
    console.log('Transport evidence: ' + output);
  }
});
