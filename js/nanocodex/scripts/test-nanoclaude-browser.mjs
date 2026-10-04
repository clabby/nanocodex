// Optional actual Chromium page + module Worker acceptance. Needs installed Playwright
// (NANOCLAUDE_PLAYWRIGHT_MODULE may name an existing module; no automatic install).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const { chromium } = await import(process.env.NANOCLAUDE_PLAYWRIGHT_MODULE ?? "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const source = `import { create } from ${JSON.stringify(`${root}browser/Claude.mjs`)};
import { createMemoryDurabilityStore } from ${JSON.stringify(`${root}runtime/durability-store.mjs`)};
async function acceptance() {
  const module = await (await fetch('/nanocodex_bg.wasm')).arrayBuffer();
  const store = createMemoryDurabilityStore('chromium-claude');
  let authCalls = 0; let effects = 0;
  const options = {module,model:'fixture-model',endpoint:location.origin+'/v1/messages',cache:'5m',contextWindowTokens:100000,autoCompactWindowTokens:100000,durability:store,durabilityId:'chromium-claude',
    auth:{headers:()=>{authCalls++;return {'x-api-key':'synthetic-browser-only'}}},
    tools:[{name:'effect',description:'Synthetic browser effect',handler:()=>{effects++;return {content:[{type:'text',text:'BROWSER_EFFECT_RECEIPT'}]}}}]};
  let agent = await create(options);
  const first = await agent.turn.prompt({input:'perform effect once',id:'stable-request'}).result();
  const usage = await first.usage();
  await agent.session.shutdown();
  const beforeAuth = authCalls;
  agent = await create({...options,auth:{headers:()=>{authCalls++;throw Error('must not authenticate terminal replay')}}});
  const replay = await agent.turn.prompt({input:'perform effect once',id:'stable-request'}).result();
  await agent.session.shutdown();
  return {first:first.finalMessage,replay:replay.finalMessage,usage,authCalls,beforeAuth,effects,wasm:true};
}
if (typeof document === 'undefined') onmessage=async()=>{try{postMessage({result:await acceptance()})}catch(error){postMessage({error:String(error),stack:error.stack})}};
else globalThis.runNanoclaudeAcceptance=acceptance;`;
const bundle = await build({ stdin: { contents: source, resolveDir: root, sourcefile: "nanoclaude-browser-acceptance.mjs" }, bundle: true, platform: "browser", format: "esm", write: false });
const wasm = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
const firstBlocks = [
  {type:'thinking',thinking:'synthetic effect',signature:'signed-browser/+==',opaque:{retain:true}},
  {type:'redacted_thinking',data:'redacted-browser/+==',opaque:'retain'},
  {type:'server_tool_use',id:'browser-search',name:'web_search',input:{query:'synthetic'},native:'server-call'},
  {type:'web_search_tool_result',tool_use_id:'browser-search',content:[{type:'web_search_result',url:'https://example.invalid',encrypted_content:'opaque-result'}],native:'server-receipt'},
  {type:'tool_use',id:'browser-effect',name:'effect',input:{}}
];
const requests = [];
const server = createServer(async (request, response) => {
  if (request.url === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><script type="module" src="/acceptance.mjs"></script>'); return; }
  if (request.url === "/acceptance.mjs") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(bundle.outputFiles[0].text); return; }
  if (request.url === "/nanocodex_bg.wasm") { response.writeHead(200, { "content-type": "application/wasm" }); response.end(wasm); return; }
  if (request.url !== "/v1/messages") { response.writeHead(404); response.end(); return; }
  const chunks=[];for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  const phase = (requests.length - 1) % 3;
  const blocks = phase === 0 ? firstBlocks : [{type:'text',text:phase === 1?'Preserve the browser fixture original task.':'CHROMIUM_WASM_OK'}];
  const frames = [{type:'message_start',message:{id:'synthetic-browser-response',role:'assistant',model:'fixture-model',content:[],usage:{input_tokens:phase===0?70000:12,output_tokens:0}}}];
  blocks.forEach((content_block,index)=>frames.push({type:'content_block_start',index,content_block},{type:'content_block_stop',index}));
  frames.push({type:'message_delta',delta:{stop_reason:phase===0?'tool_use':'end_turn'},usage:{output_tokens:5}},{type:'message_stop'});
  response.writeHead(200, {'content-type':'text/event-stream'});
  response.end(frames.map(frame=>`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await chromium.launch({headless:true, ...(process.env.NANOCLAUDE_CHROMIUM_EXECUTABLE ? {executablePath:process.env.NANOCLAUDE_CHROMIUM_EXECUTABLE} : {})});
  const page = await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>typeof globalThis.runNanoclaudeAcceptance==='function');
  const pageResult=await page.evaluate(()=>globalThis.runNanoclaudeAcceptance());
  const workerResult=await page.evaluate(()=>new Promise((resolve,reject)=>{const worker=new Worker('/acceptance.mjs',{type:'module'});worker.onmessage=e=>{worker.terminate();e.data.error?reject(Error(e.data.error)):resolve(e.data.result)};worker.onerror=e=>{worker.terminate();reject(Error(e.message))};worker.postMessage({run:true});setTimeout(()=>{worker.terminate();reject(Error('module Worker acceptance timed out'))},15000)}));
  for(const result of [pageResult,workerResult]) {
    assert.equal(result.first,'CHROMIUM_WASM_OK');assert.equal(result.replay,result.first);
    assert.equal(result.effects,1);assert.equal(result.authCalls,result.beforeAuth);assert.equal(result.wasm,true);
  }
  assert.equal(requests.length,6,'page+Worker each issue tool, automatic compaction, and final Messages requests; replay zero');
  for(const index of [0,3]) {
    assert.deepEqual(requests[index].cache_control,{type:'ephemeral'});
    assert.deepEqual(requests[index].tools.map(tool=>tool.name),['effect']);
  }
  for(const index of [2,5]) {
    assert.deepEqual(requests[index].messages[1].content,
      firstBlocks.filter(block=>block.type!=='thinking'&&block.type!=='redacted_thinking'),
      'summary replacement removes prefix-bound thinking and preserves every other block exactly');
    assert.equal(requests[index].messages.at(-1).content[0].content[0].text,'BROWSER_EFFECT_RECEIPT');
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({browser:await browser.version(),actualPage:pageResult,actualModuleWorker:workerResult,messagesRequests:requests.length,terminalReplayRequests:0},null,2));
} finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
