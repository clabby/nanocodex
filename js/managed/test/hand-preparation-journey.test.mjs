import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import WebSocket from "ws";
import { createTools } from "nanocodex/tools";
import { createAttachment } from "nanocodex-tools/attachment";
import { createNodeProcessTools } from "nanocodex-tools/node";

const root = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const owner = "00000000-0000-4000-8000-000000000051";
const thread = "00000000-0000-7000-8000-000000000052";
const organization = "00000000-0000-7000-8000-000000000053";
const team = "00000000-0000-7000-8000-000000000054";
const machine = "synthetic-preparation-hand";
const command = "pnpm --filter nanocodex-managed-service test:hand-preparation";
const trials = Array.from({ length: 7 }, (_, i) => `MEASURE_${i}`);
const scripts = Object.fromEntries(trials.map(scenario => [scenario, `
  const results = await Promise.all(["a","b"].map(part => tools.exec_command({cmd:"printf '${scenario}:"+part+"\\n' >> effect.log; printf PREP_OK",workdir:"/${machine}",shell:"/bin/sh",login:false,yield_time_ms:1000})));
  for (const workdir of ["/slow-vm", "/fast-vm"]) { try { await tools.exec_command({cmd:"printf MUST_NOT_RUN",workdir}); text("UNSAFE_VM"); } catch(error) { text({excluded:workdir,error:error.message}); } }
  text(results);
`]));
scripts.BRAIN = 'text(await tools.exec_command({cmd:"printf BRAIN_INDEPENDENT",workdir:"/brain"}));';
scripts.FAIL = `try { text(await tools.exec_command({cmd:"printf MUST_NOT_RUN",workdir:"/${machine}"})); } catch(error) { text({expected_failure:error.message}); }`;
const mounts = ["slow", "fast"].map((name, i) => ({ id: `fixture-${name}`, root: `/${name}-vm`, provider: "host", name,
  configuration: { vm_factory_name: "fixture-factory", vm_host: { pool_locator: (i ? "b" : "a").repeat(43),
    allocation_id: `00000000-0000-7000-8000-00000000006${i}`, generation: 1, machine_id: `fixture-${name}-machine` } } }));

