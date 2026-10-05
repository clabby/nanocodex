import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// Actual account HTTP proxy/authentication, Managed Session, SQLite, R2,
// Just Bash, SDK and WASM. Only the external account catalog/model/HTTP target
// are synthetic. The catalog waits for the configured shell HTTP request:
// serialized startup fails the ordering assertion rather than passing by luck.
const candidateRoot = fileURLToPath(new URL("..", import.meta.url));
const root = process.env.NANOCODEX_STARTUP_SOURCE_ROOT ?? candidateRoot;
const output = join(candidateRoot, "../../output/startup-overlap-journey", `${Date.now()}-${process.pid}`);
const source = `
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import worker, { DurableAgentSession, AccountHostedTools } from './src/index.ts';
import { UserAccount, Organization, ApiKeyRecord, NonceStorage, ensureAccount, createApiKey } from './src/account-auth.ts';
import { routeManaged } from '../account/worker/managedProxy.ts';
export { DurableAgentSession, AccountHostedTools, UserAccount, Organization, ApiKeyRecord, NonceStorage };
const info=console.info.bind(console);
console.info=(record,...rest)=>info(record && typeof record==='object'?JSON.stringify(record):record,...rest);
export class FixtureEgress extends WorkerEntrypoint {
  fetch(request) { return this.env.MODEL.getByName('startup').fetch(request); }
  async readAccountDiscovery(owner,component) {
    const response=await this.env.MODEL.getByName('startup').fetch('https://fixture.internal/'+component);
    return {status:response.status,schema:1,expiresAt:Date.now()+900000,data:await response.json()};
  }
}
export class FixtureModel extends DurableObject {
  events=[]; setupStarted=false; catalogReleased=false; setupFinished=false; release;
  record(event,extra={}) { const row={type:'fixture.startup',event,at:Date.now(),...extra};this.events.push(row);console.info(row); }
  async fetch(request) {
    const url=new URL(request.url);
    if(url.pathname==='/trace') return Response.json(this.events);
    if(url.pathname==='/catalog') {
      this.record('catalog.start');
      if(!this.setupStarted) await new Promise(resolve=>{this.release=resolve;setTimeout(resolve,3000);});
      this.record('catalog.setup_observed',{observed:this.setupStarted});
      await new Promise(resolve=>setTimeout(resolve,150));
      this.catalogReleased=true; this.record('catalog.finish');
      return Response.json({connectors:{},mcp_connections:[]});
    }
    if(url.pathname==='/vault') { this.record('vault.read');return Response.json([]); }
    if(request.headers.get('x-nanocodex-target-url')==='https://startup-fixture.example/setup') {
      this.setupStarted=true;this.record('setup.start');this.release?.();
      await new Promise(resolve=>setTimeout(resolve,100));
      this.setupFinished=true;this.record('setup.finish');return new Response('SETUP_OK');
    }
    if(request.headers.get('upgrade')==='websocket') {
      this.record('provider.connect');
      const [client,server]=Object.values(new WebSocketPair());server.accept();
      server.addEventListener('close',()=>server.close(1000));
      let effectiveTools=[],requestIndex=0;
      server.addEventListener('message',event=>{
        const body=JSON.parse(event.data);
        const definitions=[...(body.tools??[]),...(body.input??[]).filter(item=>item.type==='additional_tools').flatMap(item=>item.tools??[])];
        if(definitions.length) effectiveTools=definitions.map(tool=>tool.name??tool.function?.name);
        this.record('provider.request',{catalog_ready:this.catalogReleased,setup_ready:this.setupFinished,
          tools:effectiveTools,input:body.input});
        const id='resp_'+crypto.randomUUID();
        if(++requestIndex===2) {
          server.send(JSON.stringify({type:'response.completed',response:{id,status:'completed',end_turn:false,output:[{type:'function_call',name:'exec_command',call_id:'call_startup_read',arguments:JSON.stringify({cmd:'cat /brain/setup-output.txt',workdir:'/brain'})}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
          return;
        }
        server.send(JSON.stringify({type:'response.created',response:{id,status:'in_progress'}}));
        server.send(JSON.stringify({type:'response.output_text.delta',output_index:0,delta:'STARTUP_OK'}));
        server.send(JSON.stringify({type:'response.completed',response:{id,status:'completed',end_turn:true,
          output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'STARTUP_OK'}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
      });
      return new Response(null,{status:101,webSocket:client});
    }
    return Response.json({tools:[],machines:[],connections:[],status:'not_configured'});
  }
}
export default {async fetch(request,env,ctx) {
  const url=new URL(request.url);
  if(env.EDGE) return await routeManaged(request,env,url)??new Response(null,{status:404});
  if(url.pathname==='/__fixture') {
    const {user}=await request.json();await ensureAccount(env,user,true);
    const auth=await (await env.NANOCODEX_USERS.getByName(user).fetch('https://user.internal/authorization')).json();
    return Response.json(await createApiKey(env,{kind:'api_key',userId:user,...auth.grant,
      subjectId:'api_key:'+user,credentialId:'fixture',capabilities:auth.grant.capabilities},'synthetic startup'));
  }
  if(url.pathname==='/__trace') return env.MODEL.getByName('startup').fetch('https://fixture.internal/trace');
  return worker.fetch(request,env,ctx);
}};
`;

