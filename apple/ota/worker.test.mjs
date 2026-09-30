/** Native stream tests; local fixture IPA is UNSIGNED and proves transport only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import worker from './worker.mjs';
const root = path.resolve(process.argv[2] || '../ota-http-test/upload');
const file = '/builds/1790730578/Nanocodex.ipa';
const canonical = JSON.parse(fs.readFileSync(root + file + '.chunks.json'));
const size = canonical.size, CHUNK=24*1024*1024, BLOCK=1024*1024;
let mode={}, calls=[], cancelled=0;
function byteStream(disk, selected) {
  let fd=fs.openSync(disk,'r'),pos=0,limit=fs.statSync(disk).size;
  if(selected && mode.truncated) limit--;
  if(selected && mode.overlong) limit++;
  return new ReadableStream({
    pull(controller) {
      if(pos===limit){fs.closeSync(fd);fd=null;controller.close();return;}
      const want=Math.min(selected&&mode.huge ? BLOCK+1 : 65536,limit-pos);
      const bytes=new Uint8Array(want); const n=fs.readSync(fd,bytes,0,want,pos);
      if(n<want)bytes.fill(4,n);
      if(selected && mode.corrupt && pos===0)bytes[0]^=1;
      pos+=want;controller.enqueue(bytes);
    },
    cancel(){cancelled++;if(fd!==null){fs.closeSync(fd);fd=null;}}
  }, {highWaterMark:0});
}
const assets={async fetch(req){
  const p=new URL(req.url).pathname;calls.push({path:p,method:req.method});
  if(p.startsWith('/__ota_chunks/')||p.endsWith('.chunks.json')) {
    assert.equal(new URL(req.url).search,'');
    for(const h of ['Range','If-Range','If-None-Match','Authorization'])assert.equal(req.headers.get(h),null);
  }
  if(p===file+'.chunks.json') {
    if(mode.metaMissing) return new Response(null,{status:404});
    let body=mode.badJSON ? '{bad' : JSON.stringify(mode.change ? mode.change(structuredClone(canonical)) : canonical);
    if(mode.metaOversize)body=' '.repeat(65537);
    const headers={'Content-Type':'application/json'};
    if(!mode.omitLength) headers['Content-Length']=String(mode.metaWrongLength?body.length+1:body.length);
    if(mode.encoded)headers['Content-Encoding']='gzip';
    return new Response(body,{headers});
  }
  if(p===file && mode.metaMissing) {
    if(mode.directAbsent)return new Response(null,{status:404});
    const bytes=new Uint8Array(mode.directSize||10);
    const headers=mode.omitLength?{}:{'Content-Length':String(bytes.length)};
    const body=req.method==='HEAD'?null:new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=65536)c.enqueue(bytes.subarray(i,i+65536));c.close();}});
    return new Response(body,{headers});
  }
  const disk=root+p;
  if(!fs.existsSync(disk))return new Response(null,{status:404});
  const selected=p===canonical.chunks[0].path;
  if(selected && mode.missing)return new Response(null,{status:404});
  const headers={};
  if(!mode.omitLength)headers['Content-Length']=String(fs.statSync(disk).size+(selected&&mode.wrongLength?1:0));
  if(selected && mode.encoded)headers['Content-Encoding']='gzip';
  if(mode.redirect && selected)return new Response(null,{status:302,headers:{Location:'https://untrusted.invalid'}});
  return new Response(req.method==='HEAD'?null:byteStream(disk,selected),{headers});
}};
function request(headers={},method='GET',p=file){return new Request('https://ota.invalid'+p,{method,headers});}
async function response(headers={},method='GET',p=file){return worker.fetch(request(headers,method,p),{ASSETS:assets});}
async function consume(res){
 const hash=createHash('sha256');let bytes=0;
 if(res.body){for await(const data of res.body){hash.update(data);bytes+=data.length;}}
 return {bytes,sha256:hash.digest('hex')};
}
const results=[];
async function test(name,fn){mode={};calls=[];await fn();results.push(name);console.log('PASS '+name);}
async function full(){const r=await response();assert.equal(r.status,200);assert.equal(r.headers.get('Content-Length'),String(size));const b=await consume(r);assert.equal(b.bytes,size);assert.equal(b.sha256,canonical.sha256);assert(calls.length<=41);}
await test('full exact SHA streamed',full);
await test('ASSETS absent length headers supported',async()=>{mode.omitLength=true;await full();});
await test('HEAD complete representation',async()=>{const r=await response({'Range':'bytes=1-5'},'HEAD');assert.equal(r.status,200);assert.equal(r.headers.get('Content-Length'),String(size));assert.equal(r.body,null);});
for(const [name,range,lo,hi] of [['cross chunk',`bytes=${CHUNK-21}-${CHUNK+37}`,CHUNK-21,CHUNK+37],['suffix','bytes=-32',size-32,size-1],['open end',`bytes=${size-16}-`,size-16,size-1],['clamped',`bytes=${size-5}-${size+100}`,size-5,size-1]]){
 await test(name,async()=>{const r=await response({'Range':range});assert.equal(r.status,206);assert.equal(r.headers.get('Content-Range'),`bytes ${lo}-${hi}/${size}`);const data=new Uint8Array(await r.arrayBuffer());assert.equal(data.length,hi-lo+1);const expected=[];for(let pos=lo;pos<=hi;){const i=Math.floor(pos/CHUNK),n=Math.min(hi-pos+1,canonical.chunks[i].size-pos%CHUNK);const fd=fs.openSync(root+canonical.chunks[i].path,'r');const b=Buffer.alloc(n);fs.readSync(fd,b,0,n,pos%CHUNK);fs.closeSync(fd);expected.push(b);pos+=n;}assert.deepEqual(Buffer.from(data),Buffer.concat(expected));});
}
for(const value of ['bytes=','bytes=-0',`bytes=${size}-`,'bytes=9-2','bytes=0-1,3-4','items=0-1','bytes=9007199254740992-'])await test('invalid range '+value,async()=>{const r=await response({'Range':value});assert.equal(r.status,416);assert.equal(r.headers.get('Content-Range'),`bytes */${size}`);});
const etag=`"sha256-${canonical.sha256}"`;
await test('ETag conditional 304',async()=>{for(const value of [etag,'W/'+etag,'*',`"stale", ${etag}`]){const r=await response({'If-None-Match':value});assert.equal(r.status,304);assert.equal(r.body,null);}});
await test('If-Range match and mismatch',async()=>{const r=await response({'Range':'bytes=1-2','If-Range':etag});assert.equal(r.status,206);assert.equal((await consume(r)).bytes,2);const whole=await response({'Range':'bytes=1-2','If-Range':'"old"'});assert.equal(whole.status,200);assert.equal((await consume(whole)).sha256,canonical.sha256);});
await test('only GET HEAD',async()=>assert.equal((await response({},'POST')).status,405));
for(const p of [canonical.chunks[0].path,file+'.chunks.json','/__ota_chunks','/%5f%5fota_chunks/abc','/builds/1/Nanocodex.ipa%2echunks.json','/builds/1/a.chunks.json/'])await test('internal path hidden '+p,async()=>{assert.equal((await response({},'GET',p)).status,404);assert.equal(calls.length,0);});
for(const name of ['badJSON','metaOversize','metaWrongLength','missing','wrongLength','encoded','redirect'])await test('reject '+name,async()=>{mode[name]=true;const r=await response();assert.equal(r.status,503);assert.equal(r.headers.get('Cache-Control'),'no-store');});
for(const [name,change] of [['wrong path',m=>(m.path='/builds/9/Nanocodex.ipa',m)],['unsafe size',m=>(m.size=Number.MAX_SAFE_INTEGER,m)],['unexpected key',m=>(m.extra=true,m)],['escaping chunk',m=>(m.chunks[0].path='/elsewhere',m)],['block hash missing',m=>(m.chunks[0].blocks.pop(),m)],['invalid sha',m=>(m.sha256='x',m)]])await test('invalid metadata '+name,async()=>{mode.change=change;assert.equal((await response()).status,503);});
for(const name of ['corrupt','truncated','overlong','huge'])await test('stream refuses '+name,async()=>{mode[name]=true;const r=await response();assert.equal(r.status,200);await assert.rejects(()=>consume(r));});
await test('stream cancellation cancels chunk read',async()=>{const before=cancelled;const r=await response();const reader=r.body.getReader();assert.equal((await reader.read()).done,false);await reader.cancel();assert(cancelled>before);});
await test('legacy direct small IPA',async()=>{mode.metaMissing=true;const r=await response();assert.equal(r.status,200);assert.equal((await consume(r)).bytes,10);});
await test('legacy direct no length remains bounded',async()=>{mode.metaMissing=true;mode.omitLength=true;const r=await response();assert.equal(r.status,200);assert.equal((await consume(r)).bytes,10);});
await test('legacy oversized direct refused',async()=>{mode.metaMissing=true;mode.directSize=CHUNK+1;assert.equal((await response()).status,503);mode.omitLength=true;assert.equal((await response()).status,503);});
await test('missing direct remains404',async()=>{mode.metaMissing=true;mode.directAbsent=true;assert.equal((await response()).status,404);});
console.log(JSON.stringify({status:'pass',tests:results.length,fixture:'unsigned local IPA transport only',size,sha256:canonical.sha256}));
