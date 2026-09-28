// node js/managed/scripts/secure-input-chrome-e2e.mjs
// Synthetic credentials only. Cases defined before implementation:
// - actual fill/receipt/redacted snapshot; unsolicited CDP secret echo is fenced;
// - duplicate submission consumes once; navigation invalidates pending input;
// - same-origin navigation during isolated-world creation fails before injection;
// - runtime recreation retains quarantine but cannot restore in-memory redaction;
// - cancellation revokes pending input.
// This exercises the production runtime in workerd with actual Chrome CDP.
// SDK session discovery/lifecycle is injected for a pre-created local Chrome tab;
// storage is real Durable Object storage, but restart is runtime recreation, not eviction.
// It deliberately does not replace the separate account-auth/HTTP-route tests.
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
const packages = new URL('../../../node_modules/.pnpm/', import.meta.url);
const entry = readdirSync(packages).find(name => /^playwright-core@/.test(name));
const { chromium } = await import(new URL(`${entry}/node_modules/playwright-core/index.mjs`, packages));
const temp = mkdtempSync(join(tmpdir(), 'secure-input-e2e-'));
let browser, server, mf;
try {
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temp,'key'),'-out',join(temp,'cert'),'-days','1','-subj','/CN=localhost'], {stdio:'ignore'});
  server = https.createServer({key:readFileSync(join(temp,'key')),cert:readFileSync(join(temp,'cert'))}, (_req,res) => {
    res.setHeader('Content-Type','text/html');
    res.end(`<form method="post"><input id="pass" type="password"><button>Log in</button></form><div id="echo"></div><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();const p=document.querySelector('#pass').value;document.querySelector('#echo').textContent='Welcome '+p;console.log('private-event-'+p);location.hash=p;window.submissions=(window.submissions||0)+1;};</script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`https://127.0.0.1:${server.address().port}`;
  const portProbe=net.createServer(); await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));
  const port=portProbe.address().port; await new Promise(resolve=>portProbe.close(resolve));
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:[`--remote-debugging-port=${port}`]});
  const context=await browser.newContext({ignoreHTTPSErrors:true}); const page=await context.newPage(); await page.goto(origin);
  const session=await context.newCDPSession(page); const {targetInfo}=await session.send('Target.getTargetInfo');
  const version=await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const endpoint=version.webSocketDebuggerUrl.replace('ws:','http:');
  const source=`
import {createManagedBrowserRuntime} from './src/browser-runtime';
import {PrivateBrowserCdp} from './src/browser-vault';
import {tool,jsonSchema} from 'ai';
let stored; let runtime, normal, normalEvents=[], injectedRace=false, raceBinding;
const makeContext=()=>({callId:'fixture',sessionId:'fixture',parentCallId:'fixture',model:'fixture',signal:new AbortController().signal}); let context;
const binding={fetch:()=>fetch(${JSON.stringify(endpoint)},{headers:{Upgrade:'websocket'}})};
const originalSend=PrivateBrowserCdp.prototype.send;
PrivateBrowserCdp.prototype.send=async function(method,params={},sid){
 if(injectedRace && method==='Page.createIsolatedWorld') {injectedRace=false;await raceBinding.fetch('http://fixture/race');}
 return originalSend.call(this,method,params,sid);
};
async function create(){return createManagedBrowserRuntime({ctx:{storage:stored},env:{BROWSER:binding,LOADER:{}},sessionId:'e2e',authorizeVaultAccess(){},createRuntime:({browser})=>({connector:{sessionInfo:async()=>({sessionId:'chrome'}),closeSession:async()=>{}},runtime:{},tools:{browser_execute:tool({inputSchema:jsonSchema({type:'object'}),execute:async()=>{const r=await browser.fetch('http://fixture',{headers:{Upgrade:'websocket'}});normal=r.webSocket;normal.accept();normal.addEventListener('message',e=>normalEvents.push(JSON.parse(e.data)));normal.send(JSON.stringify({id:1,method:'Target.attachToTarget',params:{targetId:${JSON.stringify(targetInfo.targetId)},flatten:true}}));return 'watching';}})}})});}
const handler={async fetch(req,env){try {raceBinding=env.RACE;context=makeContext();runtime??=await create();const p=new URL(req.url).pathname;const v=req.method==='POST'?await req.json():{};let result;
 if(p==='/restart'){runtime=await create();result={restored:true};}
 else if(p==='/race'){injectedRace=true;result={armed:true};}
 else if(p==='/events'){result=normalEvents;}
 else if(p==='/enable'){const attached=normalEvents.find(e=>e.id===1);if(!attached)throw Error('attachment pending');normal.send(JSON.stringify({id:2,method:'Page.enable',sessionId:attached.result.sessionId}));result={enabled:true};}
 else if(p==='/stored'){result=[...(await stored.list()).values()];}
 else if(p==='/submit'){result=await runtime.submitSecureInput(v,context.signal);}
 else {const name=({'/request':'request_secure_input','/snapshot':'secure_input_snapshot','/action':'secure_input_action','/ordinary':'browser_execute'})[p];result=await runtime.tools.find(t=>t.name===name).handler(v,context);}
 return Response.json(result);}catch{return Response.json({error:'rejected'},{status:409});}}};
export class Harness {constructor(ctx,env){this.env=env;stored=ctx.storage;} fetch(req){return handler.fetch(req,this.env);}}
export default {fetch(req,env){return env.TEST.getByName('test').fetch(req);}};`;
  const bundle=await build({stdin:{contents:source,resolveDir:new URL('..',import.meta.url).pathname,loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:*','node:*'],logLevel:'silent'});
  mf=new Miniflare({modules:true,durableObjects:{TEST:'Harness'},script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],serviceBindings:{RACE:async()=>{await page.goto(origin+'/replacement');return new Response('navigated');}}});
  const call=async(path,value={})=>{const response=await mf.dispatchFetch('http://worker'+path,{method:'POST',body:JSON.stringify(value)});return {status:response.status,value:await response.json()};};
  const request=async()=>{const r=await call('/request',{target_id:targetInfo.targetId,expected_origin:origin,password_selector:'#pass',submit:true});assert.equal(r.status,200);return r.value;};
  const eventually=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('event deadline');};
  // Real ordinary CDP connection is open before credentials arrive.
  assert.equal((await call('/ordinary',{code:'await cdp.spec({})'})).status,200);
  await eventually(async()=> (await call('/events')).value.some(e=>e.id===1));
  assert.equal((await call('/enable')).status,200);
  await eventually(async()=> (await call('/events')).value.some(e=>e.id===2));
  assert.equal((await call('/events')).value.find(e=>e.id===2).error,undefined);
  await page.evaluate(()=>{location.hash='public-event';});
  await eventually(async()=> (await call('/events')).value.some(e=>e.method==='Page.navigatedWithinDocument' && e.params.url.includes('public-event')));
  const pending=await request();const secret='SYNTHETIC-ONLY-secret-47';
  const results=await Promise.all([call('/submit',{request_id:pending.request_id,value:secret}),call('/submit',{request_id:pending.request_id,value:secret})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.deepEqual(results.find(r=>r.status===200).value,{type:'secure_input_receipt',request_id:pending.request_id,status:'submitted'});
  assert.equal(await page.locator('#pass').inputValue(),secret);assert.equal(await page.evaluate(()=>window.submissions),1);assert.ok(page.url().includes(secret));
  const snap=await call('/snapshot',{request_id:pending.request_id});assert.equal(snap.status,200);assert.ok(snap.value.text.includes('Welcome'));assert.ok(!JSON.stringify(snap.value).includes(secret));
  assert.ok(!JSON.stringify((await call('/events')).value).includes(secret));
  assert.ok(!JSON.stringify((await call('/stored')).value).includes(secret));
  assert.equal((await call('/ordinary',{code:'await cdp.spec({})'})).status,409);
  await call('/restart');assert.equal((await call('/ordinary',{code:'await cdp.spec({})'})).status,409);assert.equal((await call('/snapshot',{request_id:pending.request_id})).status,409);
  assert.equal((await call('/submit',{request_id:pending.request_id,action:'cancel'})).status,200);
  await page.goto(origin);let next=await request();await page.goto(origin+'/new-document');
  assert.equal((await call('/submit',{request_id:next.request_id,value:secret})).status,409);assert.equal(await page.locator('#pass').inputValue(),'');
  next=await request();await call('/race');assert.equal((await call('/submit',{request_id:next.request_id,value:secret})).status,409);assert.equal(await page.locator('#pass').inputValue(),'');
  next=await request();assert.equal((await call('/submit',{request_id:next.request_id,action:'cancel'})).status,200);assert.equal((await call('/submit',{request_id:next.request_id,value:secret})).status,409);
  await page.goto(origin);
  await page.setContent('<form method="post"><input id="pass" type="password"><div role="button" id="login">Log in</div><input type="submit" disabled></form><script>document.querySelector("#login").onclick=()=>{window.clicked=document.querySelector("#pass").value.length>0;};</script>');
  next=await request();
  assert.deepEqual((await call('/submit',{request_id:next.request_id,value:secret})).value,{type:'secure_input_receipt',request_id:next.request_id,status:'action_required'});
  const actionSnapshot=await call('/snapshot',{request_id:next.request_id});assert.equal(actionSnapshot.status,200);
  assert.equal((await call('/action',{request_id:next.request_id,action:'click',snapshot_id:actionSnapshot.value.snapshot_id,ref:actionSnapshot.value.elements[0].ref})).status,200);
  assert.equal(await page.evaluate(()=>window.clicked),true);
  assert.equal((await call('/submit',{request_id:next.request_id,action:'cancel'})).status,200);
  console.log('PASS: workerd production secure-input runtime -> real Chrome fill -> actual receipt -> redacted continuation; ordinary CDP event quarantine, duplicate consumption, restart quarantine, navigation and world-creation races, cancellation, action_required receipt/private click. Account HTTP authentication routes are covered separately, not by this harness.');
} finally {await mf?.dispose();await browser?.close();if(server)await new Promise(r=>server.close(r));rmSync(temp,{recursive:true,force:true});}
