#!/usr/bin/env node
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const endpoint=process.env.PRIVATE_WAITLIST_SMOKE_URL ?? 'http://127.0.0.1:8798/waitlist';
const output=resolve(process.env.PRIVATE_WAITLIST_SMOKE_OUTPUT ?? 'output/waitlist/journey');
await mkdir(output,{recursive:true});
const expected={title:'Synthetic Reformer',date:'September 30, 2026',time:'6:00 PM UTC',instructor:'Taylor Fixture'};
const make=(path='pure',extra={})=>({probe:randomUUID(),path,tool:{vault_id:'synthetic-'+randomUUID(),operation:'join',operation_id:randomUUID(),expected,authorize_join:true},...extra});
const results=[];
const secrets=['fixture-user@example.test','fixture-password-synthetic-42'].flatMap(value=>[value,Buffer.from(value).toString('base64'),encodeURIComponent(value)]);
async function journey(name,input,check){
  try {
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(95000)});
    const body=await response.json();
    // Preserve complete fixed-capability results even on an assertion failure.
    await writeFile(resolve(output,name+'.json'),JSON.stringify({input,httpStatus:response.status,...body},null,2)+'\n');
    const serialized=JSON.stringify(body);
    for(const secret of secrets)assert.ok(!serialized.includes(secret),name+': private input escaped');
    assert.ok(!/sessionId|targetId|wss?:\/\/|https?:\/\//.test(serialized),name+': browser authority escaped');
    assert.equal(body.evidence.credentialGetLeaks,0,name+': credential GET leak');
    await check(body,response);
    results.push({name,status:'pass',observed:body.result?.status??'denied',vaultReads:body.vaultReads,totalVaultReads:body.totalVaultReads,evidence:body.evidence});
    console.log('PASS '+name);
    return body;
  }catch(error){
    const message=error instanceof Error?error.stack:String(error);
    results.push({name,status:'fail',error:message});
    await writeFile(resolve(output,name+'.failure.txt'),message+'\n');
    console.error('FAIL '+name+': '+message);
    process.exitCode=1;
  }
}
const check=(status,joins,reads=1)=>async(body,response)=>{
  assert.equal(response.status,200);
  assert.equal(body.result.status,status);
  assert.equal(body.evidence.joinPosts,joins);
  assert.equal(body.vaultReads,reads);
  if(status==='joined'){
    assert.equal(body.result.join_attempted,true);
    assert.equal(body.result.capabilities.confirmation_present,true);
    assert.equal(body.evidence.verifyPosts,body.totalVaultReads);
  }
  if(['payment_required','policy_required','class_mismatch','ready','unavailable'].includes(status))assert.equal(body.result.join_attempted,false);
};
if(process.argv.includes('--replay')){
  const seed=JSON.parse(await readFile(resolve(output,'restart-seed.json'),'utf8'));
  await journey('after-harness-restart-cached',seed.input,async(body,response)=>{
    await check('joined',1,0)(body,response);
    assert.deepEqual(body.result,seed.body.result);
    assert.deepEqual(body.evidence,seed.body.evidence);
    assert.equal(body.totalVaultReads,seed.body.totalVaultReads);
  });
}else{
  const pure=make();
  const joined=await journey('pure-join-without-total',pure,check('joined',1));
  if(joined)await writeFile(resolve(output,'restart-seed.json'),JSON.stringify({input:pure,body:joined},null,2)+'\n');
  await journey('same-operation-cached-new-http-runtime',pure,async(body,response)=>{
    await check('joined',1,0)(body,response);
    assert.ok(joined,'initial join must succeed');
    assert.deepEqual(body.result,joined.result);
    assert.deepEqual(body.evidence,joined.evidence,'retry must not navigate or submit');
    assert.equal(body.totalVaultReads,1);
  });
  await journey('new-operation-same-class-fenced',{...pure,tool:{...pure.tool,operation_id:randomUUID()}},async(body,response)=>{
    await check('conflict',1,0)(body,response);
    assert.deepEqual(body.evidence,joined?.evidence);
    assert.equal(body.totalVaultReads,1);
  });
  await journey('different-input-same-operation-rejected',{...pure,tool:{...pure.tool,expected:{...expected,time:'7:00 PM UTC'}}},async(body,response)=>{
    await check('conflict',1,0)(body,response);
    assert.equal(body.result.reason,'operation_mismatch');
    assert.deepEqual(body.evidence,joined?.evidence);
  });
  await journey('query-change-cannot-bypass-fence',{...pure,queryVariant:'different',tool:{...pure.tool,operation_id:randomUUID()}},check('conflict',1,0));
  const reconciled=await journey('inspect-after-confirmed-join',{...pure,tool:{...pure.tool,operation:'inspect',operation_id:randomUUID(),authorize_join:false}},check('already_waitlisted',1));
  if(joined && reconciled)await writeFile(resolve(output,'restart-seed.json'),JSON.stringify({input:pure,body:{...reconciled,result:joined.result}},null,2)+'\n');
  const inspect=make();
  inspect.tool={...inspect.tool,operation:'inspect',authorize_join:false};
  await journey('inspect-does-not-submit',inspect,async(body,response)=>{
    await check('ready',0)(body,response);
    assert.equal(body.result.capabilities.no_payment_action,true);
  });
  await journey('join-after-inspect-new-operation',{...inspect,tool:{...inspect.tool,operation:'join',operation_id:randomUUID(),authorize_join:true}},check('joined',1));
  await journey('class-header-outside-action-form',make('split-form'),check('joined',1));
  const header=make('header-confirmation');
  await journey('split-text-header-confirmation-with-purchase-form',header,check('joined',1));
  await journey('inspect-header-confirmation',{...header,tool:{...header.tool,operation:'inspect',operation_id:randomUUID(),authorize_join:false}},check('already_waitlisted',1));
  await journey('explicit-zero-total',make('zero'),check('joined',1));
  await journey('wrong-class',{...make(),tool:{...make().tool,expected:{...expected,title:'Different Reformer'}}},check('class_mismatch',0));
  await journey('wrong-time',{...make(),tool:{...make().tool,expected:{...expected,time:'7:00 PM UTC'}}},check('class_mismatch',0));
  await journey('paid-purchase-and-join-refused',make('paid'),check('payment_required',0));
  await journey('unchecked-policy-refused',make('policy'),check('policy_required',0));
  const lost=make('lost');
  const unknown=await journey('join-post-lost-visible-confirmation',lost,async(body,response)=>{
    await check('outcome_unknown',1)(body,response);
    assert.equal(body.result.join_attempted,true);
    assert.equal(body.result.capabilities.confirmation_present,false);
  });
  await journey('unknown-same-operation-no-retry',lost,async(body,response)=>{
    await check('outcome_unknown',1,0)(body,response);
    assert.deepEqual(body.result,unknown?.result);
    assert.deepEqual(body.evidence,unknown?.evidence);
    assert.equal(body.totalVaultReads,1);
  });
  await journey('unknown-new-operation-fenced',{...lost,tool:{...lost.tool,operation_id:randomUUID()}},async(body,response)=>{
    await check('conflict',1,0)(body,response);
    assert.deepEqual(body.evidence,unknown?.evidence);
  });
  await journey('inspect-reconciles-unknown-without-rejoining',{...lost,tool:{...lost.tool,operation:'inspect',operation_id:randomUUID(),authorize_join:false}},async(body,response)=>{
    await check('already_waitlisted',1)(body,response);
    assert.equal(body.result.confirmation_observed,true);
    assert.equal(body.result.join_attempted,false);
    assert.equal(body.totalVaultReads,2);
    assert.equal(body.evidence.verifyPosts,2);
  });
  await journey('fresh-document-native-submit-blocked',make('native'),async(body,response)=>{
    assert.equal(response.status,200);
    assert.equal(body.result.status,'outcome_unknown');
    assert.equal(body.result.join_attempted,true,'native form control must actually be activated');
    assert.equal(body.evidence.pageRequests,2,'full same-origin document navigation must occur');
    assert.equal(body.evidence.verifyPosts,1);
    assert.equal(body.evidence.nativePosts,0,'native POST must never reach merchant');
    assert.equal(body.evidence.joinPosts,0);
    assert.equal(body.vaultReads,1);
  });
  await journey('hidden-confirmation-not-success',make('hidden-confirmation'),check('outcome_unknown',1));
  await journey('hidden-class-identity-not-authority',make('hidden-identity'),check('class_mismatch',0));
  await journey('unrelated-class-section-not-authority',make('unrelated'),check('class_mismatch',0));
  await journey('selected-family-refused',make('family'),check('unsupported',0));
  await journey('myself-with-unchecked-guest',make('myself'),check('joined',1));
  await journey('secret-and-encoded-echo',make('echo'),check('joined',1));
  await journey('caller-denied',make('pure',{deny:true}),async(body,response)=>{
    assert.equal(response.status,400);
    assert.equal(body.error,'Private waitlist rejected');
    assert.equal(body.vaultReads,0);
    assert.equal(body.evidence.pageRequests,0);
    assert.equal(body.evidence.joinPosts,0);
  });
  const noAuthority=make();
  noAuthority.tool.authorize_join=false;
  await journey('join-authority-required',noAuthority,async(body,response)=>{
    await check('unavailable',0,0)(body,response);
    assert.equal(body.result.reason,'not_authorized');
    assert.equal(body.evidence.pageRequests,0);
  });
  await journey('vault-origin-denied',make('pure',{wrongOrigin:true}),async(body,response)=>{
    await check('unavailable',0)(body,response);
    assert.equal(body.result.login_attempted,false);
    assert.equal(body.evidence.fillEvents,0);
    assert.equal(body.evidence.verifyPosts,0);
  });
  await journey('cross-origin-redirect',make('redirect'),check('unavailable',0,0));
  await journey('runtime-cancel-before-fill',make('pure',{closeAfterVault:true}),async(body,response)=>{
    await check('unavailable',0)(body,response);
    assert.equal(body.runtimeClosed,true);
    assert.equal(body.result.login_attempted,false);
    assert.equal(body.evidence.fillEvents,0);
    assert.equal(body.evidence.verifyPosts,0);
  });
}
await writeFile(resolve(output,process.argv.includes('--replay')?'restart-summary.json':'summary.json'),JSON.stringify({transport:'Worker HTTP → createManagedBrowserRuntime → browser_private_waitlist → upstream CDP → remote BROWSER',credentials:'Only the Vault resolver uses fixed synthetic input; production Vault is not exercised',journal:'Durable ctx.storage reused across distinct runtime constructions and HTTP requests',realPayment:false,results},null,2)+'\n');
