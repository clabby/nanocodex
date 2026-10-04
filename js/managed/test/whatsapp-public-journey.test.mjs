import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("WhatsApp public HTTP authorization and bounded requests", {timeout:90000}, async () => {
  const bundle = await build({entryPoints:[fileURLToPath(new URL("fixtures/whatsapp-public-worker.ts", import.meta.url))],
    bundle:true, write:false, format:"esm", target:"es2022", platform:"browser", external:["cloudflare:workers","node:*"],
    alias:{"node-rsa":"./node_modules/nanocodex/tools/browser/unsupportedNodeRsa.mjs"}});
  const trace = [];
  const mf = new Miniflare({workers:[{name:"edge", modules:true, compatibilityDate:"2026-07-29", serviceBindings:{MANAGED:"managed"}, script:`export default {fetch(r,e) { const u=new URL(r.url); if(u.pathname.startsWith("/__connect/")){u.protocol="https:"; u.host="nanocodex.internal"; u.port=""; u.pathname=u.pathname.slice(10); return e.MANAGED.fetch(new Request(u,r));} return e.MANAGED.fetch(r); }}`}, {name:"managed", script:bundle.outputFiles[0].text, modules:true,
    compatibilityDate:"2026-07-29", compatibilityFlags:["nodejs_compat"],
    durableObjects:Object.fromEntries([["NANOCODEX_AUTH","NonceStorage"],["NANOCODEX_USERS","UserAccount"],
      ["NANOCODEX_ORGANIZATIONS","Organization"],["NANOCODEX_API_KEYS","ApiKeyRecord"]].map(([key,className])=>[key,{className,useSQLite:true}])),
    serviceBindings:{NANOCODEX:"broker"}},
    {name:"broker", modules:true, compatibilityDate:"2026-07-29", script:`export default {async fetch(r) {
      return Response.json({url:r.url, headers:Object.fromEntries(r.headers), path:new URL(r.url).pathname, query:new URL(r.url).search, method:r.method,
      body:r.method === 'POST' ? await r.json() : null}, {headers:{'x-upstream-private':'hidden'}});
    }}`}]});
  try {
    const base = await mf.ready;
    const user = "11111111-1111-4111-8111-111111111111";
    const issue = async capabilities => {
      const r = await fetch(new URL("/__fixture",base), {method:"POST",body:JSON.stringify({user,capabilities})});
      assert.equal(r.status,200,await r.clone().text()); return r.json();
    };
    const owner = await issue();
    const scoped = await issue(["tools:use"]);
    const operation_id = "22222222-2222-4222-8222-222222222222";
    const connection = "c".repeat(43);
    const connectHeaders = {"x-nanocodex-connect-user":user,"x-nanocodex-connect-grant-id":"0x"+"a".repeat(64),
      "x-nanocodex-connect-capabilities":JSON.stringify(["tools:use"]),
      "x-nanocodex-connect-connectors":"[]","x-nanocodex-connect-mcp-ids":"[]"};
    const principal = await fetch(new URL("/__connect/__fixture/principal",base),{headers:connectHeaders});
    assert.deepEqual(await principal.json(),{kind:"connect_grant"});
    trace.push({name:"trusted ingress resolves genuine Connect grant",expected:"connect_grant",observed:"connect_grant"});
    async function call(name,path,expected,init={}) {
      const r=await fetch(new URL("/v1/connectors/whatsapp"+path,base), {...init,headers:{authorization:`Bearer ${owner.token}`,...init.headers}});
      const body=await r.json(); trace.push({name,expected,observed:r.status,body});
      assert.equal(r.status,expected,JSON.stringify(body)); return {r,body};
    }
    const status = await call("owner status","",200);
    assert.equal(status.r.headers.get("cache-control"),"no-store");
    assert.equal(status.r.headers.get("pragma"),"no-cache");
    assert.equal(status.r.headers.get("referrer-policy"),"no-referrer");
    assert.equal(status.r.headers.get("x-upstream-private"),null);
    assert.equal(status.body.path,`/users/${user}/connectors/whatsapp`);
    const start = await call("owner start","/start",200,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operation_id,phone:"+15555550123"})});
    assert.deepEqual(start.body.body,{operation_id,phone:"+15555550123"});
    const pairing = await call("owner pairing",`/pairing?operation_id=${operation_id}`,200);
    assert.equal(pairing.body.query,`?operation_id=${operation_id}`);
    await call("owner disconnect",`/connections/${connection}`,200,{method:"DELETE"});
    await call("scoped key denied","",401,{headers:{authorization:`Bearer ${scoped.token}`}});
    await call("anonymous denied","",401,{headers:{authorization:""}});
    const session = {authorization:"",cookie:owner.cookie,origin:base.origin};
    await call("same-origin owner session","",200,{headers:session});
    for (const [path,method] of [["","GET"],["/start","POST"],[`/pairing?operation_id=${operation_id}`,"GET"],[`/connections/${connection}`,"DELETE"]]) {
      await call("cross-site session "+method+path,path,403,{method,headers:{...session,origin:"https://evil.example"}});
      await call("missing session origin "+method+path,path,403,{method,headers:{authorization:"",cookie:owner.cookie}});
      await call("scoped key "+method+path,path,401,{method,headers:{authorization:`Bearer ${scoped.token}`}});
      const delegated = await fetch(new URL("/__connect/v1/connectors/whatsapp"+path,base), {method,headers:connectHeaders});
      const result=await delegated.json(); trace.push({name:"Connect denied "+method+path,expected:401,observed:delegated.status,body:result});
      assert.equal(delegated.status,401,JSON.stringify(result));
    }
    const browserRead = {authorization:"",cookie:owner.cookie,"sec-fetch-site":"same-origin","x-nanocodex-request":"1"};
    for (const path of ["",`/pairing?operation_id=${operation_id}`]) {
      await call("browser GET without Origin "+path,path,200,{headers:browserRead});
      for (const [name,headers] of [
        ["cross-site metadata",{...browserRead,"sec-fetch-site":"cross-site"}],
        ["explicit header only",{authorization:"",cookie:owner.cookie,"x-nanocodex-request":"1"}],
        ["fetch metadata only",{authorization:"",cookie:owner.cookie,"sec-fetch-site":"same-origin"}],
      ]) await call(name+" "+path,path,403,{headers});
    }
    await call("POST metadata cannot replace Origin","/start",403,{method:"POST",headers:{...browserRead,"content-type":"application/json"},body:JSON.stringify({operation_id,phone:"+15555550123"})});
    await call("DELETE metadata cannot replace Origin",`/connections/${connection}`,403,{method:"DELETE",headers:browserRead});
    for (const path of ["?extra=1",`/pairing?operation_id=${operation_id}&extra=1`,`/pairing?operation_id=${operation_id}&operation_id=${operation_id}`,"/pairing","/pairing?operation_id=invalid","/start?extra=1"]) {
      await call("invalid query "+path,path,400,{method:path.startsWith("/start")?"POST":"GET"});
    }
    const valid = JSON.stringify({operation_id,phone:"+15555550123"});
    for (const [name,body,type] of [["unknown field",JSON.stringify({operation_id,phone:"+15555550123",extra:true}),"application/json"],
      ["bad phone",JSON.stringify({operation_id,phone:"555"}),"application/json"],
      ["bad id",JSON.stringify({operation_id:"bad",phone:"+15555550123"}),"application/json"],
      ["array","[]","application/json"],["malformed","{","application/json"],
      ["wrong media",valid,"text/plain"],["oversized",valid+" ".repeat(1025),"application/json"]]) {
      await call(name,"/start",400,{method:"POST",headers:{"content-type":type},body});
    }
    await call("body exactly 1024 bytes","/start",200,{method:"POST",headers:{"content-type":"application/json"},body:valid+" ".repeat(1024-Buffer.byteLength(valid))});
    await call("body 1025 bytes","/start",400,{method:"POST",headers:{"content-type":"application/json"},body:valid+" ".repeat(1025-Buffer.byteLength(valid))});
    for (const path of ["",`/pairing?operation_id=${operation_id}`]) {
      await call("contradictory foreign Origin "+path,path,403,{headers:{...browserRead,origin:"https://evil.example"}});
    }
    async function tool(name,input,expected=200,http=200) {
      const r=await fetch(new URL("/__fixture/tool",base),{method:"POST",body:JSON.stringify(input)});
      const body=await r.json(); trace.push({name,expected,http:r.status,observed:body.status,body});
      assert.equal(r.status,http,JSON.stringify(body)); if(http===200) assert.equal(body.status,expected,JSON.stringify(body)); return body;
    }
    for (const path of ["/chats?limit=20","/search?q="+encodeURIComponent("こんにちは café")]) {
      const result=await tool("tool read "+path,{request:{path,connection_id:connection}});
      assert.equal(result.data.url,"https://whatsapp.internal"+path);
      assert.equal(result.data.headers.authorization,"Bearer NANOCODEX_PROVIDER_CREDENTIAL");
      assert.equal(result.data.headers["x-nanocodex-subject"],"s".repeat(43));
      assert.equal(result.data.headers["x-nanocodex-connector-connection"],connection);
    }
    const implicit=await tool("single granted selector injected",{request:{path:"/chats"}});
    assert.equal(implicit.data.headers["x-nanocodex-connector-connection"],connection);
    await tool("tool unavailable",{available:false,request:{path:"/chats"}},403,403);
    await tool("egress grant denied",{grant:false,request:{path:"/chats"}},403);
    await tool("egress requires subject",{subject:false,request:{path:"/chats"}},403);
    await tool("selector outside grant",{request:{path:"/chats",connection_id:"d".repeat(43)}},403);
    for (const path of ["/pairing","/start","/logout","/send"]) {
      await tool("private tool GET "+path,{request:{path}},403);
      await tool("private tool POST "+path,{request:{path,method:"POST",body:{}}},403);
    }
    for (const path of ["//whatsapp.internal.evil/chats","https://whatsapp.internal.evil/chats"]) await tool("tool destination escape",{request:{path}},400,400);
    async function egress(name,url,headers={},expected=403) {
      const r=await fetch(new URL("/__fixture/egress",base),{method:"POST",body:JSON.stringify({url,headers})});
      const body=await r.json(); trace.push({name,expected,observed:r.status,body}); assert.equal(r.status,expected,JSON.stringify(body));return body;
    }
    await egress("other internal destination","https://other.internal/chats");
    await egress("Vault mode remains denied","https://whatsapp.internal/chats",{"x-nanocodex-vault-id":"v".repeat(22)});
    await egress("virtual HTTP denied","http://whatsapp.internal/chats");
    await egress("virtual fragment denied","https://whatsapp.internal/chats#private");
    await egress("virtual credentials denied","https://user:pass@whatsapp.internal/chats");
    const lookalike=await egress("lookalike uses public gateway","https://whatsapp.internal.evil/chats",{},200);
    assert.equal(lookalike.url,"https://public-egress.internal/v1/request");
    assert.equal(lookalike.headers.authorization,undefined);
    assert.equal(lookalike.headers["x-nanocodex-connector-connection"],undefined);
    assert.equal(lookalike.headers["x-nanocodex-target-url"],"https://whatsapp.internal.evil/chats");
    await call("unsupported method","",405,{method:"POST"});
    await call("invalid connection","/connections/short",404,{method:"DELETE"});

  } finally {
    await mf.dispose();
    const output=new URL("../../../output/whatsapp-public/",import.meta.url);
    await mkdir(output,{recursive:true}); await writeFile(new URL("trace.json",output),JSON.stringify(trace,null,2));
  }
});