// Only account seed/admission, the external model and unavailable external VM
// pool receipts are fixtures. Discovery, preparation, Code Mode, SQLite ledger,
// routing, reverse WebSocket, ToolRouter and native shell are shipped code.
// Explicit artificial delays exercise dependency overlap, NOT deployed latency.
const source = `
import { DurableObject } from 'cloudflare:workers';
import { DurableAgentSession, AccountHostedTools } from './src/index.ts';
const info=console.info.bind(console);
console.info=(record,...rest)=>info(record&&typeof record==='object'?JSON.stringify(record):record,...rest);
export class ObservedAccountHostedTools extends AccountHostedTools {
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/__fixture') { await this.ctx.storage.put('fixture',await request.json()); return new Response(null,{status:204}); }
    if(path==='/snapshot') {
      const config=await this.ctx.storage.get('fixture')??{},started=Date.now();
      console.info({type:'fixture.snapshot',stage:'start',at:started});
      await new Promise(resolve=>setTimeout(resolve,config.delay_ms??0));
      const response=config.fail?new Response('fixture discovery failure',{status:503}):await super.fetch(request);
      console.info({type:'fixture.snapshot',stage:'end',at:Date.now(),status:response.status}); return response;
    }
    return super.fetch(request);
  }
}
export class FixturePool extends DurableObject {
  async fetch(request) {
    const input=await request.json(),slow=input.pool_locator==='${"a".repeat(43)}';
    console.info({type:'fixture.pool',stage:'start',at:Date.now(),pool:slow?'slow':'fast'});
    await new Promise(resolve=>setTimeout(resolve,slow?160:40));
    console.info({type:'fixture.pool',stage:'end',at:Date.now(),pool:slow?'slow':'fast'});
    return Response.json({error:'allocation_unavailable'},{status:503});
  }
}
export class FixtureSession extends DurableAgentSession {
  async fetch(request) {
    if(new URL(request.url).pathname==='/__seed') {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO session_state(singleton,session_id,owner_id,organization_id,team_id,authorization_epoch,public_origin,runtime_profile,last_active) VALUES(1,?,?,?,?,1,'https://fixture.internal/','managed',?)",'${thread}','${owner}','${organization}','${team}',Date.now());
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO managed_configuration VALUES(1,?)",JSON.stringify({environment:{files:[],skills:[],setup_commands:[],network:{access:'enabled'}}}));
      this.ctx.storage.sql.exec("UPDATE managed_agent_settings SET model='gpt-6.1-sol',thinking='low'");
      for(const mount of ${JSON.stringify(mounts)}) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO managed_mounts VALUES(?,?,?,?,?,?,'mounted',?,?)",mount.id,mount.provider,mount.name,mount.root,mount.id,JSON.stringify(mount.configuration),Date.now(),Date.now());
      await this.ctx.storage.sync(); return new Response(null,{status:204});
    }
    return super.fetch(request);
  }
}
export class FixtureModel extends DurableObject {
  async fetch(request) {
    if(request.headers.get('upgrade')!=='websocket') return Response.json({tools:[],machines:[],connections:[]});
    const [client,server]=Object.values(new WebSocketPair()); server.accept(); let scenario='',index=0;
    server.addEventListener('close',()=>server.close(1000));
    server.addEventListener('message',event=>{
      const body=JSON.parse(event.data),latest=JSON.stringify((body.input??[]).filter(item=>item.role==='user').at(-1));
      const next=Object.keys(${JSON.stringify(scripts)}).find(key=>latest?.includes('PREPARATION_'+key));
      if(next&&next!==scenario) {scenario=next;index=0;} const call=++index;
      console.info({type:'fixture.model',scenario,index:call});
      const outputs=(body.input??[]).filter(item=>item.type==='custom_tool_call_output'||item.type==='function_call_output');
      const output=call===1?[{type:'custom_tool_call',name:'exec',call_id:'call_preparation_'+scenario,input:${JSON.stringify(scripts)}[scenario]}]
        :[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(outputs.at(-1))}]}];
      server.send(JSON.stringify({type:'response.completed',response:{id:'resp_preparation_'+scenario+'_'+call,status:'completed',end_turn:call>1,output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
    }); return new Response(null,{status:101,webSocket:client});
  }
}
export default {fetch(request,env) {
  const url=new URL(request.url),path=url.pathname;
  if(path.startsWith('/account-tools/')) return env.NANOCODEX_ACCOUNT_TOOLS.getByName('${owner}').fetch(new Request('https://account-tools.internal/'+path.slice('/account-tools/'.length),request));
  if(path==='/tool-host') return env.NANOCODEX_ACCOUNT_TOOLS.getByName('${owner}').fetch(new Request('https://account-tools.internal/tool-host',request));
  return env.NANOCODEX_SESSIONS.getByName('fixture-session').fetch(new Request('https://session.internal'+path.replace('/v1/agents/${thread}','')+url.search,request));
}};
`;

