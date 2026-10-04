import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve('wrangler/package.json'))('miniflare');
const root=new URL('../',import.meta.url).pathname;
test('shipped egress and broker isolate WhatsApp controls from subject data requests',{timeout:60000},async()=>{
 const bundle=await build({entryPoints:[root+'test/whatsapp/broker.worker.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:*','node:*'],alias:{'node-rsa':root+'../nanocodex/tools/browser/unsupportedNodeRsa.mjs'},plugins:[{name:'upstream-only',setup(b){b.onResolve({filter:/^nanocodex\/wasm$/},()=>({path:'./nanocodex.wasm',external:true}));b.onResolve({filter:/^\.\/whatsapp-runtime$/},()=>({path:root+'test/whatsapp/runtime.fixture.ts'}));}}]});
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'broker-journey',modules:[{type:'ESModule',path:root+'output/broker.js',contents:bundle.outputFiles[0].text},{type:'CompiledWasm',path:root+'output/nanocodex.wasm',contents:await readFile(root+'../nanocodex/pkg-web/nanocodex_bg.wasm')}],compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat'],bindings:{ENVIRONMENT:'test',ALLOW_LOCAL_CREDENTIAL_CLAIM:'true'},durableObjects:Object.fromEntries(Object.entries({USER_CONNECTORS:'UserConnectorBroker',WHATSAPP_ACCOUNTS:'WhatsAppAccount',AGENT_SUBJECTS:'AgentSubjectDirectory',USER_CREDENTIALS:'UserCredentialBroker',MCP_CONNECTIONS:'McpConnectionDirectory',SPOTIFY_RATE_LIMITS:'SpotifyRateLimit',GMAIL_PUSH_MAILBOXES:'GmailPushMailbox'}).map(([k,v])=>[k,{className:v,useSQLite:true}])),outboundService:()=>new Response('unexpected outbound',{status:599})}]}));
 const trace=[]; const failures=[];
 const op='33333333-3333-4333-8333-333333333333';
 const subject='A'.repeat(43), other='B'.repeat(43);
 async function request(url,{method='GET',body,headers={},status=200}={}){
  const response=await mf.dispatchFetch(url,{method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  trace.push({url,method,status:response.status,data}); if(response.status!==status) failures.push({url,expected:status,observed:response.status,data});return data;
 }
 const control=(path,options)=>request('https://broker.test'+path,options);
 const tool=(path,options={})=>request('https://whatsapp.internal'+path,{...options,headers:{authorization:'Bearer NANOCODEX_PROVIDER_CREDENTIAL','x-nanocodex-subject':subject,...options.headers}});
 try{
  await control('/subjects/'+subject,{method:'PUT',body:{user_id:'synthetic-owner'}});
  await control('/subjects/'+other,{method:'PUT',body:{user_id:'synthetic-other'}});
  const start=await control('/users/synthetic-owner/connectors/whatsapp/start',{method:'POST',body:{operation_id:op,phone:'+15550000001'},status:202});
  assert.equal(start.attempt.state,'ready');assert.equal(JSON.stringify(start).includes('TEST-1234'),false);
  const pairing=await control('/users/synthetic-owner/connectors/whatsapp/pairing?operation_id='+op);if(pairing.code!=='TEST-1234') failures.push({pairing:'private code unavailable',data:pairing});
  await control('/users/synthetic-owner/connectors/whatsapp/pairing?operation_id='+op+'&extra=1',{status:403});
  await control('/users/synthetic-owner/connectors/whatsapp/pairing?operation_id=malformed',{status:403});
  await control('/users/synthetic-owner/connectors/whatsapp/pairing?operation_id='+op+'&operation_id='+op,{status:403});

  const brokers=await mf.getDurableObjectNamespace('USER_CONNECTORS');
  const accounts=await mf.getDurableObjectNamespace('WHATSAPP_ACCOUNTS');
  const fixture=accounts.get(accounts.idFromName(brokers.idFromName('synthetic-owner').toString()));
  async function upstream(path,body){const r=await fixture.fetch('https://fixture/fixture/'+path,{method:'POST',body:JSON.stringify(body)});assert.equal(r.status,200);}
  await upstream('register',{});
  const catalog=await control('/users/synthetic-owner/catalog');
  assert.equal(catalog.connectors.whatsapp.connected,true);assert.equal(catalog.connectors.whatsapp.connections[0].id,start.connection_id);
  await upstream('connection',{update:{state:'open'}});
  await upstream('events',{events:[{type:'message',message:{id:'synthetic-message',chat_id:'synthetic-chat',timestamp:1,text:'owner-only synthetic content'}}]});
  const selected={'x-nanocodex-connector-connection':start.connection_id};
  assert.equal((await tool('/status',{headers:selected})).connected,true);
  assert.equal((await tool('/messages?chat_id=synthetic-chat',{headers:selected})).items[0].text,'owner-only synthetic content');
  await upstream('events',{events:[1,2].map(n=>({type:'message',message:{id:`unicode-${n}`,chat_id:'synthetic-chat',timestamp:n+1,text:`Καλημέρα κόσμε ${n}`}}))});
  const query=encodeURIComponent('Καλημέρα');
  const unicodeFirst=await tool(`/search?q=${query}&limit=1`,{headers:selected});
  assert.deepEqual(unicodeFirst.items.map(m=>m.id),['unicode-2']);assert.ok(unicodeFirst.next_cursor);
  const unicodeSecond=await tool(`/search?q=${query}&limit=1&cursor=${unicodeFirst.next_cursor}`,{headers:selected});
  assert.deepEqual(unicodeSecond.items.map(m=>m.id),['unicode-1']);assert.equal(unicodeSecond.next_cursor,null);

  assert.equal((await tool('/messages?chat_id=synthetic-chat',{headers:{'x-nanocodex-subject':other}})).items.length,0);
  await tool('/messages?chat_id=synthetic-chat',{headers:{...selected,'x-nanocodex-subject':other},status:404});
  await tool('/messages?chat_id=synthetic-chat',{headers:{'x-nanocodex-connector-connection':'Z'.repeat(43)},status:404});
  for(const [path,method] of [['/pairing?operation_id='+op,'GET'],['/start','POST'],['/send','POST'],['/logout','POST']]){
   const denied=await tool(path,{method,headers:selected,...(method==='POST'?{body:{operation_id:op,phone:'+15550000001'}}:{}),status:403});
   assert.equal(JSON.stringify(denied).includes('TEST-1234'),false);
  }
  assert.equal((await tool('/status',{headers:selected})).connected,true);
  assert.deepEqual(failures,[],JSON.stringify(failures));
 }finally{await mkdir(root+'output',{recursive:true});await writeFile(root+'output/whatsapp-broker-journey.json',JSON.stringify(trace,null,2));await mf.dispose();}
});
