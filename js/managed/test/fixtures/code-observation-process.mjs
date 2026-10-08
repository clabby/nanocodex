import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
const directory = process.argv[2];
const names = JSON.parse(await readFile(directory+'/assets.json','utf8'));
const modules = [{type:'ESModule',path:'worker.mjs',contents:await readFile(directory+'/worker.mjs','utf8')},
  ...await Promise.all(names.map(async name => ({type:'CompiledWasm',path:name,contents:await readFile(directory+'/'+name)})))];
const mf = new Miniflare({modules, compatibilityDate:'2026-07-29', compatibilityFlags:['nodejs_compat'],
  durableObjects:{SESSION:{className:'ObservationFixture',useSQLite:true}},durableObjectsPersist:directory+'/sqlite'});
await mf.ready;
process.send({ready:true,pid:process.pid});
process.on('message',async message => {
  try {
    const response = await mf.dispatchFetch('https://fixture.internal/',{method:'POST',body:JSON.stringify(message.input)});
    if (!response.ok) throw Error(await response.text());
    process.send({request:message.request,value:await response.json()});
  } catch(error) { process.send({request:message.request,error:String(error.stack)}); }
});
