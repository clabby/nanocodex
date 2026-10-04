import{Miniflare}from'miniflare';
import{readFile}from'node:fs/promises';
const directory=process.argv[2];
const names=JSON.parse(await readFile(directory+'/assets.json','utf8'));
const modules=[{type:'ESModule',path:'worker.mjs',contents:await readFile(directory+'/worker.mjs','utf8')},...await Promise.all(names.map(async name=>({type:'CompiledWasm',path:name,contents:await readFile(directory+'/'+name)})))];
const mf=new Miniflare({durableObjectsPersist:directory+'/sqlite',r2Persist:directory+'/r2',workers:[
  {name:'managed',modules,compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat','enable_request_signal','durable_object_io_tasks_prevent_eviction'],durableObjects:{NANOCODEX_SESSIONS:{className:'FixtureSession',useSQLite:true},MODEL:{className:'FixtureModel',useSQLite:true},NANOCODEX_ACCOUNT_TOOLS:{className:'FixtureModel',useSQLite:true},NANOCODEX_MEMORY:{className:'FixtureModel',useSQLite:true}},serviceBindings:{NANOCODEX:'provider'},r2Buckets:['NANOCODEX_HISTORY','NANOCODEX_WORKSPACES']},
  {name:'provider',modules:[{type:'ESModule',path:'provider.mjs',contents:`export default{async fetch(request,env){return env.MODEL.getByName('fixture-provider').fetch(request)}};`}],compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat'],durableObjects:{MODEL:{className:'FixtureModel',scriptName:'managed',useSQLite:true}}},
]});
await mf.ready;
process.send({ready:true});
process.on('message',async message=>{try{
  const{action,id}=message;const paths={seed:'/__seed',resume:'/__resume',receipt:'/turns/'+id,complete:'/model/__complete',stage:'/model/__stage/'+id,proof:'/__proof',forget:'/__forget-code-journal',functions:'/__functions',directProof:'/__direct-proof',childProof:'/__child-proof'};
  let value;
  if(action==='inspect')value={session:await(await mf.dispatchFetch('https://fixture.internal/__inspect')).json(),model:await(await mf.dispatchFetch('https://fixture.internal/model/__inspect')).json()};
  else{const response=await mf.dispatchFetch('https://fixture.internal'+paths[action],{method:action==='receipt'||action==='proof'||action==='directProof'||action==='childProof'?'GET':'POST',...(action==='seed'?{body:JSON.stringify({id})}:{})});if(!response.ok)throw Error('fixture HTTP '+response.status+': '+(await response.text()).slice(0,2048));value=response.status===204?null:await response.json();}
  process.send({request:message.request,value});
}catch(error){process.send({request:message.request,error:String(error.message)});}});
