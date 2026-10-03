// Public login-tool/private-client journey against real Chrome. Synthetic identities only.
// Browser allocation and DurableObject storage are local adapters; no Apple account is used.
import assert from 'node:assert/strict';
import https from 'node:https';
import {readFileSync,mkdtempSync,rmSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerHooks,createRequire} from 'node:module';
const require=createRequire(new URL('../../account/package.json',import.meta.url));const {build}=require('esbuild');
registerHooks({resolve(specifier,context,next){
 if(specifier==='agents/browser')return {url:'data:text/javascript,export const createBrowserSession=(b,o)=>b.create(o);export const deleteBrowserSession=(b,id)=>b.delete(id);',shortCircuit:true};
 if(specifier.startsWith('./') && /browser-(vault|login|private-operations)/.test(specifier) && !specifier.endsWith('.ts'))specifier+='.ts';
 return next(specifier,context);
}});
const {createBrowserLoginRuntime}=await import('../src/browser-login-runtime.ts');
const {default:WebSocket}=await import('ws');
const packages=new URL('../../../node_modules/.pnpm/',import.meta.url),entry=readdirSync(packages).find(n=>/^playwright-core@/.test(n));
const {chromium}=await import(new URL(`${entry}/node_modules/playwright-core/index.mjs`,packages));
const temp=mkdtempSync(join(tmpdir(),'login-journey-')),report={checks:[]};
let chrome,browser,runtime;const servers=[];let allocations=0,authenticated=false,context,topOrigin,authOrigin,unapprovedOrigin;
const password='synthetic-login-password-93817';
const store=new Map();const storage={get:async k=>structuredClone(store.get(k)),put:async(k,v)=>{store.set(k,structuredClone(v));},delete:async k=>store.delete(k),transaction:async f=>f(storage)};
try {
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temp,'key'),'-out',join(temp,'cert'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
 const serve=async handler=>{const s=https.createServer({key:readFileSync(join(temp,'key')),cert:readFileSync(join(temp,'cert'))},handler);servers.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r));return `https://127.0.0.1:${s.address().port}`;};
 unapprovedOrigin=await serve((_q,r)=>r.end('<h1>Unapproved destination</h1><input type=password>'));
 topOrigin=await serve((q,r)=>{r.setHeader('Content-Type','text/html');if(q.url==='/account')r.end(`<h1>${authenticated?'Signed in to fixture account':'Not signed in'}</h1><p>${authenticated?password:''}</p><button onclick="document.querySelector('h1').textContent='Account action confirmed'">Continue</button>`);else r.end(`<meta name=viewport content="width=device-width,initial-scale=1"><h1>Login fixture</h1><iframe style="width:350px;height:350px" src="${authOrigin}/"></iframe>`);});
 authOrigin=await serve((q,r)=>{r.setHeader('Content-Type','text/html');if(q.method==='POST'){let text='';q.on('data',c=>text+=c);q.on('end',()=>{authenticated=new URLSearchParams(text).get('password')===password;r.end(`<script>top.location.href=${JSON.stringify(topOrigin+'/account')}</script>`);});}else r.end('<form method=post><label>Password <input name=password type=password></label><button>Sign in</button></form>');});
 chrome=spawn(process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${join(temp,'profile')}`,'about:blank'],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{readFileSync(join(temp,'profile','DevToolsActivePort'));break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const [port,endpoint]=readFileSync(join(temp,'profile','DevToolsActivePort'),'utf8').trim().split('\n');
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);context=browser.contexts()[0];
 const control=await browser.newBrowserCDPSession();await control.send('Security.setIgnoreCertificateErrors',{ignore:true});
 const binding={create:async()=>{allocations++;return {sessionId:'fixture-private-session'};},delete:async()=>{},fetch:async()=>{const socket=new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});socket.accept=()=>{};return {webSocket:socket};}};
 const options={storage,browser:binding,agentId:'fixture-agent',publicOrigin:'https://nanocodex.example',authorize:ctx=>{if(ctx.sessionId!=='owner')throw Error('forbidden');}};
 runtime=createBrowserLoginRuntime(options);
 const ctx={sessionId:'owner',callId:'fixture',signal:new AbortController().signal};
 const tool=(name,input,c=ctx)=>runtime.tools.find(t=>t.name===name).handler(input,c);
 const op=crypto.randomUUID(),args={operation_id:op,url:topOrigin+'/',allowed_origins:[topOrigin,authOrigin]};
 const request=await tool('request_browser_login',args);assert.equal(request.type,'browser_login');assert.ok(request.login_url.startsWith('https://nanocodex.example/browser-login?'));
 assert.deepEqual(await tool('request_browser_login',args),request);assert.equal(allocations,1);
 await assert.rejects(tool('request_browser_login',{...args,url:topOrigin+'/other'}));
 await assert.rejects(tool('browser_login_snapshot',{request_id:op},{...ctx,sessionId:'other'}));
 const human=action=>runtime.submit({challenge_id:op,...action},ctx.signal);
 assert.deepEqual(await human({action:'describe'}),request);
 await assert.rejects(human({action:'observe'}));await assert.rejects(tool('browser_login_snapshot',{request_id:op}));
 assert.deepEqual(await human({action:'approve'}),{status:'approved'});
 let page;for(let i=0;i<100;i++){page=context.pages().find(p=>p.url().startsWith(topOrigin));if(page)break;await new Promise(r=>setTimeout(r,50));}
 await page.frameLocator('iframe').locator('input').waitFor();
 let frame=await human({action:'observe',viewport:{width:390,height:740,mobile:true}});assert.equal(frame.status,'active');
 const box=await page.frameLocator('iframe').locator('input').boundingBox();
 await human({action:'click',x:(box.x+box.width/2)/frame.width,y:(box.y+box.height/2)/frame.height});
 await human({action:'type',text:password});
 assert.equal(await page.frameLocator('iframe').locator('input').inputValue(),password,'private input reached iframe');
 const submitBox=await page.frameLocator('iframe').locator('button').boundingBox();
 await human({action:'click',x:(submitBox.x+submitBox.width/2)/frame.width,y:(submitBox.y+submitBox.height/2)/frame.height}).catch(()=>{}); // redirect can make the response uncertain; never repeat the submit
 await page.waitForURL(topOrigin+'/account');assert.equal(authenticated,true);
 await human({action:'observe'});
 assert.deepEqual(await human({action:'finish'}),{type:'browser_login_receipt',status:'finished',request_id:op});
 assert.deepEqual(await human({action:'finish'}),{type:'browser_login_receipt',status:'finished',request_id:op});
 const snapshot=await tool('browser_login_snapshot',{request_id:op});assert.ok(JSON.stringify(snapshot).includes('Signed in to fixture account'));assert.ok(!JSON.stringify(snapshot).includes(password));
 const button=snapshot.elements.find(e=>e.text==='Continue');assert.ok(button);
 const actionArgs={request_id:op,operation_id:crypto.randomUUID(),action:'click',snapshot_id:snapshot.snapshot_id,ref:button.ref};
 const acted=await tool('browser_login_action',actionArgs);assert.equal(acted.status,'action_requested');assert.deepEqual(await tool('browser_login_action',actionArgs),acted);
 assert.ok(JSON.stringify(await tool('browser_login_snapshot',{request_id:op})).includes('Account action confirmed'));
 report.checks.push('finished receipt replay and approved agent continuation');
 const metadata=JSON.stringify([...store]);assert.ok(!metadata.includes(password));assert.ok(!metadata.includes('data:image'));assert.ok(!metadata.includes('ws://'));
 report.checks.push('iframe private password and native submit redirect','explicit site review required','owner tool admission','stable request replay allocates once','model blocked during human control','finished snapshot verifies account and redacts password','durable metadata excludes input/screenshots/provider URLs');
 const old=runtime;runtime=createBrowserLoginRuntime(options);await assert.rejects(tool('browser_login_snapshot',{request_id:op}));await assert.rejects(human({action:'approve'}));
 assert.equal((await human({action:'cancel'})).status,'cancelled');await old.close();report.checks.push('runtime loss fails closed; cancellation discards session');
 const oldPages=new Set(context.pages()); const op2=crypto.randomUUID();const req2=await tool('request_browser_login',{...args,operation_id:op2});await runtime.submit({challenge_id:op2,action:'approve'},ctx.signal);
 let page2;for(let i=0;i<100;i++){page2=context.pages().find(p=>!oldPages.has(p));if(page2)break;await new Promise(r=>setTimeout(r,50));}await page2.waitForURL(topOrigin+'/');await page2.goto(unapprovedOrigin);
 await assert.rejects(runtime.submit({challenge_id:op2,action:'observe'},ctx.signal));await assert.rejects(runtime.submit({challenge_id:op2,action:'type',text:'must-not-enter'},ctx.signal));
 assert.equal(await page2.locator('input').inputValue(),'');await runtime.submit({challenge_id:op2,action:'cancel'},ctx.signal);report.checks.push('unapproved origin blocks pixels and input');
 // Real phone-sized React client -> private HTTP -> same runtime -> real browser.
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {AccountSessionProvider} from './src/AccountSession';import {BrowserLoginPage} from './src/BrowserLoginPage';createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><AccountSessionProvider><BrowserLoginPage url={new URL(location.href)}/></AccountSessionProvider></QueryClientProvider>);`,resolveDir:new URL('../../account/',import.meta.url).pathname,loader:'tsx'},bundle:true,write:false,outfile:'app.js',jsx:'automatic'});
 let delivered,privateActions=[];const op3=crypto.randomUUID(),priorPages=new Set(context.pages());
 await tool('request_browser_login',{...args,operation_id:op3});
 let loginPage;for(let i=0;i<100;i++){loginPage=context.pages().find(p=>!priorPages.has(p));if(loginPage)break;await new Promise(r=>setTimeout(r,50));}
 await loginPage.frameLocator('iframe').locator('input').waitFor();
 const uiOrigin=await serve((q,r)=>{
  if(q.url==='/v1/me'){r.setHeader('Content-Type','application/json');r.end(JSON.stringify({user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',persistent:true}}));return;}
  if(q.url?.startsWith('/v1/agents/')){let body='';q.on('data',c=>body+=c);q.on('end',async()=>{try{const input=JSON.parse(body);r.setHeader('Content-Type','application/json');if(q.url.endsWith('/turns')){delivered=input;r.end('{}');return;}privateActions.push(input.action);r.end(JSON.stringify(await runtime.submit(input,ctx.signal)));}catch{r.statusCode=409;r.end('{}');}});return;}
  r.setHeader('Content-Type','text/html');r.end(`<meta name=viewport content="width=device-width,initial-scale=1"><div id=root></div><style>${bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text??''}</style><script>${bundle.outputFiles.find(f=>f.path.endsWith('.js')).text}</script>`);
 });
 const uiContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:740},isMobile:true,hasTouch:true});const ui=await uiContext.newPage(),pageErrors=[];ui.on('pageerror',e=>pageErrors.push(e.message));
 await ui.goto(uiOrigin+`/browser-login?agent=fixture-agent&request=${op3}`);
 await ui.getByRole('button',{name:'Continue to private login'}).waitFor();assert.deepEqual(privateActions,['describe']);
 await ui.getByRole('button',{name:'Continue to private login'}).click();await ui.getByAltText('Private browser screen').waitFor();
 const clickRemote=async locator=>{const b=await locator.boundingBox(),screen=await ui.locator('.private-browser-screen').boundingBox(),view=await loginPage.evaluate(()=>({w:innerWidth,h:innerHeight}));await ui.locator('.private-browser-screen').click({position:{x:(b.x+b.width/2)/view.w*screen.width,y:(b.y+b.height/2)/view.h*screen.height}});};
 await clickRemote(loginPage.frameLocator('iframe').locator('input'));await ui.getByRole('button',{name:'Show keyboard'}).click();await ui.keyboard.insertText(password);
 await loginPage.frameLocator('iframe').locator('input').evaluate((el,expected)=>new Promise(resolve=>{if(el.value===expected)return resolve(true);const timeout=setTimeout(()=>{clearInterval(i);resolve(false);},5000);const i=setInterval(()=>{if(el.value===expected){clearInterval(i);clearTimeout(timeout);resolve(true);}},50);}),password);
 await ui.waitForFunction(()=>!document.querySelector('button[aria-label="Show keyboard"]').nextElementSibling.disabled);
 await clickRemote(loginPage.frameLocator('iframe').locator('button'));await loginPage.waitForURL(topOrigin+'/account');
 await ui.getByRole('button',{name:'Done',exact:true}).click();await ui.getByText('The agent is checking your sign-in and continuing the task.').waitFor();
 assert.deepEqual(JSON.parse(delivered.input),{type:'browser_login_receipt',status:'finished',request_id:op3});assert.equal(delivered.id,`browser-login-${op3}-finished`);assert.ok(!JSON.stringify(delivered).includes(password));assert.deepEqual(pageErrors,[]);
 assert.ok(JSON.stringify(await tool('browser_login_snapshot',{request_id:op3})).includes('Signed in to fixture account'));report.checks.push('phone web page authenticates account and loads server-bound request','React review before any private observation','phone viewport types into remote iframe and submits','Done sends bounded receipt once to original conversation and preserves private session');await tool('browser_login_close',{});
 const op4=crypto.randomUUID();await tool('request_browser_login',{...args,operation_id:op4});privateActions=[];delivered=undefined;
 await ui.goto(uiOrigin+`/browser-login?agent=fixture-agent&request=${op4}`);await ui.getByRole('button',{name:'Cancel',exact:true}).click();await ui.getByText('Sign-in cancelled. The agent has been notified.').waitFor();
 assert.deepEqual(privateActions,['describe','cancel']);assert.deepEqual(JSON.parse(delivered.input),{type:'browser_login_receipt',status:'cancelled',request_id:op4});
 assert.deepEqual(await runtime.submit({challenge_id:op4,action:'cancel'},ctx.signal),JSON.parse(delivered.input));
 assert.equal(await storage.get('browser-login:fixture-agent'),undefined);report.checks.push('phone cancellation before login sends safe replayable receipt and removes session');await uiContext.close();
 const dir=new URL('../../../output/phone-browser-login/',import.meta.url);mkdirSync(dir,{recursive:true});writeFileSync(new URL('chrome-journey.json',dir),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {await runtime?.close();await browser?.close();if(chrome&&chrome.exitCode===null){const ended=new Promise(r=>chrome.once('exit',r));chrome.kill();await ended;}for(const s of servers)await new Promise(r=>s.close(r));rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
