#!/usr/bin/env node
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const origin=process.env.PRIVATE_BROWSER_FIXTURE_ORIGIN;
if(!origin||new URL(origin).protocol!=='https:')throw new Error('Set PRIVATE_BROWSER_FIXTURE_ORIGIN to the deployed synthetic HTTPS fixture origin');
const endpoint=process.env.PRIVATE_BROWSER_SMOKE_URL??'http://127.0.0.1:8797';
const output=resolve(process.env.PRIVATE_BROWSER_SMOKE_OUTPUT??'output/private-browser/journey');
await mkdir(output,{recursive:true});
const run=randomUUID(), vault_id='synthetic-generic-vault-123456';
const fixture=path=>new URL(`${path}?probe=${run}`,origin).href;
const results=[],trace=[];
let identity;
const syntheticSecrets=['generic-fixture@example.test','generic-synthetic-password-42','TakeoverSyntheticSecretAlphaZeta'];
const secretVariants=syntheticSecrets.flatMap(secret=>[secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')]);
async function call(tool,input,extra={}){
 const request={...(tool?{tool,input}:{}),...extra};
 const entry={request};trace.push(entry);await writeFile(resolve(output,'trace.json'),JSON.stringify(trace,null,2)+'\n');
 const response=await fetch(`${endpoint}?run=${run}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(115000)});
 entry.httpStatus=response.status;
 let body;try{body=await response.json();}catch{entry.response={error:'Non-JSON HTTP transport response; operation outcome unknown'};await writeFile(resolve(output,'trace.json'),JSON.stringify(trace,null,2)+'\n');throw new Error(`HTTP ${response.status}: non-JSON transport response; operation outcome unknown`);}
 const serialized=JSON.stringify(body);
 for(const secret of secretVariants)assert.ok(!serialized.includes(secret),`${tool}: credential echo escaped redaction`);
 entry.response=body;
 await writeFile(resolve(output,'trace.json'),JSON.stringify(trace,null,2)+'\n');
 return {status:response.status,...body};
}
async function success(tool,input,extra){const response=await call(tool,input,extra);assert.equal(response.status,200,JSON.stringify(response));return response.result;}
const snapshot=()=>success('browser_vault_snapshot',identity);
async function observe(text){let last;for(let i=0;i<20;i++){last=await snapshot();if(last.text.includes(text))return last;await new Promise(resolve=>setTimeout(resolve,200));}throw new Error(`Missing visible confirmation ${text}: ${JSON.stringify(last)}`);}
const action=(input)=>success('browser_vault_action',{...identity,operation_id:randomUUID(),...input});
function ref(page,text){const element=page.elements.find(el=>el.text===text);assert.ok(element,`No current ref for ${text}: ${JSON.stringify(page.elements)}`);return {snapshot_id:page.snapshot_id,ref:element.ref};}
async function evidence(){const response=await fetch(fixture('/evidence'),{cache:'no-store'});assert.equal(response.status,200);return response.json();}
async function check(name,fn){try{const detail=await fn();results.push({name,status:'pass',detail});console.log(`PASS ${name}`);}catch(error){results.push({name,status:'fail',error:error.message});console.error(`FAIL ${name}: ${error.message}`);process.exitCode=1;throw error;}}
try{
 if(!process.argv.includes('--takeover-only')&&!process.argv.includes('--secure-input-only')){
 await check('caller-denied-before-vault',async()=>{const out=await call('browser_vault_open',{vault_id,url:fixture('/merchant')},{deny:true});assert.equal(out.status,400);assert.match(out.error,/denied/);return out;});
 await check('unapproved-origin-rejected',async()=>{const out=await call('browser_vault_open',{vault_id,url:'https://example.com/'});assert.equal(out.status,400);return out;});
 await check('open-and-login-with-redacted-echo',async()=>{
  const opened=await success('browser_vault_open',{vault_id,url:fixture('/merchant')});assert.equal(opened.status,'opened');identity={vault_id,target_id:opened.target_id,expected_origin:opened.expected_origin};
  let status;for(let attempt=0;attempt<20;attempt++){status=await success('browser_vault_status',identity);if(status.status==='login_form')break;await new Promise(r=>setTimeout(r,200));}assert.equal(status.status,'login_form');
  const fillInput={...identity,operation_id:randomUUID(),username_selector:'input[name=email]',password_selector:'input[name=password]',submit:true};const fill=await success('browser_vault_fill',fillInput);assert.ok(['filled','submitted'].includes(fill.status));
  if(fill.submission==='action_required'){const page=await snapshot();await action({action:'click',...ref(page,'Sign in')});}
  const page=await observe('Signed in synthetic account');assert.deepEqual(await success('browser_vault_fill',fillInput),fill);assert.ok(page.text.includes('[redacted]'));assert.equal((await evidence()).loginPosts,1);return {fill,page};
 });
 await check('open-resumes-without-new-login',async()=>{const resumed=await success('browser_vault_open',{vault_id,url:fixture('/merchant')});assert.equal(resumed.status,'resumed');assert.equal(resumed.target_id,identity.target_id);assert.equal((await evidence()).loginPosts,1);return resumed;});
 await check('stale-snapshot-rejected-without-booking',async()=>{const first=await snapshot();await snapshot();const out=await call('browser_vault_action',{...identity,operation_id:randomUUID(),action:'click',...ref(first,'Book synthetic class')});assert.ok(out.status===400||out.result?.status==='outcome_unknown');assert.equal((await evidence()).bookingPosts,0);return out;});
 await check('booking-once-and-cached-after-runtime-reconstruction',async()=>{
  const page=await snapshot();const input={...identity,operation_id:randomUUID(),action:'click',...ref(page,'Book synthetic class')};
  const first=await success('browser_vault_action',input);assert.equal(first.status,'action_requested');await observe('Synthetic booking confirmed');
  assert.deepEqual(await success('browser_vault_action',input),first);
  const rebuilt=await call(undefined,undefined,{control:'reconstruct'});assert.equal(rebuilt.reconstructed,true);
  assert.deepEqual(await success('browser_vault_action',input),first);assert.equal((await evidence()).bookingPosts,1);
  const mismatch=await call('browser_vault_action',{...input,ref:'e199'});assert.equal(mismatch.status,400);assert.equal((await evidence()).bookingPosts,1);return {first,mismatch,evidence:await evidence()};
 });
 await check('ordinary-form-fill-select-check-and-submit',async()=>{
  for(const [label,fields] of [['Display name',{action:'fill',text:'Taylor Synthetic'}],['Notes',{action:'fill',text:'Aisle seat please'}],['Class time',{action:'select',option_index:1}],['Send updates',{action:'check',checked:true}]]){
   const page=await snapshot();const result=await action({...fields,...ref(page,label)});assert.equal(result.status,'action_requested');
  }
  const page=await snapshot();await action({action:'click',...ref(page,'Save profile')});const confirmed=await observe('Synthetic profile saved');assert.equal((await evidence()).profilePosts,1);return {page:confirmed,evidence:await evidence()};
 });
 await check('synthetic-stored-method-checkout-once',async()=>{const page=await snapshot();const input={...identity,operation_id:randomUUID(),action:'click',...ref(page,'Confirm synthetic purchase')};const first=await success('browser_vault_action',input);await observe('Synthetic purchase confirmed');assert.deepEqual(await success('browser_vault_action',input),first);assert.equal((await evidence()).checkoutPosts,1);return {first,evidence:await evidence()};});
 await check('public-browser-isolation',async()=>{
  const result=await success('browser_execute',{code:`
   await codemode.describe("cdp");
   const before=await cdp.send({method:"Target.getTargets"});
   const privateTargetVisible=before.targetInfos.some(target=>target.targetId===${JSON.stringify(identity.target_id)});
   const created=await cdp.send({method:"Target.createTarget",params:{url:"about:blank"}});
   const attached=await cdp.attachToTarget({targetId:created.targetId});
   const sessionId=typeof attached==="string"?attached:attached.sessionId;
   await cdp.send({method:"Page.navigate",params:{url:${JSON.stringify(fixture('/public'))}},sessionId});
   let anonymous=false;for(let attempt=0;attempt<25;attempt++){
    const doc=await cdp.send({method:"DOM.getDocument",sessionId});
    const content=await cdp.send({method:"DOM.getOuterHTML",params:{nodeId:doc.root.nodeId},sessionId});
    if(content.outerHTML.includes("PUBLIC ANONYMOUS")){anonymous=true;break;}
    await new Promise(resolve=>setTimeout(resolve,200));
   }
   const marker=await cdp.send({method:"Runtime.evaluate",params:{expression:'sessionStorage.getItem("synthetic-private-marker")',returnByValue:true},sessionId});
   return {privateTargetVisible,anonymous,privateMarkerAbsent:marker.result.value===null};
  `});
  assert.equal(result.status,'completed');assert.deepEqual(result.result,{privateTargetVisible:false,anonymous:true,privateMarkerAbsent:true});assert.equal((await evidence()).publicAuthenticated,0);await observe('Synthetic purchase confirmed');return result;
 });
 await check('cross-origin-and-identity-actions-rejected',async()=>{
  const page=await snapshot();assert.ok(!page.elements.some(el=>el.text==='Unapproved external link'));
  const foreign=await call('browser_vault_action',{...identity,operation_id:randomUUID(),action:'navigate',url:'https://example.com/'});assert.ok(foreign.status===400||foreign.result?.status==='outcome_unknown');
  const wrong=await call('browser_vault_snapshot',{...identity,vault_id:'synthetic-other-vault-123456'});assert.equal(wrong.status,400);
  await observe('Synthetic purchase confirmed');const counts=await evidence();assert.deepEqual(counts,{loginPosts:1,bookingPosts:1,profilePosts:1,checkoutPosts:1,publicAuthenticated:0,credentialGetLeaks:0,takeoverInputs:0});return {foreign,wrong,counts};
 });
 await check('same-origin-private-navigation',async()=>{const input={...identity,operation_id:randomUUID(),action:'navigate',url:fixture('/takeover')};const first=await success('browser_vault_action',input);assert.equal(first.status,'navigation_requested');const page=await observe('Private typing test');assert.deepEqual(await success('browser_vault_action',input),first);return {first,page};});
 }
 if(!process.argv.includes('--secure-input-only'))for(const beforeFinish of [false,true])await check('private-takeover-secret-blocked-after-reconstruction-'+(beforeFinish?'before-finish':'after-finish'),async()=>{
  const closed=await call(undefined,undefined,{control:'close'});assert.equal(closed.closed,true);
  const opened=await success('browser_vault_open',{vault_id,url:fixture('/takeover')});assert.equal(opened.status,'opened');identity={vault_id,target_id:opened.target_id,expected_origin:opened.expected_origin};
  await observe('Private typing test');
  const takeover=await success('browser_vault_request_takeover',identity);assert.equal(takeover.status,'input_required');
  const typed=await call(undefined,undefined,{control:'takeover',challenge_id:takeover.challenge_id,action:'type'});assert.equal(typed.takeoverStatus,'active');
  const before=await evidence();assert.ok(before.takeoverInputs>=(beforeFinish?2:1),'Typing must reach the merchant input listener');
  if(beforeFinish)assert.equal((await call(undefined,undefined,{control:'reconstruct'})).reconstructed,true);
  const finished=await call(undefined,undefined,{control:'takeover',challenge_id:takeover.challenge_id,action:'finish'});assert.equal(finished.takeoverStatus,'finished');
  if(!beforeFinish){const live=await snapshot();assert.ok(live.text.includes('[redacted]'));assert.equal((await call(undefined,undefined,{control:'reconstruct'})).reconstructed,true);}
  const blocked=await call('browser_vault_snapshot',identity);assert.equal(blocked.status,400);return {beforeFinish,typed,finished,blocked,merchant:before};
 });
 if(!process.argv.includes('--takeover-only'))await check('post-login-secure-input-submit-once-and-fail-closed-after-reconstruction',async()=>{
  assert.equal((await call(undefined,undefined,{control:'close'})).closed,true);
  const secureFixture=path=>new URL(`${path}?probe=${run}-secure`,origin).href;
  const counts=async()=>{const response=await fetch(secureFixture('/secure-evidence'),{cache:'no-store'});assert.equal(response.status,200);return response.json();};
  const opened=await success('browser_vault_open',{vault_id,url:secureFixture('/merchant')});assert.equal(opened.status,'opened');identity={vault_id,target_id:opened.target_id,expected_origin:opened.expected_origin};
  let status;for(let attempt=0;attempt<20;attempt++){status=await success('browser_vault_status',identity);if(status.status==='login_form')break;await new Promise(r=>setTimeout(r,200));}assert.equal(status.status,'login_form');
  const fill=await success('browser_vault_fill',{...identity,operation_id:randomUUID(),username_selector:'input[name=email]',password_selector:'input[name=password]',submit:true});assert.ok(['filled','submitted'].includes(fill.status));
  if(fill.submission==='action_required'){const page=await snapshot();await action({action:'click',...ref(page,'Sign in')});}
  await observe('Signed in synthetic account');assert.deepEqual(await counts(),{loginPosts:1,securePosts:0,credentialGetLeaks:0});
  assert.equal((await action({action:'navigate',url:secureFixture('/secure-form')})).status,'navigation_requested');
  await observe('Authenticated synthetic secure form');
  const request=await success('request_secure_input',{target_id:identity.target_id,expected_origin:identity.expected_origin,fields:[{id:'private_reference',kind:'sensitive_text',selector:'input[name=privateValue]',label:'Private reference'}],submit:false});assert.equal(request.status,'input_required');assert.equal(request.kind,'browser_form');
  const submitted=await call(undefined,undefined,{control:'secure-input',request_id:request.request_id});assert.equal(submitted.status,200);assert.equal(submitted.result.status,'filled');
  const secureSnapshot=()=>success('secure_input_snapshot',{request_id:request.request_id});
  const page=await secureSnapshot();assert.ok(page.text.includes('Private echo: [redacted] [redacted]'),'Both plain and encoded merchant echoes must be redacted');
  const beforeSubmit=await counts();assert.deepEqual(beforeSubmit,{loginPosts:1,securePosts:0,credentialGetLeaks:0});
  const input={request_id:request.request_id,operation_id:randomUUID(),action:'click',...ref(page,'Submit synthetic private reference')};
  const first=await success('secure_input_action',input);assert.equal(first.status,'action_requested');
  let confirmed;for(let attempt=0;attempt<20;attempt++){confirmed=await secureSnapshot();if(confirmed.text.includes('Synthetic private reference accepted'))break;await new Promise(r=>setTimeout(r,200));}assert.ok(confirmed.text.includes('Synthetic private reference accepted'));assert.ok(confirmed.text.includes('Private echo: [redacted] [redacted]'));
  const replay=await success('secure_input_action',input);assert.deepEqual(replay,first);
  const afterReplay=await counts();assert.deepEqual(afterReplay,{loginPosts:1,securePosts:1,credentialGetLeaks:0});
  assert.equal((await call(undefined,undefined,{control:'reconstruct'})).reconstructed,true);
  const blocked=await call('secure_input_snapshot',{request_id:request.request_id});assert.equal(blocked.status,400);assert.match(blocked.error,/close the browser and start again/);
  assert.deepEqual(await counts(),afterReplay);
  return {request,submitted:submitted.result,redactedPage:page,beforeSubmit,first,replay,confirmation:confirmed,afterReplay,reconstructedWithoutClose:true,blocked,hostSecretGuard:'Plain, URL-encoded, and base64 secret absent from every tool response'};
 });
}catch{/* Failure already recorded; always release actual remote sessions below. */}
finally{
 try{const close=await call(undefined,undefined,{control:'close'});assert.equal(close.closed,true);}catch(error){results.push({name:'cleanup',status:'fail',error:error.message});process.exitCode=1;}
 await writeFile(resolve(output,'summary.json'),JSON.stringify({run,transport:'HTTP → local Worker → managed runtime → remote Chromium',syntheticCredentials:true,realPayment:false,results},null,2)+'\n');
}
