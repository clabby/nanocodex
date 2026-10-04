import '../../scripts/prepare-whatsapp.mjs';
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { WebSocketServer } from 'ws';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=resolve(root,'../../output/whatsapp-runtime');
await mkdir(out,{recursive:true});
await build({entryPoints:[resolve(root,'test/whatsapp-runtime/worker.mjs')],outfile:resolve(out,'worker.js'),bundle:true,format:'esm',platform:'node',target:'es2022',external:[...builtinModules,...builtinModules.map(x=>'node:'+x)],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},()=>({path:'./bridge.wasm',external:true}));}}]});
await copyFile(resolve(root,'src/whatsapp-generated/bridge.wasm'),resolve(out,'bridge.wasm'));
const server=new WebSocketServer({port:0,host:'127.0.0.1'});
await new Promise(resolve=>server.once('listening',resolve));
server.on('connection',socket=>socket.on('message',(data,binary)=>socket.send(data,{binary})));
const mf=new Miniflare(convertV4MiniflareOptions({modulesRoot:out,modules:[{type:'ESModule',path:resolve(out,'worker.js')},{type:'CompiledWasm',path:resolve(out,'bridge.wasm')}],compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat'],bindings:{ECHO_URL:`ws://127.0.0.1:${server.address().port}`}}));
try {
 const response=await mf.dispatchFetch('http://localhost/'+(process.argv.includes('--upstream')?'upstream':'proof'));
 const result=await response.json();
 await writeFile(resolve(out,process.argv.includes('--upstream')?'upstream-proof.json':'workerd-proof.json'),JSON.stringify({runtime:'actual workerd',status:response.status,...result},null,2));
 console.log(JSON.stringify(result,null,2)); if(!response.ok||!result.ok)process.exitCode=1;
} finally {await mf.dispose();server.close();}
