// Evidence defaults to ignored output/claude-managed; NANOCODEX_CLAUDE_EVIDENCE_DIR overrides it.
// Reproduce: pnpm --filter nanocodex-managed-service run test:claude-managed
// The public Worker, account auth, SQLite Session DO, Rust Nanoclaude, private
// SessionModelEgress, broker vault and Rust OAuth state machine are production.
// Only account bootstrap (synthetic identity) and external provider HTTP are fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { Miniflare } from 'miniflare';
import { claudeProvider } from '../../egress/test/claude-provider.fixture.mjs';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = resolve(repo, process.env.NANOCODEX_CLAUDE_EVIDENCE_DIR ?? 'output/claude-managed');
const grantHeaders = { 'x-nanocodex-connect-user':'11111111-1111-4111-8111-111111111133', 'x-nanocodex-connect-grant-id':'0x'+'a'.repeat(64), 'x-nanocodex-connect-capabilities':JSON.stringify(['agents:read','agents:write','tools:use']), 'x-nanocodex-connect-connectors':JSON.stringify(['chatgpt']), 'x-nanocodex-connect-mcp-ids':'[]', 'content-type':'application/json' };
const identity = '11111111-1111-4111-8111-111111111133';
const bootstrap = `
import managed, * as publicClasses from './src/index.ts';
export * from './src/index.ts';
import { ensureAccount, createApiKey } from './src/account-auth.ts';
export default { async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === '/__fixture/openai') {
    return env.NANOCODEX.fetch('https://broker.internal/users/11111111-1111-4111-8111-111111111133/credentials/openai', {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({api_key:'sk-synthetic-openai-runtime'})});
  }
  if (new URL(request.url).pathname === '/__fixture') {
    const { user, capabilities } = await request.json();
    await ensureAccount(env, user, true);
    const auth = await (await env.NANOCODEX_USERS.getByName(user).fetch('https://user.internal/authorization')).json();
    return Response.json(await createApiKey(env, { kind:'api_key',userId:user,...auth.grant,
      ...(capabilities?{capabilities}:{}),subjectId:'fixture:'+user,credentialId:'fixture' }, 'synthetic-claude-managed'));
  }
  return managed.fetch(request, env, ctx);
} };
`;
async function bundle(source, cwd, name) {
  const wasm = new Set();
  const output = await build({ stdin: { contents:source, resolveDir:cwd }, bundle:true, write:false,
    format:'esm', platform:'browser', target:'es2022', external:['cloudflare:*','node:*'],
    alias:{'node-rsa':resolve(repo,'js/nanocodex/tools/browser/unsupportedNodeRsa.mjs')},
    plugins:[{ name:'actual-wasm', setup(b) {
      b.onResolve({filter:/^[a-z][a-z_]*$/}, args => builtinModules.includes(args.path) ? {path:'node:'+args.path,external:true} : undefined);
      b.onResolve({filter:/\.wasm$|^nanocodex\/wasm$/}, args => {
        const path = args.path === 'nanocodex/wasm' ? resolve(repo,'js/nanocodex/pkg-web/nanocodex_bg.wasm') : resolve(args.resolveDir,args.path);
        wasm.add(path); return {path,external:true};
      });
    } }],
  });
  const path = resolve(evidence,`${name}.mjs`);
  const code = output.outputFiles[0].text;
  const requires = [...new Set([...code.matchAll(/__require\("(node:[^"]+)"\)/g)].map(match=>match[1]))];
  const prelude = requires.map((name,index)=>`import * as builtin${index} from ${JSON.stringify(name)};`).join('\n')
    + `\nconst requireMap={${requires.map((name,index)=>`${JSON.stringify(name)}:builtin${index}`).join(',')}}; const require=name=>{if(!requireMap[name])throw new Error('Unexpected require '+name);return requireMap[name];};\n`;
  await writeFile(path,prelude+code);
  return [{type:'ESModule',path},...Array.from(wasm,path=>({type:'CompiledWasm',path}))];
}
function sse(block, stop, id) {
  const tool = block.type === 'tool_use';
  const events = [
    {type:'message_start',message:{id,role:'assistant',model:'claude-sonnet-4-6',content:[],usage:{input_tokens:10,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id:block.id,name:['web_search','code_execution','text_editor','computer'].includes(block.name.toLowerCase())?block.name:'_'+block.name,input:{}}:block},
    ...(tool?[{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}}]:[]),
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:2}},
    {type:'message_stop'},
  ];
  return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
test('Claude-only public native tools/tasks/compaction/cancel across four DO reopens; account/grant/catalog gates', {timeout:240_000}, async () => {
  await mkdir(evidence,{recursive:true});
  const trace = [], upstream = []; let calls=0, summaries=0, writes=0, taskWrites=0, holds=0, responsesAttempts=0, catalogOutage=false, catalogUnsupportedOnly=false, retainedTaskId, mf;
  const provider = async request => {
    const url = new URL(request.url);
    if (url.origin === 'https://api.openai.com' || url.origin === 'https://chatgpt.com') { responsesAttempts++; throw new Error('Claude journey must never cross into OpenAI'); }
    if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/models') {
      if(catalogOutage)return new Response('synthetic catalog unavailable',{status:503});
      assert.match(request.headers.get('authorization')??'',/^Bearer synthetic-claude-(?:managed-runtime|profile-uncertain)/);
      if(catalogUnsupportedOnly)return Response.json({data:[{id:'claude-gated-unverified',display_name:'Not supported'}],has_more:false});
      assert.equal(url.searchParams.get('limit'),'100');
      if (!url.searchParams.has('after_id')) return Response.json({data:[{id:'claude-gated-unverified',display_name:'Not supported'}],has_more:true,last_id:'claude-gated-unverified'});
      assert.equal(url.searchParams.get('after_id'),'claude-gated-unverified');
      return Response.json({data:[{id:'claude-sonnet-4-6',display_name:'Claude Sonnet 4.6'},
        {id:'claude-opus-4-6',display_name:'Claude Opus 4.6'}, {id:'claude-gated-unverified',display_name:'Not supported'}],has_more:false});
    }
    if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') {
      assert.match(request.headers.get('authorization')??'',/^Bearer synthetic-claude-managed-runtime/);
      for (const name of ['x-nanocodex-subject','x-nanocodex-session-model-owner','x-nanocodex-claude-host','x-api-key']) assert.equal(request.headers.has(name),false,`private ${name} stripped`);
      assert.equal(url.search,'?beta=true');
      assert.equal(request.headers.get('x-app'),'cli');
      assert.equal(request.headers.has('x-claude-code-request-class'),false);
      assert.equal(request.headers.get('anthropic-dangerous-direct-browser-access'),'true');
      assert.equal(request.headers.get('user-agent'),'claude-cli/2.1.280 (external, cli)');
      assert.equal(request.headers.get('x-stainless-runtime'),'node');
      assert.equal(request.headers.get('x-stainless-lang'),'js');
      assert.equal(request.headers.get('x-stainless-package-version'),'0.112.1');
      const wire = await request.text(); const body = JSON.parse(wire); calls++;
      assert.equal(body.model,'claude-sonnet-4-6'); assert.equal(body.stream,true);
      assert.match(body.system[0].text,/^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/);
      assert.equal(body.system[1].text,"You are Claude Code, Anthropic's official CLI for Claude.");
      assert.equal(JSON.parse(body.metadata.user_id).session_id,request.headers.get('x-claude-code-session-id'));
      assert.equal(request.headers.get('accept'),'application/json');
      assert.equal(body.output_config.effort,'low');
      const system=JSON.stringify(body.system);
      for(const invalid of ['Code Mode','exec_command','write_stdin','tool_search','tools.exec','Promise.all'])assert.ok(!system.includes(invalid),`native system must not demand ${invalid}`);
      const wireNames=(body.tools??[]).map(t=>t.name);
      const names=wireNames.map(name=>name.startsWith('_')?name.slice(1):name);
      assert.deepEqual(wireNames,names.map(name=>['web_search','code_execution','text_editor','computer'].includes(name.toLowerCase())?name:'_'+name));
      for(const name of ['exec','wait','exec_command','apply_patch','web__run','tool_search'])assert.ok(!names.includes(name),`no Responses tool ${name}`);
      upstream.push({wire,request:calls,model:body.model,tool_names:names,wire_tool_names:wireNames,message_count:body.messages.length,
        tool_uses:body.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(block=>block.type==='tool_use').map(block=>block.name):[]),
        tool_result_count:body.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(block=>block.type==='tool_result'):[]).length,
        prior_proof_present:JSON.stringify(body.messages).includes('NATIVE_CLAUDE_DURABLE_PROOF'),summary_present:JSON.stringify(body.messages).includes('NATIVE_SUMMARY'),effort:body.output_config.effort});
      const latest=body.messages.at(-1), result=Array.isArray(latest.content)&&latest.content.find(b=>b.type==='tool_result');
      if(result) {
        assert.equal(result.is_error??false, result.tool_use_id.startsWith('denied-'), 'only adversarial unregistered calls fail');
        return sse({type:'text',text:`CLAUDE_TOOL_DONE_${calls}`},'end_turn',`message-${calls}`);
      }
      const prompt = JSON.stringify(latest.content);
      if(prompt.includes('CRITICAL: Respond with TEXT ONLY')) {
        summaries++; return sse({type:'text',text:'NATIVE_SUMMARY durable proof already written; never repeat Write'},'end_turn',`summary-${calls}`);
      }
      if(prompt.includes('Try forbidden Read')) {
        assert.deepEqual(names,['Write'],'the final native catalog is the exact requested allowlist');
        return sse({type:'tool_use',id:`denied-read-${calls}`,name:'Read',input:{file_path:'/brain/proof.txt'}},'tool_use',`message-${calls}`);
      }
      if(!names.length) return sse({type:'tool_use',id:`denied-${calls}`,name:'Write',input:{file_path:'/brain/denied.txt',content:'MUST_NOT_EXIST'}},'tool_use',`message-${calls}`);
      if(prompt.includes('Read retained task receipt'))return sse({type:'tool_use',id:`task-output-${calls}`,name:'TaskOutput',input:{task_id:retainedTaskId}},'tool_use',`message-${calls}`);
      if(prompt.includes('Delegate native child')) return sse({type:'tool_use',id:`task-${calls}`,name:'Task',input:{prompt:'CHILD_WRITE proof once',subagent_type:'worker'}},'tool_use',`message-${calls}`);
      if(prompt.includes('CHILD_WRITE proof once')) { taskWrites++; return sse({type:'tool_use',id:`child-write-${calls}`,name:'Write',input:{file_path:'/brain/child-proof.txt',content:'CLAUDE_NATIVE_CHILD_PROOF'}},'tool_use',`message-${calls}`); }
      if(prompt.includes('Hold until cancelled')) {
        holds++; return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({type:'message_start',message:{id:'cancel-fixture',role:'assistant',model:body.model,content:[],usage:{input_tokens:10,output_tokens:0}}})}\n\n`));
        } }),{headers:{'content-type':'text/event-stream'}});
      }
      assert.ok(names.includes('Bash'));assert.ok(names.includes('Write'));assert.ok(names.includes('Read'));
      if(prompt.includes('Write durable proof')){writes++;return sse({type:'tool_use',id:`write-${calls}`,name:'Write',input:{file_path:'/brain/proof.txt',content:'NATIVE_CLAUDE_DURABLE_PROOF'}},'tool_use',`message-${calls}`);}
      if(prompt.includes('Read durable proof')){
        assert.ok(JSON.stringify(body.messages).includes(summaries?'NATIVE_SUMMARY':'CLAUDE_TOOL_DONE_2'),'prior native history/summary persisted');
        return sse({type:'tool_use',id:`read-${calls}`,name:'Read',input:{file_path:'/brain/proof.txt'}},'tool_use',`message-${calls}`);
      }
      return sse({type:'tool_use',id:`bash-${calls}`,name:'Bash',input:{command:prompt.includes('Check denied file')?'test ! -e /brain/denied.txt && echo NO_UNAUTHORIZED_FILE':'cat /brain/proof.txt',workdir:'/brain'}},'tool_use',`message-${calls}`);
    }
    const response = await claudeProvider(request); if(response)return response;
    return new Response('Unexpected external fixture request '+url.origin+url.pathname,{status:502});
  };
  const managedModules=await bundle(bootstrap,resolve(repo,'js/managed'),'managed-journey');
  const egressModules=await bundle(`export * from './src/egress.ts'; export { default } from './src/egress.ts';`,resolve(repo,'js/egress'),'egress-journey');
  const persistence=resolve(evidence,'sqlite-'+crypto.randomUUID());
  const options={durableObjectsPersist:persistence,r2Persist:resolve(persistence,'r2'),workers:[
    {name:'managed',modulesRoot:'/',modules:managedModules,compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat','enable_request_signal'],
      bindings:{MANAGED_AGENT_DIRECT_CREDENTIALS:'true'},
      serviceBindings:{NANOCODEX:'egress',NANOCODEX_SESSION_MODEL_EGRESS:{name:'egress',entrypoint:'SessionModelEgress'}},
      durableObjects:Object.fromEntries([['NANOCODEX_AUTH','NonceStorage'],['NANOCODEX_USERS','UserAccount'],['NANOCODEX_ORGANIZATIONS','Organization'],['NANOCODEX_API_KEYS','ApiKeyRecord'],['NANOCODEX_SESSIONS','DurableAgentSession'],['NANOCODEX_ACCOUNT_TOOLS','AccountHostedTools'],['NANOCODEX_VM_HOST_POOLS','VmHostPool'],['NANOCODEX_MEMORY','MemoryScope']].map(([binding,className])=>[binding,{className,useSQLite:true}])),
      r2Buckets:['NANOCODEX_HISTORY','NANOCODEX_WORKSPACES'],outboundService:provider},
    {name:'egress',modulesRoot:'/',modules:egressModules,compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat','enable_request_signal'],
      bindings:{ENVIRONMENT:'test',CREDENTIAL_ENCRYPTION_KEY:'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY'},
      serviceBindings:{MANAGED_AGENT_OWNERSHIP:{name:'managed',entrypoint:'ManagedAgentOwnership'}},
      durableObjects:Object.fromEntries([['USER_CREDENTIALS','UserCredentialBroker'],['AGENT_SUBJECTS','AgentSubjectDirectory'],['USER_CONNECTORS','UserConnectorBroker'],['MCP_CONNECTIONS','McpConnectionDirectory'],['SPOTIFY_RATE_LIMITS','SpotifyRateLimit'],['GMAIL_PUSH_MAILBOXES','GmailPushMailbox']].map(([binding,className])=>[binding,{className,useSQLite:true}])),outboundService:provider},
  ]};
  let token;
  const call=async(path,method='GET',body,status=200,headers={})=>{
    const response=await mf.dispatchFetch('https://nanocodex.example'+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json',origin:'https://nanocodex.example',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();let value;try{value=JSON.parse(text)}catch{value=text}
    const artifactValue = (path.startsWith('/__fixture') || path.includes('/credentials/claude/login'))
      ? {state:value?.state,error:value?.error,private_fields:'redacted'}
      : path.includes('/events/history') ? {event_count:value?.data?.length,has_more:value?.has_more,latest_cursor:value?.latest_cursor,
          tools:[...new Set((value?.data??[]).map(row=>row.event?.payload?.tool).filter(Boolean))],child_event_count:(value?.data??[]).filter(row=>row.agent_id!==undefined&&row.event).length}
      : path.includes('/turns') ? {state:value?.state,turn_id:value?.turn_id,receipt_present:true} : value;
    trace.push({method,path,status:response.status,value:artifactValue});assert.equal(response.status,status,JSON.stringify(artifactValue));return value;
  };
  const turn=async(agent,input,id,expected='completed')=>{
    const receipt=await call(`/v1/agents/${agent}/turns`,'POST',{input,id},202);
    let status;
    for(let n=0;n<150;n++){
      status=await call(`/v1/agents/${agent}/turns/${receipt.turn_id??id}`);
      if(['completed','failed','cancelled'].includes(status.state))break;
      await new Promise(r=>setTimeout(r,40));
    }
    assert.equal(status.state,expected,JSON.stringify(status));if(expected==='completed')assert.match(JSON.stringify(status),/CLAUDE_TOOL_DONE_/);return status;
  };
  try {
    mf=new Miniflare(options);
    token=(await call('/__fixture','POST',{user:identity})).token;
    assert.equal((await call('/v1/credentials')).claude.connected,false);
    for(const capabilities of [['agents:read'],['agents:write']]) {
      const scoped=(await call('/__fixture','POST',{user:identity,capabilities})).token;
      for(const [path,method,body] of [['/v1/credentials/claude/login','POST',undefined],['/v1/credentials/claude/login','GET',undefined],['/v1/credentials/claude/login/complete','POST',{code:'synthetic-denied'}],['/v1/credentials/claude','DELETE',undefined]])await call(path,method,body,401,{authorization:'Bearer '+scoped});
    }
    for(const [path,method,body] of [['/v1/credentials/claude/login','POST',undefined],['/v1/credentials/claude/login','GET',undefined],['/v1/credentials/claude/login/complete','POST',{code:'synthetic-denied'}],['/v1/credentials/claude','DELETE',undefined]]) {
      const response=await mf.dispatchFetch('https://nanocodex.internal'+path,{method,headers:grantHeaders,...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,401);trace.push({path,method,principal:'trusted ConnectGrant assertion',status:response.status});
    }
    assert.equal((await call('/v1/credentials/claude/login')).state,'signed_out');
    const login=await call('/v1/credentials/claude/login','POST');
    const state=new URL(login.authorization_url).searchParams.get('state');
    await call('/v1/credentials/claude/login/complete','POST',{code:`managed-runtime#${state}`});
    const credentials=await call('/v1/credentials');assert.equal(credentials.ready,true);assert.equal(credentials.claude.connected,true);
    assert.equal(credentials.openai.connected,false);assert.equal(credentials.chatgpt.connected,false);
    catalogUnsupportedOnly=true;
    const unsupportedOnly=await call('/v1/models');assert.deepEqual(unsupportedOnly.data,[]);assert.equal(unsupportedOnly.default_model,null);
    assert.equal(unsupportedOnly.availability.claude.connected,true);assert.equal(unsupportedOnly.availability.claude.available,false);assert.equal(unsupportedOnly.partial,false);
    await call('/v1/agents','POST',{},409);
    await call('/v1/agents','POST',{settings:{model:'claude-sonnet-4-6',thinking:'low',reasoning_mode:'standard',fast_mode:false}},409);
    catalogUnsupportedOnly=false;
    const catalog=await call('/v1/models');assert.equal(catalog.availability.claude.available,true);assert.deepEqual(catalog.data.map(m=>m.id),['claude-sonnet-4-6','claude-opus-4-6']);assert.equal(catalog.default_model,'claude-sonnet-4-6');
    const created=await call('/v1/agents','POST',{},201), agent=created.agent_id;
    assert.equal((await call(`/v1/agents/${agent}`)).settings.model,'claude-sonnet-4-6');
    await call(`/v1/agents/${agent}/settings`,'PATCH',{model:'claude-opus-4-6',thinking:'medium',reasoning_mode:'standard',fast_mode:false});
    await call(`/v1/agents/${agent}/settings`,'PATCH',{model:'claude-sonnet-4-6',thinking:'low',reasoning_mode:'standard',fast_mode:false});
    await turn(agent,'Write durable proof','journey-write');
    await call(`/v1/agents/${agent}/settings`,'PATCH',{model:'claude-opus-4-6'},409);
    const done=await call(`/v1/agents/${agent}/done`,'PUT',{done:true});
    assert.equal(done.done,true);assert.ok(done.done_at>0);
    assert.equal((await call('/v1/agents')).summaries[agent].presentation.done,true);
    await mf.dispose(); mf=new Miniflare(options);
    const doneAfterReopen=(await call('/v1/agents')).summaries[agent].presentation;
    assert.equal(doneAfterReopen.done,true);assert.equal(doneAfterReopen.doneAt,done.done_at);
    await call(`/v1/agents/${agent}/done`,'PUT',{done:false});
    assert.equal((await call('/v1/agents')).summaries[agent].presentation.done,false);
    await turn(agent,'Read durable proof','journey-read');
    await mf.dispose(); mf=new Miniflare(options);
    await turn(agent,'Run Bash durable proof','journey-bash');
    const history=await call(`/v1/agents/${agent}/events/history?after=0&limit=256`);assert.match(JSON.stringify(history),/Write|Read|Bash/);
    await call(`/v1/agents/${agent}/durability`,'POST',undefined,409);
    await call(`/v1/agents/${agent}/forks`,'POST',undefined,409,{'idempotency-key':'claude-fork-denial'});
    await call(`/v1/agents/${agent}/compact`,'POST');
    assert.equal(summaries,1);
    await mf.dispose(); mf=new Miniflare(options);
    await turn(agent,'Read durable proof after summary','journey-after-summary');
    assert.equal(writes,1,'compaction/reopen never repeats prior effect');
    const noTools=(await call('/v1/agents','POST',{configuration:{tools:[]}},201)).agent_id;
    assert.match(JSON.stringify(await turn(noTools,'Try forbidden Write','journey-no-tools','failed')),/outside the admitted catalog/);
    await turn(agent,'Check denied file','journey-denied-file');
    const onlyWrite=(await call('/v1/agents','POST',{configuration:{tools:['Write']}},201)).agent_id;
    assert.match(JSON.stringify(await turn(onlyWrite,'Try forbidden Read','journey-write-only','failed')),/outside the admitted catalog/);
    const unavailable=(await call('/v1/agents','POST',{configuration:{tools:['TaskOutput']}},201)).agent_id;
    const beforeUnavailable=calls;
    assert.match(JSON.stringify(await turn(unavailable,'Unavailable native capability must fail','journey-unavailable','failed')),/unavailable Claude capability/);
    assert.equal(calls,beforeUnavailable,'requested but uninstalled capability fails before inference');
    const childAgent=(await call('/v1/agents','POST',{configuration:{tools:['Task','TaskOutput','TaskStop','Write','Read','Bash'],multi_agent:{enabled:true}}},201)).agent_id;
    await turn(childAgent,'Delegate native child','journey-child');
    assert.equal(taskWrites,1);
    const childHistory=await call(`/v1/agents/${childAgent}/events/history?after=0&limit=256`);
    assert.match(JSON.stringify(childHistory),/Task/);assert.match(JSON.stringify(childHistory),/CLAUDE_NATIVE_CHILD_PROOF/);
    retainedTaskId=childHistory.data.find(row=>row.event?.type==='tool.result'&&row.event.payload.tool==='Task').event.payload.structured_result.task_id;
    const held=await call(`/v1/agents/${agent}/turns`,'POST',{input:'Hold until cancelled',id:'journey-cancel'},202);
    for(let n=0;n<150&&!holds;n++)await new Promise(r=>setTimeout(r,40));assert.equal(holds,1);
    await call(`/v1/agents/${agent}/turns/${held.turn_id??'journey-cancel'}/cancel`,'POST',undefined,202);
    let cancelled;for(let n=0;n<150;n++) { cancelled=await call(`/v1/agents/${agent}/turns/journey-cancel`);if(cancelled.state==='cancelled')break;await new Promise(r=>setTimeout(r,40)); }
    assert.equal(cancelled.state,'cancelled');
    await mf.dispose(); mf=new Miniflare(options);
    assert.equal((await call(`/v1/agents/${agent}/turns/journey-cancel`)).state,'cancelled');
    await call(`/v1/agents/${childAgent}/turns`,'POST',{input:'Delegate native child',id:'journey-child'},200);
    await turn(childAgent,'Read retained task receipt','journey-task-receipt');assert.equal(taskWrites,1,'completed child not replayed after restart');
    await turn(agent,'Run Bash durable proof after cancellation','journey-after-cancel');assert.equal(holds,1,'cancelled request not replayed');

    const beforeGrant=calls;
    for(const [path,body] of [['/v1/models',undefined],['/v1/agents',{settings:{model:'claude-sonnet-4-6',thinking:'low',reasoning_mode:'standard',fast_mode:false}}],[`/v1/agents/${agent}/turns`,{input:'Write durable proof',id:'connect-denied'}]]) {
      const response=await mf.dispatchFetch('https://nanocodex.internal'+path,{method:body?'POST':'GET',headers:grantHeaders,...(body?{body:JSON.stringify(body)}:{})});
      assert.equal(response.status,403);trace.push({path,principal:'trusted ConnectGrant assertion',status:response.status,value:await response.json()});
    }
    assert.equal(calls,beforeGrant,'ConnectGrant denied before Messages forwarding');
    await call('/v1/agents','POST',{configuration:{tools:['WebSearch']}},409);
    await call('/v1/credentials/claude','DELETE');assert.equal((await call('/v1/credentials')).claude.connected,false);
    assert.equal((await call('/v1/models')).data.length,0);
    await call('/v1/agents','POST',{settings:{model:'claude-sonnet-4-6',thinking:'low',reasoning_mode:'standard',fast_mode:false}},409);
    // Reconnect the same real broker flow, then seed only the unavoidable
    // synthetic OpenAI credential boundary. No real provider or secret is used.
    const reconnect=await call('/v1/credentials/claude/login','POST');
    await call('/v1/credentials/claude/login/complete','POST',{code:'managed-runtime#'+new URL(reconnect.authorization_url).searchParams.get('state')});
    await call('/__fixture/openai','POST',undefined,204);catalogOutage=true;
    const mixed=await call('/v1/models');assert.equal(mixed.partial,true);assert.equal(mixed.availability.claude.error,'claude_models_unavailable');
    assert.deepEqual(mixed.data.map(model=>model.id),['gpt-6-astra','gpt-6.1-sol','gpt-6-luna']);
    await turn(agent,'Run Bash durable proof in mixed account','journey-mixed-provider-pin');assert.equal(responsesAttempts,0,'Claude inference/sidebar cannot borrow OAI credential');
    assert.ok(!mixed.data.find(model=>model.id==='gpt-6-astra').thinking.includes('none'));assert.ok(mixed.data.find(model=>model.id==='gpt-6-luna').thinking.includes('none'));
    const mixedDefault=await call('/v1/agents','POST',{},201);assert.equal((await call(`/v1/agents/${mixedDefault.agent_id}`)).settings.model,'gpt-6-astra');
    await call('/v1/agents','POST',{settings:{model:'gpt-6-astra',thinking:'low',reasoning_mode:'standard',fast_mode:false}},201);
    await call('/v1/agents','POST',{settings:{model:'claude-sonnet-4-6',thinking:'low',reasoning_mode:'standard',fast_mode:false}},409);
    await mf.dispose();options.workers[0].bindings.NANOCODEX_THREAD_ROUTING='true';options.workers[0].bindings.OPENROUTER_API_KEY='synthetic-gateway-key';options.workers[0].ai={binding:'AI'};mf=new Miniflare(options);
    const ownerToken=token;
    token=(await call('/__fixture','POST',{user:'11111111-1111-4111-8111-111111111144'})).token;
    const gatewayCredentials=await call('/v1/credentials');for(const name of ['openai','chatgpt','claude'])assert.equal(gatewayCredentials[name].connected,false);
    const gatewayOnly=await call('/v1/models');assert.deepEqual(gatewayOnly.data.map(model=>model.id),['@cf/zai-org/glm-5.3','kimi-k3','mimo-v2.6-pro']);
    assert.equal(gatewayOnly.default_model,'@cf/zai-org/glm-5.3');assert.equal(gatewayOnly.availability.claude.available,false);
    token=ownerToken;
    const legacy=await call('/v1/models');for(const model of ['@cf/zai-org/glm-5.3','kimi-k3','mimo-v2.6-pro'])assert.ok(legacy.data.some(row=>row.id===model));
    const gateway=await call('/v1/agents','POST',{},201);await call(`/v1/agents/${gateway.agent_id}/routing`,'POST',{model:'kimi-k3',thinking:'low'});assert.equal((await call(`/v1/agents/${gateway.agent_id}`)).settings.model,'kimi-k3');
    await call('/v1/credentials/claude','DELETE');catalogOutage=false;
    const staged=await call('/v1/credentials/claude/login','POST');
    const validating=await call('/v1/credentials/claude/login/complete','POST',{code:'profile-uncertain#'+new URL(staged.authorization_url).searchParams.get('state')},400);assert.equal(validating.state,'validating');
    await mf.dispose();mf=new Miniflare(options);
    assert.equal((await call('/v1/credentials/claude/login')).state,'authenticated');assert.equal((await call('/v1/credentials')).claude.connected,true);
    assert.ok((await call('/v1/models')).data.some(row=>row.id==='claude-sonnet-4-6'));
    const validationTrace=await (await claudeProvider(new Request('https://claude-fixture.invalid/trace?scenario=profile-uncertain'))).json();assert.equal(validationTrace.exchange,1);assert.equal(validationTrace.profile,2);
    console.info('CLAUDE_MANAGED_JOURNEY',{calls,summaries,writes,taskWrites,holds,responsesAttempts,DOReopens:4,nativeTools:['Write','Read','Bash'],actualModels:catalog.data.map(m=>m.id),staleSelectionDenied:true,gatewayOnlyDefault:gatewayOnly.default_model,unsupportedOnlyAvailable:unsupportedOnly.availability.claude.available,exactToolAllowlist:true,uninstalledCapabilityDeniedBeforeInference:true});
  } finally {
    await mf?.dispose();
    await writeFile(resolve(evidence,'public-api-trace.json'),JSON.stringify(trace,null,2));
    await writeFile(resolve(evidence,'provider-trace.json'),JSON.stringify(upstream,null,2));
    await rm(persistence,{recursive:true,force:true});
  }
});
