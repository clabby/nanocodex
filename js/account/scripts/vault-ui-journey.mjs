// Real Chromium journey of the production Vault intake UI; account/Vault HTTP
// responses are synthetic fixtures. Credential values never enter the receipt.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url));
process.chdir(root);
await mkdir('output/vault-client',{recursive:true});
const require = createRequire(path.resolve('js/account/package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
await build({stdin:{contents:`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {AccountSessionProvider} from './src/AccountSession';
import {VaultIntakeCard} from './src/VaultIntakeCard';
const operation = new URLSearchParams(location.search).get('operation') ?? 'create';
const hint = {type:'vault_intake',status:'input_required',kind:'login',operation,...(operation==='create'?{name:'Example'}:{vault_id:'a'.repeat(22),origin:'https://example.com'}),...(operation==='browser_verification'?{challenge_id:'b'.repeat(22),agent_id:'agent_1'}:{})};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><AccountSessionProvider><VaultIntakeCard tool={{callId:'fixture',name:'request_vault_intake',status:'completed',output:JSON.stringify(hint)}} onReceipt={receipt=>{document.getElementById('receipt').textContent=receipt}}/></AccountSessionProvider></QueryClientProvider>);
`,resolveDir:path.resolve('js/account'),sourcefile:'vault-journey.tsx',loader:'tsx'},bundle:true,format:'esm',jsx:'automatic',outfile:'output/vault-client/journey.js'});
const requests=[];
const authenticated=true;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/v1/me'){res.setHeader('content-type','application/json');res.end(authenticated?JSON.stringify({user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',persistent:true}}):JSON.stringify({user:null}));return;}
 if(url.pathname.startsWith('/v1/credentials')){
  let body='';for await(const chunk of req)body+=chunk;
  requests.push({path:url.pathname,method:req.method,body:body?JSON.parse(body):undefined});
  res.setHeader('content-type','application/json');
  const values=body?JSON.parse(body):{};
  res.end(JSON.stringify({id:'a'.repeat(22),kind:'login',name:values.name,created_at:1,...(values.browser_origin?{browser_origin:values.browser_origin}:{})}));return;
 }
 if(url.pathname==='/journey.js'||url.pathname==='/journey.css'){res.setHeader('content-type',url.pathname.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile('output/vault-client'+url.pathname));return;}
 res.setHeader('content-type','text/html');res.end('<html><head><link rel="stylesheet" href="/journey.css"></head><body><div id="root"></div><pre id="receipt"></pre><script type="module" src="/journey.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||chromium.executablePath(),headless:true,args:['--no-sandbox']});
const page=await browser.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try{
 await page.goto(origin+'/?operation=authorize_origin');
 await page.waitForLoadState('networkidle');
 assert.equal(await page.locator('.vault-intake-card').count(),0);
 assert.equal(requests.length,0);
 console.log('PASS legacy approval tool result: no card, no credential reads or writes');
 for(const website of ['', 'https://example.com']){
  await page.goto(origin);
  await page.getByRole('button',{name:'Open secure form'}).click();
  const websiteField=page.getByLabel('Website (optional)');
  assert.equal(await websiteField.getAttribute('required'),null);
  await page.getByLabel('Username',{exact:true}).fill('synthetic-user');
  await page.getByLabel('Password',{exact:true}).fill('synthetic-password');
  if(website)await websiteField.fill(website);
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Saved to Vault',{exact:true}).waitFor();
  const receipt=JSON.parse(await page.locator('#receipt').textContent());
  assert.equal(receipt.status,'saved');
  assert.equal(receipt.operation,'create');
  assert.equal(receipt.browser_origin,website||undefined);
  assert.equal(JSON.stringify(receipt).includes('synthetic-password'),false);
  const request=requests.at(-1);
  assert.equal(request.method,'POST');assert.equal(request.path,'/v1/credentials/vault/login');
  assert.equal(request.body.password,'synthetic-password');
  assert.equal(request.body.browser_origin,website||undefined);
  console.log(`PASS create ${website?'with':'without'} website hint: one direct POST, saved receipt, secret excluded`);
 }
 assert.equal(requests.length,2);
 await page.goto(origin+'/?operation=browser_verification');
 await page.getByRole('button',{name:'Enter verification code securely'}).click();
 await page.getByLabel('Verification code').waitFor();
 console.log('PASS verification request still opens secure code form');
 await page.screenshot({path:'output/vault-client/verification.png'});
 assert.deepEqual(errors,[]);
 await writeFile('output/vault-client/requests.json',JSON.stringify(requests.map(({method,path,body})=>({method,path,fields:Object.keys(body)})),null,2));
 console.log('PASS no browser runtime errors; exactly two create writes, no approval writes');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