test("fresh shipped Code Mode cells join independent readiness and discovery without changing dispatch safety", { timeout: 90_000 }, async () => {
  const label = process.env.NANOCODEX_BENCHMARK_LABEL ?? "local";
  assert.match(label, /^[a-zA-Z0-9_-]+$/);
  const output = join(repo, "output/hand-preparation-journey", `${label}-${Date.now()}-${process.pid}`);
  const workspace = join(output, "hand");
  await mkdir(workspace, { recursive: true });
  const records = [], wire = [], http = [], runtime = [], samples = [];
  const result = { command, label, inputs: { owner, thread, machine, scripts, mounts, snapshot_delay_ms: 120, vm_delay_ms: [160,40], warmups: 2 },
    expected: { once_only_effects: 14, concurrent_cell_capture_count: 7, unavailable_vms_excluded: true, brain_bypasses_prepare: true, discovery_failure_predispatch: true }, observed: {} };
  const capture = line => { runtime.push(line); const start=line.indexOf('{"type":'); if(start>=0) {try {records.push(JSON.parse(line.slice(start)));} catch {}} };
  let mf, native, tools, attachment, failure;
  const prepSource = process.env.NANOCODEX_NAMESPACE_PREP_SOURCE;
  try {
    const assets = [];
    const plugins = [{ name: "wasm", setup(builder) { builder.onResolve({ filter: /\.wasm$/ }, async args => {
      const path=join(args.resolveDir,args.path),contents=await readFile(path),name=`fixture-${assets.length}.wasm`;
      assert.ok(path.startsWith(repo)); assets.push({type:"CompiledWasm",path:name,contents}); return {path:`./${name}`,external:true};
    }); } }];
    if (prepSource) plugins.push({name:"preparation-source",setup(builder) {builder.onLoad({filter:/\/managed\/src\/index\.ts$/},async()=>({contents:await readFile(prepSource,"utf8"),loader:"ts",resolveDir:join(root,"src")}));}});
    const bundle = await build({stdin:{contents:source,resolveDir:root},bundle:true,write:false,metafile:true,format:"esm",platform:"node",conditions:["workerd"],target:"es2022",
      banner:{js:'import { createRequire } from "node:module"; const require=createRequire("/worker.mjs");'},external:["cloudflare:*","node:*"],
      alias:{"nanocodex-tools/hosted":join(repo,"js/nanocodex-tools/src/hosted/index.ts"),"node-rsa":join(root,"../nanocodex/tools/browser/unsupportedNodeRsa.mjs")},plugins,logLevel:"silent"});
    const hashes = Object.fromEntries(await Promise.all(["js/managed/src/index.ts","js/managed/src/hand-call-observation.ts","js/managed/src/account-hosted-tools.ts","js/nanocodex-tools/src/hosted/broker-core.ts","js/nanocodex-tools/tools/processOutput.mjs"].map(async path => [path,createHash("sha256").update(await readFile(path.endsWith("/index.ts")&&prepSource?prepSource:join(repo,path))).digest("hex")])));
    await writeFile(join(output,"source-resolution.json"),JSON.stringify({prepSource:prepSource??null,hashes,bundleInputs:Object.keys(bundle.metafile.inputs)},null,2));
    await writeFile(join(output,"fixture-source.mjs"),source); await writeFile(join(output,"worker.mjs"),bundle.outputFiles[0].text);
    const date="2026-07-30";
    mf = new Miniflare({port:0,handleRuntimeStdio(stdout,stderr){createInterface({input:stdout}).on("line",capture);createInterface({input:stderr}).on("line",capture);},durableObjectsPersist:join(output,"sqlite"),workers:[
      {name:"managed",compatibilityDate:date,compatibilityFlags:["nodejs_compat","enable_request_signal"],modules:[{type:"ESModule",path:"worker.mjs",contents:bundle.outputFiles[0].text},...assets],bindings:{AGENT_IDLE_TIMEOUT_MS:"60000"},
        durableObjects:{NANOCODEX_SESSIONS:{className:"FixtureSession",useSQLite:true},NANOCODEX_ACCOUNT_TOOLS:{className:"ObservedAccountHostedTools",useSQLite:true},NANOCODEX_MEMORY:{className:"FixtureModel",useSQLite:true},MODEL:{className:"FixtureModel",useSQLite:true},NANOCODEX_VM_HOST_POOLS:{className:"FixturePool",useSQLite:true}},
        serviceBindings:{NANOCODEX:"provider"},r2Buckets:["NANOCODEX_HISTORY","NANOCODEX_WORKSPACES"]},
      {name:"provider",compatibilityDate:date,modules:true,script:"export default {fetch(request,env){return env.MODEL.getByName('fixture-model').fetch(request)}}",durableObjects:{MODEL:{className:"FixtureModel",scriptName:"managed",useSQLite:true}}}]});
    const base=await mf.ready;
    const headers={"x-nanocodex-owner-id":owner,"x-nanocodex-session-organization-id":organization,"x-nanocodex-session-team-id":team,"x-nanocodex-authorization-epoch":"1","x-nanocodex-capabilities":JSON.stringify(["agents:read","agents:write","tools:use"]),"content-type":"application/json"};
    const request=async(path,init={})=>{const response=await fetch(new URL(path,base),{...init,headers:{...headers,...init.headers},signal:AbortSignal.timeout(10_000)}),body=await response.text();http.push({path,status:response.status,method:init.method??"GET",body});return {status:response.status,value:body?JSON.parse(body):undefined};};
    assert.equal((await request("/__seed",{method:"POST"})).status,204);
    native=await createNodeProcessTools({workspace}); tools=await createTools({tools:native.tools});
    const endpoint=new URL("/tool-host",base);endpoint.protocol="ws:";
    attachment=createAttachment(tools,{endpoint:endpoint.href,transport:{connect(){const socket=new WebSocket(endpoint,{headers:{"x-nanocodex-owner-id":owner}}),send=socket.send.bind(socket);socket.send=(data,...args)=>{wire.push({direction:"host",frame:JSON.parse(String(data))});return send(data,...args);};socket.on("message",data=>wire.push({direction:"broker",frame:JSON.parse(String(data))}));return socket;}}},{machines:[{id:machine,name:"Synthetic Preparation Hand",workspace,capabilities:["shell"]}],attachmentId:machine});
    assert.equal((await attachment.connect()).connected,true);
    let number=100;
    const runTurn=async scenario=>{const started=performance.now(),id=`00000000-0000-7000-8000-${String(number++).padStart(12,"0")}`;
      const accepted=await request(`/v1/agents/${thread}/turns`,{method:"POST",body:JSON.stringify({id,input:`PREPARATION_${scenario}`})});assert.equal(accepted.status,202,JSON.stringify(accepted));
      for(let i=0;i<1500;i++){const response=await request(`/v1/agents/${thread}/turns/${accepted.value.turn_id}`);assert.equal(response.status,200);assert.ok(!["failed","cancelled"].includes(response.value.state),JSON.stringify(response));if(response.value.state==="completed")return {turn:response.value,elapsed_ms:performance.now()-started};await delay(10);}throw Error("turn deadline");};
    // Warm startup's optional inventory first; measured cells still demand fresh snapshots.
    for(const scenario of trials.slice(0,2)) {const value=await runTurn(scenario);assert.match(JSON.stringify(value.turn),/PREP_OK/);}
    assert.equal((await request("/account-tools/__fixture",{method:"POST",body:JSON.stringify({delay_ms:120})})).status,204);
    for(const scenario of trials.slice(2)) {
      const first=records.length,value=await runTurn(scenario),current=records.slice(first),stages=current.filter(row=>row.type==="hand.tool.stage"&&row.parent_call_id===`call_preparation_${scenario}`&&row.stage==="namespace.prepare");
      assert.match(JSON.stringify(value.turn),/PREP_OK/);assert.doesNotMatch(JSON.stringify(value.turn),/UNSAFE_VM/);assert.equal(stages.length,1,"concurrent calls must join one cell preparation");
      assert.equal(current.filter(row=>row.type==="fixture.pool"&&row.stage==="start").length,2);
      assert.equal(current.filter(row=>row.type==="fixture.snapshot"&&row.stage==="start").length,1);
      const snapshot=current.find(row=>row.type==="fixture.snapshot"&&row.stage==="start");
      const slowEnd=current.find(row=>row.type==="fixture.pool"&&row.stage==="end"&&row.pool==="slow");
      const readiness=current.find(row=>row.type==="hand.tool.stage"&&row.parent_call_id===`call_preparation_${scenario}`&&row.stage==="namespace.host_readiness");
      const discovery=current.find(row=>row.type==="hand.tool.stage"&&row.parent_call_id===`call_preparation_${scenario}`&&row.stage==="namespace.account_discovery");
      samples.push({scenario,prepare_ms:stages[0].duration_ms,public_turn_ms:value.elapsed_ms,snapshot_started_before_slow_vm_finished:snapshot.at<slowEnd.at,
        ...(readiness?{host_readiness_ms:readiness.duration_ms}:{}),...(discovery?{account_discovery_ms:discovery.duration_ms}:{})});
    }
    const before=wire.filter(row=>row.direction==="broker"&&row.frame.type==="call").length;
    const brain=await runTurn("BRAIN");assert.match(JSON.stringify(brain.turn),/BRAIN_INDEPENDENT/);
    assert.ok(!records.some(row=>row.type==="hand.tool.stage"&&row.parent_call_id==="call_preparation_BRAIN"&&row.stage==="namespace.prepare"));
    assert.equal((await request("/account-tools/__fixture",{method:"POST",body:JSON.stringify({delay_ms:30,fail:true})})).status,204);
    const failedId=`00000000-0000-7000-8000-${String(number++).padStart(12,"0")}`;
    const failureAdmission=await request(`/v1/agents/${thread}/turns`,{method:"POST",body:JSON.stringify({id:failedId,input:"PREPARATION_FAIL"})});
    assert.equal(failureAdmission.status,202);
    for(let i=0;i<1000&&!records.some(row=>row.type==="hand.tool.stage"&&row.stage==="namespace.prepare"&&row.parent_call_id==="call_preparation_FAIL"&&row.outcome==="failed");i++) await delay(5);
    assert.ok(records.some(row=>row.type==="hand.tool.stage"&&row.stage==="namespace.prepare"&&row.parent_call_id==="call_preparation_FAIL"&&row.outcome==="failed"));
    // Discovery failures enter managed recovery. Exercise the user's public
    // cancel surface rather than having the fixture model fabricate a retry.
    const cancel=await request(`/v1/agents/${thread}/turns/${failedId}/cancel`,{method:"POST"});
    assert.ok([200,202].includes(cancel.status),JSON.stringify(cancel));
    let failedTurn;
    for(let i=0;i<1000;i++) {failedTurn=await request(`/v1/agents/${thread}/turns/${failedId}`);if(["cancelled","failed","completed"].includes(failedTurn.value.state))break;await delay(5);}
    assert.equal(failedTurn.value.state,"cancelled",JSON.stringify(failedTurn));
    assert.equal(wire.filter(row=>row.direction==="broker"&&row.frame.type==="call").length,before,"discovery failure and Brain must never dispatch to a Hand");
    const effects=(await readFile(join(workspace,"effect.log"),"utf8")).trim().split("\n").sort();
    assert.deepEqual(effects,trials.flatMap(scenario=>[`${scenario}:a`,`${scenario}:b`]).sort());assert.equal(before,14);
    const diagnostics=await request(`/v1/agents/${thread}/diagnostics?limit=1024`);assert.equal(diagnostics.status,200);
    if(!prepSource) {
      const managed=diagnostics.value.services.find(service=>service.service==="managed");
      assert.equal(managed.available,true);
      for(const stage of ["namespace.host_readiness","namespace.account_discovery"]) {
        assert.ok(managed.events.some(event=>event.stage===stage&&event.parent_call_id==="call_preparation_MEASURE_2"&&event.outcome==="ok"),`owner diagnostics must expose ${stage}`);
      }
      const failedRows=managed.events.filter(event=>event.parent_call_id==="call_preparation_FAIL");
      assert.ok(failedRows.some(event=>event.stage==="namespace.account_discovery"&&event.outcome==="failed"));
      assert.ok(failedRows.some(event=>event.stage==="namespace.host_readiness"&&event.outcome==="ok"),"failed discovery must join ongoing VM readiness before completing preparation");
    }
    await writeFile(join(output,"diagnostics.json"),JSON.stringify(diagnostics.value,null,2));
    result.observed={once_only_effects:effects.length,concurrent_cell_capture_count:7,unavailable_vms_excluded:true,brain_bypasses_prepare:true,discovery_failure_predispatch:true,failed_discovery_cancelled:true,samples};
    console.log(JSON.stringify({evidence:output,label,...result.observed}));
  } catch(error){failure=error;result.error=error.stack;throw error;}
  finally {try{await attachment?.close();await tools?.close();await native?.close();await mf?.dispose();}finally{
    await writeFile(join(output,"trace.json"),JSON.stringify({result,records},null,2));await writeFile(join(output,"wire.json"),JSON.stringify(wire,null,2));await writeFile(join(output,"http.json"),JSON.stringify(http,null,2));await writeFile(join(output,"runtime.log"),runtime.join("\n")+"\n");
    await writeFile(join(output,"README.md"),`Run: \`${command}\`\n\nLabel: ${label}\nStatus: ${failure?"FAIL: "+failure.message:"PASS"}\nInputs: ${JSON.stringify(result.inputs)}\nExpected: ${JSON.stringify(result.expected)}\nObserved: ${JSON.stringify(result.observed)}\n\nActual public HTTP turn admission/results and shipped fresh-cell Session callback, WASM Code Mode, account discovery, SQLite ledger, reverse WebSocket and native /bin/sh. Synthetic external VM pool negative receipts wait 160/40ms; a wrapper around the real account DO adds 120ms to the actual snapshot response. These injected waits demonstrate overlap only, not production network latency. First two cells excluded as warmups. Optional NANOCODEX_NAMESPACE_PREP_SOURCE bundles a saved baseline index.ts with all other source resolutions unchanged (source-resolution.json hashes). Retain paired runs and outliers. trace.json, wire.json, http.json, diagnostics.json, runtime.log, fixture-source.mjs, worker.mjs and SQLite are the inspection evidence.\n`);
  }}
});