test("normal public API overlaps account discovery with configured setup and retains warm tools", { timeout: 90_000 }, async () => {
  await mkdir(output, { recursive: true });
  const runtime = [], records = [], http = [];
  const capture = line => { runtime.push(line); const offset=line.indexOf('{"type":');if(offset>=0)try{records.push(JSON.parse(line.slice(offset)));}catch{} };
  const assets=[];
  const bundle=await build({stdin:{contents:source,resolveDir:root},bundle:true,write:false,metafile:true,format:"esm",platform:"node",conditions:["workerd"],target:"es2022",
    banner:{js:'import { createRequire } from "node:module"; const require=createRequire("/worker.mjs");'},external:["cloudflare:*","node:*"],
    alias:{"node-rsa":join(root,"../nanocodex/tools/browser/unsupportedNodeRsa.mjs")},plugins:[{name:"wasm",setup(builder){builder.onResolve({filter:/\.wasm$/},async args=>{
      const name=`fixture-${assets.length}.wasm`;assets.push({type:"CompiledWasm",path:name,contents:await readFile(join(args.resolveDir,args.path))});return {path:`./${name}`,external:true};
    });}}],logLevel:"silent"});
  const modules=[{type:"ESModule",path:"worker.mjs",contents:bundle.outputFiles[0].text},...assets];
  const common={modules,compatibilityDate:"2026-07-30",compatibilityFlags:["nodejs_compat","enable_request_signal"]};
  const mf=new Miniflare({port:0,handleRuntimeStdio(stdout,stderr){createInterface({input:stdout}).on("line",capture);createInterface({input:stderr}).on("line",capture);},
    durableObjectsPersist:join(output,"sqlite"),r2Persist:join(output,"r2"),workers:[
      {...common,name:"edge",bindings:{EDGE:true},serviceBindings:{NANOCODEX_BACKEND:"managed"}},
      {...common,name:"managed",bindings:{NANOCODEX_PERFORMANCE_TRACE:"true",AGENT_IDLE_TIMEOUT_MS:"60000"},
        durableObjects:{NANOCODEX_SESSIONS:{className:"DurableAgentSession",useSQLite:true},NANOCODEX_USERS:{className:"UserAccount",useSQLite:true},NANOCODEX_ORGANIZATIONS:{className:"Organization",useSQLite:true},
          NANOCODEX_API_KEYS:{className:"ApiKeyRecord",useSQLite:true},NANOCODEX_AUTH:{className:"NonceStorage",useSQLite:true},NANOCODEX_ACCOUNT_TOOLS:{className:"AccountHostedTools",useSQLite:true},
          MODEL:{className:"FixtureModel",useSQLite:true},NANOCODEX_MEMORY:{className:"FixtureModel",useSQLite:true}},
        serviceBindings:{NANOCODEX:{name:"managed",entrypoint:"FixtureEgress"}},r2Buckets:["NANOCODEX_HISTORY","NANOCODEX_WORKSPACES"]},
    ]});
  let failure, evidence={};
  try {
    const base=await mf.ready,backend=await mf.getWorker("managed");
    const fixture=async()=>{const response=await backend.fetch("https://fixture.internal/__fixture",{method:"POST",body:JSON.stringify({user:crypto.randomUUID()})});assert.equal(response.status,200);return response.json();};
    const {token}=await fixture(),other=(await fixture()).token;
    const call=async(path,method="GET",body,expected=200,credential=token,extra={})=>{
      const started=performance.now(),response=await fetch(new URL(path,base),{method,headers:{authorization:"Bearer "+credential,"content-type":"application/json",...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
      const value=await response.json();http.push({path,method,status:response.status,elapsed_ms:performance.now()-started,value});assert.equal(response.status,expected,JSON.stringify(value));return value;
    };
    const settings={model:"gpt-6.1-sol",thinking:"low",reasoning_mode:"standard",fast_mode:false};
    const configuration={environment:{files:[{path:"/brain/setup-input.txt",content:"durable fixture"}],skills:[],setup_commands:["curl -fsS https://startup-fixture.example/setup > /brain/setup-output.txt"],network:{access:"enabled"}}};
    const started=performance.now();
    const run=await call("/v1/agent-runs","POST",{input:"Reply STARTUP_OK",settings,configuration},201,token,{"idempotency-key":"startup-overlap"});
    const waitTurn=async id=>{
      for(let i=0;i<1000;i++){const value=await call(`/v1/agents/${run.agent_id}/turns/${id}`);assert.ok(!["failed","cancelled"].includes(value.state),JSON.stringify(value));if(value.state==="completed")return value;await delay(10);}
      throw Error("turn did not finish");
    };
    const cold=await waitTurn(run.turn_id),coldMs=performance.now()-started;assert.match(JSON.stringify(cold),/STARTUP_OK/);
    const environment=await call(`/v1/agents/${run.agent_id}/environment`);assert.equal(environment.state,"ready");
    await call(`/v1/agents/${run.agent_id}/turns/${run.turn_id}`,"GET",undefined,404,other);
    const warmStarted=performance.now(),warm=await call(`/v1/agents/${run.agent_id}/turns`,"POST",{id:crypto.randomUUID(),input:"Read the prepared file and reply STARTUP_OK"},202);
    assert.match(JSON.stringify(await waitTurn(warm.turn_id)),/STARTUP_OK/);
    const warmMs=performance.now()-warmStarted,trace=await(await backend.fetch("https://fixture.internal/__trace")).json();
    evidence={source_root:root,cold_public_completion_ms:coldMs,warm_public_completion_ms:warmMs,trace};
    const first=event=>trace.find(row=>row.event===event);
    assert.equal(first("catalog.setup_observed")?.observed,true,"configured setup must run while catalog is pending");
    assert.ok(first("setup.start").at<first("catalog.finish").at);
    const requests=trace.filter(row=>row.event==="provider.request");assert.equal(requests.length,3);
    for(const request of requests){assert.equal(request.catalog_ready,true);assert.equal(request.setup_ready,true);assert.ok(request.tools.includes("exec"),JSON.stringify(request.tools));}
    assert.match(JSON.stringify(requests[0].input),/startup_context/);
    assert.match(JSON.stringify(requests[2].input),/SETUP_OK/,"real shell reads the R2 file created by setup");
    assert.equal(trace.filter(row=>row.event==="catalog.start").length,1,"warm turn reuses bounded discovery");
    assert.equal(trace.filter(row=>row.event==="setup.start").length,1,"warm turn never repeats setup side effects");
    evidence={source_root:root,cold_public_completion_ms:coldMs,warm_public_completion_ms:warmMs,setup_catalog_overlap_ms:first("catalog.finish").at-first("setup.start").at,
      setup_once:true,catalog_reads:1,provider_requests:3,prepared_file_read:true,tools_preserved:true,cross_owner_denied:true,trace};
    console.log("STARTUP_OVERLAP_EVIDENCE",JSON.stringify({...evidence,trace:undefined,output}));
  } catch(error) {failure=error;throw error;}
  finally {
    await mf.dispose();
    await Promise.all([writeFile(join(output,"evidence.json"),JSON.stringify({command:"node --test test/startup-overlap-journey.test.mjs",status:failure?"FAIL":"PASS",error:failure?.stack,...evidence,http,records},null,2)),
      writeFile(join(output,"runtime.log"),runtime.join("\n")),writeFile(join(output,"fixture-source.mjs"),source),writeFile(join(output,"source-resolution.json"),JSON.stringify(bundle.metafile.inputs,null,2))]);
  }
});
