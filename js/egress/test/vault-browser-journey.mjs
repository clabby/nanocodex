// Run from the workspace with built nanocodex-tools and verified WASM artifacts.
// Uses synthetic credentials in real workerd storage and an isolated local Chrome.
// The fixture provides only the caller/browser transport; Vault and private tools
// are production implementations. No live account or browser credentials are used.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
process.chdir(root);
const out = join(root,'output/vault-browser-journey');
mkdirSync(out,{recursive:true});
const require = createRequire(join(root,'js/egress/package.json'));
const wr = createRequire(require.resolve('wrangler/package.json'));
const {build} = wr('esbuild');
const {Miniflare,convertV4MiniflareOptions} = wr('miniflare');
const WebSocket = require('ws'), WebSocketServer = WebSocket.Server;
const accountRequire=createRequire(join(root,'js/account/package.json'));
const chromePath=process.env.CHROME_PATH||accountRequire('playwright-core').chromium.executablePath();
const temporary = mkdtempSync(join(tmpdir(),'vault-journey-'));
const subject = 'B'.repeat(43), owner = 'fixture-owner';
const password = 'synthetic-vault-password', username = 'synthetic@example.test';
let chrome, merchant, provider, mf; const sockets = new Set(), trace = [], posts = [];
const record = (step, details={}) => { trace.push({step,...details}); console.log(step,JSON.stringify(details)); };
try {
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temporary,'key'),'-out',join(temporary,'cert'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
merchant=https.createServer({key:readFileSync(join(temporary,'key')),cert:readFileSync(join(temporary,'cert'))},async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 if(req.method==='POST')posts.push({path:req.url,body});
 if(req.url==='/redirect'){res.writeHead(302,{location:`https://localhost:${merchant.address().port}/login`});res.end();return;}
 res.setHeader('content-type','text/html');
 res.end(req.url==='/done'?'<h1>Signed in successfully</h1>':'<form method="post" action="/done"><input name="username" id="username"><input name="password" id="password" type="password"><button>Sign in</button></form>');
});
await new Promise(r=>merchant.listen(0,'127.0.0.1',r));
const origin=`https://127.0.0.1:${merchant.address().port}`;
chrome=spawn(chromePath,['--headless','--no-sandbox','--disable-dev-shm-usage','--ignore-certificate-errors','--remote-debugging-port=0',`--user-data-dir=${join(temporary,'profile')}`,'about:blank'],{stdio:'ignore'});
let devtools;
for(let i=0;i<100;i++){try{devtools=readFileSync(join(temporary,'profile','DevToolsActivePort'),'utf8').trim().split('\n');break;}catch{await new Promise(r=>setTimeout(r,100));}}
assert.ok(devtools,'Chrome started');
const chromeWs=`ws://127.0.0.1:${devtools[0]}${devtools[1]}`;
const wss=new WebSocketServer({noServer:true});
provider=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({sessionId:'fixture-chrome'}));});
provider.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,down=>{
 const up=new WebSocket(chromeWs);sockets.add(down);sockets.add(up);const queued=[];
 down.on('message',data=>up.readyState===WebSocket.OPEN?up.send(data.toString()):queued.push(data.toString()));
 up.on('open',()=>{for(const data of queued)up.send(data);});
 up.on('message',data=>{if(down.readyState===WebSocket.OPEN)down.send(data.toString());});
 for(const [a,b] of [[up,down],[down,up]]){a.on('close',()=>{sockets.delete(a);b.close();});a.on('error',()=>b.close());}
}));
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const source=`
import {DurableObject} from 'cloudflare:workers';
export {CodemodeRuntime} from '${root}/js/managed/node_modules/agents/dist/browser/index.js';
export * from '${root}/js/egress/src/egress.ts';
import {handleEgress} from '${root}/js/egress/src/egress.ts';
import {handleManagedEgress} from '${root}/js/managed/src/managed-egress.ts';
import {createManagedBrowserRuntime} from '${root}/js/managed/src/browser-runtime.ts';
export class Journey extends DurableObject {
 async fetch(req){
  const {name,input}=await req.json();
  if(name==='fixture_resolution_count')return Response.json({count:this.resolutions??0});
  this.runtime ??= await createManagedBrowserRuntime({ctx:this.ctx,env:{BROWSER:this.env.BROWSER,LOADER:{},MANAGED_BROWSER_PROVIDER:'cloudflare'},sessionId:'fixture',privateOnly:true,
   authorizeVaultAccess:()=>{},
   resolveVaultLogin:async(request)=>{this.resolutions=(this.resolutions??0)+1;const response=await this.env.EGRESS.fetch('https://browser-vault.internal/v1/login',{method:'POST',headers:{'content-type':'application/json','x-nanocodex-subject':'${subject}'},body:JSON.stringify({vault_id:request.vault_id,expected_origin:request.expected_origin})});if(!response.ok)throw Error('Vault denied');return response.json();}});
  try{const tool=this.runtime.tools.find(t=>t.name===name);if(!tool)throw Error('Tool missing');const result=await tool.handler(input,{sessionId:'fixture',callId:crypto.randomUUID(),parentCallId:'',model:'synthetic',signal:AbortSignal.timeout(20000)});return Response.json(result);}
  catch(e){return Response.json({error:e.message},{status:409});}
 }
}
export default {async fetch(req,env,ctx){const url=new URL(req.url);
 if(url.pathname==='/tool')return env.JOURNEY.getByName('fixture').fetch(req);
 if(url.pathname==='/control'||url.pathname==='/model'){const target=url.searchParams.get('url');const forwarded=new Request(target,req);return url.pathname==='/model'?handleManagedEgress(forwarded,env.EGRESS,'${subject}'):handleEgress(forwarded,env,ctx);}
 return handleEgress(req,env,ctx);
}};`;
const bundle=await build({stdin:{contents:source,resolveDir:root},bundle:true,write:false,format:'esm',platform:'node',target:'es2022',external:['cloudflare:*'],logLevel:'warning',alias:{'node-rsa':join(root,'js/nanocodex/tools/browser/unsupportedNodeRsa.mjs'),'@whiskeysockets/baileys':join(root,'js/egress/src/whatsapp-generated/baileys.js')},plugins:[{name:'wasm',setup(b){b.onResolve({filter:/^nanocodex\/wasm$/},()=>({path:'./nanocodex.wasm',external:true}));b.onResolve({filter:/bridge\.wasm$/},()=>({path:'./bridge.wasm',external:true}));}}]});
writeFileSync(join(out,'worker.js'),bundle.outputFiles[0].text);
const wasm=[['nanocodex.wasm','js/nanocodex/pkg-web/nanocodex_bg.wasm'],['bridge.wasm','js/egress/src/whatsapp-generated/bridge.wasm']].map(([name,path])=>({type:'CompiledWasm',path:join(out,name),contents:readFileSync(join(root,path))}));
const runtime={compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat']};
mf=new Miniflare(convertV4MiniflareOptions({workers:[{...runtime,name:'journey',modules:[{type:'ESModule',path:join(out,'worker.js'),contents:bundle.outputFiles[0].text},...wasm],durableObjects:{JOURNEY:'Journey',USER_CREDENTIALS:'UserCredentialBroker',AGENT_SUBJECTS:'AgentSubjectDirectory'},bindings:{ENVIRONMENT:'test',CREDENTIAL_ENCRYPTION_KEY:'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY'},serviceBindings:{EGRESS:'journey',BROWSER:'browser'}},{...runtime,name:'browser',modules:true,script:`export default {fetch(request){const url=new URL(request.url);url.protocol='http:';url.host='127.0.0.1:${provider.address().port}';return fetch(new Request(url,request));}};`}]}));
const base=await mf.ready;
async function control(target,method='POST',body,who=subject,route='control'){
 return fetch(new URL(`/${route}?url=${encodeURIComponent(target)}`,base),{method,headers:{'content-type':'application/json','x-nanocodex-subject':who},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function json(response,status){assert.equal(response.status,status,await response.clone().text());return response.status===204?null:response.json();}
await json(await control(`https://broker.internal/subjects/${subject}`,'PUT',{user_id:owner}),200);
const login=await json(await control(`https://broker.internal/users/${owner}/credentials/vault/login`,'POST',{name:'Fixture login',username,password}),201);
assert.equal(login.browser_origin,undefined);
record('Created login without origin',{status:201,metadataHasPassword:JSON.stringify(login).includes(password)});
async function tool(name,input,expected=200){const response=await fetch(new URL('/tool',base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,input})});const result=await json(response,expected);assert.ok(!JSON.stringify(result).includes(password));record(name,{status:response.status,result});return result;}
let opened=await tool('browser_vault_open',{vault_id:login.id,url:origin+'/login'});
assert.equal(opened.status,'opened');
let identity={vault_id:login.id,target_id:opened.target_id,expected_origin:origin};
for(let i=0;i<20;i++){const status=await tool('browser_vault_status',identity);if(status.status==='login_form')break;await new Promise(r=>setTimeout(r,100));}
await tool('browser_vault_fill',{...identity,operation_id:crypto.randomUUID(),username_selector:'#username',password_selector:'#password',submit:true});
for(let i=0;i<20&&!posts.length;i++)await new Promise(r=>setTimeout(r,100));
assert.deepEqual(posts,[{path:'/done',body:new URLSearchParams({username,password}).toString()}]);
const snapshot=await tool('browser_vault_snapshot',identity);assert.ok(snapshot.text.includes('Signed in successfully'));
record('Synthetic merchant confirmed submitted credentials',{posts:posts.length});
for(const changed of [{vault_id:'X'.repeat(22)},{target_id:'wrong-target'},{expected_origin:'https://other.example.test'}])await tool('browser_vault_snapshot',{...identity,...changed},409);
const external = await tool('browser_vault_action',{...identity,operation_id:crypto.randomUUID(),action:'navigate',url:'https://other.example.test'});
assert.equal(external.status,'outcome_unknown');
assert.ok((await tool('browser_vault_snapshot',identity)).text.includes('Signed in successfully'));
record('Mismatched vault, target, origin and cross-origin navigation denied');
for(const target of ['https://browser-vault.internal/v1/login',`https://broker.internal/users/${owner}/credentials/vault/login/${login.id}/origin`]){
 const response=await control(target,'POST',{vault_id:login.id,expected_origin:origin},subject,'model');assert.equal(response.status,403);assert.ok(!(await response.text()).includes(password));
}
record('Real HTTP model gateway denies private Vault and broker routes',{status:403});
await tool('browser_vault_close',{});
const hint=await json(await control(`https://broker.internal/users/${owner}/credentials/vault/login/${login.id}/origin`,'PUT',{browser_origin:'https://old.example.test'}),200);assert.equal(hint.browser_origin,'https://old.example.test');
opened=await tool('browser_vault_open',{vault_id:login.id,url:origin+'/login'});assert.equal(opened.status,'opened');identity={...identity,target_id:opened.target_id};
record('Saved old origin remains hint; explicit different destination opens');
await tool('browser_vault_action',{...identity,operation_id:crypto.randomUUID(),action:'navigate',url:origin+'/redirect'});
await new Promise(r=>setTimeout(r,300));
const beforeRedirectFill=await tool('fixture_resolution_count',{});
const blockedFill=await tool('browser_vault_fill',{...identity,operation_id:crypto.randomUUID(),username_selector:'#username',password_selector:'#password',submit:true});
assert.equal(blockedFill.status,'outcome_unknown');
assert.deepEqual(await tool('fixture_resolution_count',{}),beforeRedirectFill);
assert.equal(posts.length,1);record('Redirected target rejected before credential release',{merchantPosts:posts.length,extraCredentialResolutions:0});
await tool('browser_vault_close',{});
await json(await control(`https://broker.internal/subjects/${'C'.repeat(43)}`,'PUT',{user_id:'other-owner'}),200);
const resolveLogin=(who=subject,expected_origin=origin,vault_id=login.id)=>control('https://browser-vault.internal/v1/login','POST',{vault_id,expected_origin},who);
assert.equal((await resolveLogin('C'.repeat(43))).status,403);
const api=await json(await control(`https://broker.internal/users/${owner}/credentials/vault/api_key`,'POST',{name:'API fixture',api_key:'synthetic-key'}),201);assert.equal((await resolveLogin(subject,origin,api.id)).status,403);
for(const invalid of ['http://example.test','https://example.test/path','https://user:pass@example.test','https://example.test?query','https://example.test#fragment'])assert.equal((await resolveLogin(subject,invalid)).status,400);
record('Real HTTP cross-owner, wrong-kind and invalid origin denied',{ownerStatus:403,kindStatus:403,invalidOriginStatus:400});
record('PASS: workerd encrypted Vault + real Chromium private browser journey');
} finally {
writeFileSync(join(out,'trace.json'),JSON.stringify({command:'node js/egress/test/vault-browser-journey.mjs',trace},null,2)+'\n');
await mf?.dispose();for(const ws of sockets)ws.terminate();
if(provider){provider.closeAllConnections();await new Promise(r=>provider.close(r));}
if(merchant){merchant.closeAllConnections();await new Promise(r=>merchant.close(r));}
if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(r=>chrome.once('exit',r));}
rmSync(temporary,{recursive:true,force:true});
}
