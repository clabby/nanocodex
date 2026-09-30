#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const endpoint=process.env.PRIVATE_CHECKOUT_SMOKE_URL ?? 'http://127.0.0.1:8798/inspect';
const output=resolve(process.env.PRIVATE_CHECKOUT_SMOKE_OUTPUT ?? 'output/private-checkout/journey');
await mkdir(output,{recursive:true});
const cases=[
  ['login',{path:'/normal'},'inspected',1],
  ['secret-echo',{path:'/echo'},'inspected',1],
  ['verification-challenge',{path:'/challenge'},'challenge',1],
  ['native-get-fallback',{path:'/get'},['login_required','outcome_unknown'],1],
  ['direct-native-get',{path:'/direct-get'},['login_required','outcome_unknown'],1],
  ['runtime-close-before-fill',{path:'/normal',closeAfterVault:true},'unavailable',1],
  ['cross-origin-redirect',{path:'/redirect'},'unavailable',0],
  ['vault-origin-rejected',{path:'/normal',wrongOrigin:true},'unavailable',1],
  ['caller-denied',{path:'/normal',deny:true},'denied',0],
  ['fresh-login-again',{path:'/normal'},'inspected',1],
];
const results=[];
for(const [name,input,status,reads] of cases){
  try {
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(95000)});
  const body=await response.json();
  const serialized=JSON.stringify(body);
  for(const secret of ['fixture-user@example.test','fixture-password-synthetic-42',Buffer.from('fixture-password-synthetic-42').toString('base64')])assert.ok(!serialized.includes(secret),`${name}: private input escaped into result`);
  await writeFile(resolve(output,`${name}.json`),JSON.stringify({httpStatus:response.status,...body},null,2)+'\n');
  assert.equal(body.vaultReads,reads,`${name}: origin/authority must gate Vault resolution`);
  if(status==='denied'){assert.equal(response.status,400);assert.equal(body.error,'Private inspection rejected');}
  else{
    assert.equal(response.status,200,name);
    assert.ok((Array.isArray(status)?status:[status]).includes(body.result.status),`${name}: unexpected status ${body.result.status}`);
    assert.equal(body.evidence.credentialGetLeaks,0,`${name}: credential-bearing GET reached fixture server`);
    assert.equal(body.evidence.directGetAttempts,name==='direct-native-get'?1:0,`${name}: asynchronous native-submit handler coverage`);
    if(input.closeAfterVault){
      assert.equal(body.runtimeClosed,true,`${name}: runtime close must finish`);
      assert.equal(body.result.login_attempted,false,`${name}: runtime close must prevent credential fill`);
    }
    if(Array.isArray(status)){
      assert.equal(body.result.login_attempted,true,`${name}: native form restriction must be exercised after filling`);
      if(body.result.status==='outcome_unknown'){
        assert.equal(body.result.failure_stage,'inspection',`${name}: blocked-navigation uncertainty must occur during inspection`);
        assert.equal(body.result.reason,'private_inspection_failed',`${name}: cleanup or unrelated failures must not pass`);
      }
    }
    if(status==='inspected')assert.equal(body.result.checkout.checkout_detected,true,name);
    if(status==='unavailable')assert.equal(body.result.login_attempted,false,name);
    assert.ok(!serialized.includes('sessionId')&&!serialized.includes('targetId')&&!serialized.includes('http'),`${name}: browser authority escaped into result`);
  }
  results.push({name,status:'pass',observed:body.result?.status??'denied',vaultReads:body.vaultReads,loginAttempted:body.result?.login_attempted,runtimeClosed:body.runtimeClosed,evidence:body.evidence});
  console.log(`PASS ${name}`);
  } catch(error) {
    const message=error instanceof Error?error.message:String(error);
    results.push({name,status:'fail',error:message});
    console.error(`FAIL ${name}: ${message}`);
    process.exitCode=1;
  }
}
await writeFile(resolve(output,'summary.json'),JSON.stringify({transport:'actual Worker HTTP + createManagedBrowserRuntime + upstream CDP + remote BROWSER',credentials:'synthetic resolver; production Vault broker not exercised',realPayment:false,results},null,2)+'\n');
