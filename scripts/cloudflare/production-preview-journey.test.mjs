import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../js/managed/package.json', import.meta.url));
const { build } = require('esbuild');
const { Miniflare } = require('miniflare');
const WebSocket = require('ws');

const entry = `
import { productionPreviewFetch } from './production-preview-entry.ts';
export default { fetch(request, env, ctx) {
  const bindings = env.FAIL ? {...env, NANOCODEX_PREVIEW_PRODUCTION: {fetch() {throw new Error('private provider failure')}}} : env;
  return productionPreviewFetch(request, bindings, ctx, r => new Response('branch:' + new URL(r.url).pathname, {headers:{'content-type':'text/html'}}));
}};`;
const production = `export default { async fetch(request) {
  const url = new URL(request.url);
  if (!['GET','HEAD'].includes(request.method) && request.headers.get('origin') !== url.origin)
    return new Response('forbidden_origin', {status:403});
  if (url.pathname === '/v1/me' && !request.headers.get('cookie')) return new Response('unauthorized',{status:401});
  if (request.headers.get('upgrade') === 'websocket') {
    const pair = new WebSocketPair(); pair[1].accept();
    pair[1].addEventListener('message', event => pair[1].send('production:' + event.data));
    return new Response(null, {status:101, webSocket:pair[0]});
  }
  if (url.pathname.endsWith('/events')) return new Response(new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode('data: first\\n\\n'));
    setTimeout(() => {controller.enqueue(new TextEncoder().encode('data: last\\n\\n')); controller.close()}, 100);
  }}), {headers:{'content-type':'text/event-stream'}});
  return Response.json({url:request.url,method:request.method,cookie:request.headers.get('cookie'),
    authorization:request.headers.get('authorization'),origin:request.headers.get('origin'),
    body:['GET','HEAD'].includes(request.method) ? null : await request.text()},
    {headers:{'set-cookie':'nanocodex_account=synthetic; Path=/; HttpOnly; SameSite=Lax'}});
}};`;

test('branch documents with production service auth, credentials, streams and upgrades', {timeout:60_000}, async () => {
  const bundled = await build({stdin:{contents:entry,resolveDir:fileURLToPath(new URL('.',import.meta.url))},
    bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  const common = {modules:true,compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat']};
  const makeOptions = mode => ({workers:[
    {...common,name:'preview',script:bundled.outputFiles[0].text,
      serviceBindings:mode === 'missing' ? {} : {NANOCODEX_PREVIEW_PRODUCTION:'production'},bindings:{FAIL:mode === 'failed'}},
    {...common,name:'production',script:production},
  ]});
  const mf = new Miniflare(makeOptions('working'));
  const trace = [];
  try {
    const origin = (await mf.ready).origin;
    for (const path of ['/', '/agent', '/connect', '/connect/device', '/connect/vault', '/docs', '/assets/app.js', '/apiary']) {
      const response = await fetch(origin + path);
      assert.equal(response.status,200); assert.equal(await response.text(),'branch:' + path);
      trace.push({path,route:'branch',status:200});
    }
    for (const path of ['/api/health','/v1/credentials','/git/example','/auth','/webauthn/login','/connectors/google/callback',
      '/sandbox-preview/session/index.html','/connect-dialog','/.well-known/urpc/consumer.json']) {
      const response = await fetch(origin + path + '?synthetic=1', {headers:{cookie:'nanocodex_account=synthetic'}});
      assert.equal(response.status,200); assert.equal((await response.json()).url,origin + path + '?synthetic=1');
      trace.push({path,route:'production',status:200});
    }
    const payload = 'synthetic body + unicode λ';
    const response = await fetch(origin + '/v1/auth/sms/verify?synthetic=1', {method:'POST',
      headers:{origin,cookie:'nanocodex_account=synthetic',authorization:'Bearer synthetic'},body:payload});
    assert.equal(response.status,200); assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    assert.deepEqual(await response.json(), {url:origin + '/v1/auth/sms/verify?synthetic=1',method:'POST',
      origin,cookie:'nanocodex_account=synthetic',authorization:'Bearer synthetic',body:payload});
    assert.equal((await fetch(origin + '/v1/me')).status,401);
    assert.equal((await fetch(origin + '/v1/credentials/openai',{method:'PUT',headers:{origin:'https://wrong.invalid'},body:payload})).status,403);
    const mutation = await fetch(origin + '/future-route',{method:'POST',headers:{origin},body:payload});
    assert.equal((await mutation.json()).body,payload);
    const head = await fetch(origin + '/api/health',{method:'HEAD'});
    assert.equal(head.status,200); assert.equal(await head.text(),'');
    trace.push({scenario:'request and cookie preservation, production auth and origin rejection, unknown mutation, HEAD',passed:true});
    const stream = await fetch(origin + '/v1/agents/synthetic/events');
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value),'data: first\n\n');
    assert.equal(new TextDecoder().decode((await reader.read()).value),'data: last\n\n');
    assert.equal((await reader.read()).done,true);
    const socket = new WebSocket(origin.replace('http:','ws:') + '/v1/agents/live');
    await new Promise((resolve,reject) => {socket.onopen=resolve;socket.onerror=reject});
    const echoed = new Promise((resolve,reject) => {socket.onmessage=event=>resolve(event.data);socket.onerror=reject});
    socket.send('synthetic'); assert.equal(await echoed,'production:synthetic');
    await new Promise(resolve => {socket.onclose=resolve;socket.close()});
    trace.push({scenario:'incremental SSE and WebSocket production response',passed:true});
    for (const mode of ['missing','failed']) {
      await mf.setOptions(makeOptions(mode));
      const current = (await mf.ready).origin;
      const failure = await fetch(current + '/v1/credentials');
      assert.equal(failure.status,503); assert.equal(failure.headers.get('cache-control'),'no-store');
      assert.deepEqual(await failure.json(),{error:'preview_backend_unavailable'});
      assert.equal(await (await fetch(current + '/agent')).text(),'branch:/agent');
      trace.push({scenario:mode + ' backend fails closed; branch document still serves',passed:true});
    }
    console.log(JSON.stringify({command:'node --test scripts/cloudflare/production-preview-journey.test.mjs',trace}));
  } finally {await mf.dispose()}
});
