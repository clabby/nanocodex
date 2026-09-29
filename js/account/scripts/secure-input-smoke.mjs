// Synthetic browser journey: secret submission never uses the transcript callback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../managed/package.json', import.meta.url));
const { build } = require('esbuild');
const packages = new URL('../../../node_modules/.pnpm/', import.meta.url);
const entry = readdirSync(packages).find(name => /^playwright-core@/.test(name));
const { chromium } = await import(new URL(`${entry}/node_modules/playwright-core/index.mjs`, packages));
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SecureInputForm} from './src/SecureInputCard'; const root=createRoot(document.getElementById('root')); window.unmount=()=>root.unmount(); root.render(<SecureInputForm authenticated request={{type:'secure_input',status:'input_required',request_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',agent_id:'agent',origin:'https://example.test',expires_at:window.expiry,kind:location.search.includes('typed')?'browser_form':'browser_password'}} onReceipt={r=>window.receipts.push(r)} />);`, resolveDir: new URL('..', import.meta.url).pathname, loader:'tsx' },bundle:true,write:false,outfile:'app.js',jsx:'automatic'});
const server = createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<div id="root"></div><script>window.receipts=[];window.expiry=Date.now()+300000</script><script>${bundle.outputFiles.find(f=>f.path.endsWith('.js')).text}</script>`)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const output=new URL('../../../output/secure-input/',import.meta.url);mkdirSync(output,{recursive:true});
let browser; const results=[];
try {
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 for (const mode of ['success','action-required','lost-response','close','background','unmount','typed-success','typed-lost-response','typed-close','typed-background','typed-escape','typed-expiry','typed-unmount']) {
  const page=await browser.newPage({viewport:{width:390,height:740}});const typed=mode.startsWith('typed-');const scenario=mode.replace('typed-','');const posts=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/v1/agents/agent/secure-input',async route=>{if(route.request().postDataJSON().action==='describe') return route.fulfill({json:{request_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origin:'https://example.test',expires_at:await page.evaluate(()=>window.expiry),fields:[{id:'private',kind:'sensitive_text',selector:'#private'},{id:'card',kind:'card_number',selector:'#card'},{id:'expiry',kind:'card_expiry',selector:'#expiry'},{id:'cvc',kind:'card_cvc',selector:'#cvc'},{id:'password',kind:'password',selector:'#password'}]}});posts.push(route.request().postDataJSON());if(scenario==='lost-response')return route.abort();return route.fulfill({json:{type:'secure_input_receipt',request_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:route.request().postDataJSON().action==='cancel'?'cancelled':mode==='action-required'?'action_required':'filled'}})});
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.address().port}/${typed?'?typed':''}`);
  await page.getByRole('button',{name:typed?'Enter secure details':'Enter password',exact:true}).click();
  const field=page.getByLabel('Password',{exact:true});assert.equal(await field.getAttribute('autocomplete'),'current-password');assert.equal(await field.getAttribute('type'),'password');
  await field.fill('synthetic-secret');
  if(typed) for (const label of ['Private text','Card number','Expiry','Security code']) { const typedField=page.getByLabel(label,{exact:true}); assert.equal(await typedField.getAttribute('type'),'password'); await typedField.fill('synthetic-secret'); }
  assert.equal(await page.getByRole('dialog').count(),1);
  if(scenario==='success'||scenario==='action-required'||scenario==='lost-response') {
   await page.getByRole('button',{name:typed?'Fill once':'Submit once'}).click();
   await page.getByRole('status').filter({hasText:scenario==='success'?'Input delivered.':mode==='action-required'?'A separate sign-in action':'could not be confirmed'}).waitFor();
   assert.equal(posts.length,1);assert.deepEqual(posts[0],{request_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',...(typed?{values:{private:'synthetic-secret',card:'synthetic-secret',expiry:'synthetic-secret',cvc:'synthetic-secret',password:'synthetic-secret'}}:{value:'synthetic-secret'})});
   assert.equal(await page.getByRole('button',{name:typed?'Enter secure details':'Enter password',exact:true}).isDisabled(),true);
  } else if(scenario==='close'||scenario==='escape') { if(scenario==='escape') await page.keyboard.press('Escape'); else await page.getByRole('button',{name:'Cancel request',exact:true}).click(); await page.getByRole('status').filter({hasText:'Request cancelled.'}).waitFor(); assert.deepEqual(posts,[{request_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',action:'cancel'}]); }
  else if(scenario==='background') await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  else if(scenario==='expiry') await page.clock.fastForward(300001);
  else await page.evaluate(()=>window.unmount());
  await field.waitFor({state:'detached'});assert.equal(await field.count(),0,mode);const receipts=await page.evaluate(()=>window.receipts);assert.equal(JSON.stringify(receipts).includes('synthetic-secret'),false);assert.equal(receipts.length,['success','action-required','close','escape'].includes(scenario)?1:0);assert.deepEqual(errors,[]);
  if(mode==='success') await page.screenshot({path:new URL('web-success.png',output).pathname});
  results.push({mode,posts:posts.length,receipts:receipts.length,passed:true});await page.close();
 }
 writeFileSync(new URL('web-journey.json',output),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
