#!/usr/bin/env node
// Local-only synthetic authentication boundary. Never included in a deployed Worker.
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureKey = "ncx_live_abcdefgh1234_" + "x".repeat(43);
export const fixtureKeys = { owner: fixtureKey, other: "ncx_live_other1234567_" + "y".repeat(43), organization: "ncx_live_org123456789_" + "z".repeat(43), team: "ncx_live_team12345678_" + "t".repeat(43), connect: "ncx_live_conn12345678_" + "c".repeat(43), readonly: "ncx_live_read12345678_" + "r".repeat(43) };
const source = `
import { routeMeetingLibrary } from "./src/meeting-library.ts";
import { routeMeetingPreview } from "./src/meeting-preview.ts";
import { routeManaged } from "../account/worker/managedProxy.ts";
const keys = ${JSON.stringify(fixtureKeys)};
let calls=0, failing=false, paused=false, requests=[];
export default { async fetch(request, env) {
 const url=new URL(request.url);
 if (env.EDGE && url.pathname==="/__fixture/provider") return env.NANOCODEX_BACKEND.fetch(request);
 if (env.EDGE) return await routeManaged(request,env,url) ?? new Response("not_found",{status:404});
 if (url.pathname==="/__fixture/provider") {
  if(request.method==="POST") { const body=await request.json(); failing=body.fail===true; paused=body.pause===true; }
  return Response.json({calls,failing,requests});
 }
 const token=request.headers.get("authorization")?.replace(/^Bearer /,"");
 const name=Object.keys(keys).find(k=>keys[k]===token);
 const session=request.headers.get("cookie")==="meeting_fixture_session=owner";
 if(!name && !session) return Response.json({error:"unauthorized"},{status:401});
 const principal={kind:session?"account_session":name==="connect"?"connect_grant":"api_key",userId:name==="other"?"fixture-other":"fixture-owner",organizationId:name==="organization"?"fixture-org-other":"fixture-org",teamId:name==="team"?"fixture-team-other":"fixture-team",role:"owner",subjectId:"user:fixture-owner",credentialId:"fixture-only",authorizationEpoch:1,capabilities:name==="readonly"?["agents:read"]:["agents:read","agents:write","tools:use"]};
 const AI={ async run(model,input) { calls++; requests.push({model,input}); if(paused) await new Promise(resolve=>setTimeout(resolve,400)); if(failing) throw new Error("Synthetic inference unavailable");
  return {choices:[{finish_reason:"stop",message:{role:"assistant",content:"## Key points\\n- Discussed the synthetic launch.\\n\\n## Decisions\\n- Launch on Friday.\\n\\n## Actions\\n- Ada will prepare the checklist."}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}};
 }};
 const localEnv={...env,AI};
 return await routeMeetingLibrary(request,localEnv,url,principal) ?? await routeMeetingPreview(request,localEnv,url,principal) ?? new Response("not_found",{status:404});
}};
`;
export async function startMeetingFixture({ port = 8797, persist = resolve(root, "../../output/meeting-library-fixture-state") } = {}) {
 const bundle = await build({ stdin: { contents: source, resolveDir: root }, bundle: true, write: false, format: "esm", target: "es2022", platform: "browser", external: ["cloudflare:workers", "node:*"], alias: {"node-rsa":resolve(root,"node_modules/nanocodex/tools/browser/unsupportedNodeRsa.mjs")} });
 await mkdir(persist,{recursive:true});
 const script=bundle.outputFiles[0].text;
 const mf=new Miniflare({host:"127.0.0.1",port,d1Persist:persist,workers:[
  {name:"edge",script,modules:true,compatibilityDate:"2026-07-29",compatibilityFlags:["nodejs_compat","enable_request_signal"],bindings:{EDGE:true},serviceBindings:{NANOCODEX_BACKEND:"managed"}},
  {name:"managed",script,modules:true,compatibilityDate:"2026-07-29",compatibilityFlags:["nodejs_compat","enable_request_signal"],d1Databases:{NANOCODEX_CRM:"fixture-meeting-library"}},
 ]});
 await mf.ready;
 const db=await mf.getD1Database("NANOCODEX_CRM","managed");
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE name='meeting_library'").first();
 if(!exists) { const sql=await readFile(resolve(root,"migrations/0011_meeting_library.sql"),"utf8"); await db.exec(sql.replace(/^--.*$/gm,"").replace(/\n/g," ")); }
 const columns=(await db.prepare("PRAGMA table_info(meeting_library)").all()).results;
 if(!columns.some(column=>column.name==="summary_claim_until")) { const sql=await readFile(resolve(root,"migrations/0012_meeting_summary_recovery.sql"),"utf8"); await db.exec(sql.replace(/^--.*$/gm,"").replace(/\n/g," ")); }
 return {mf,base:await mf.ready,backend:await mf.getWorker("managed")};
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const args=process.argv.slice(2); const value=flag=>args[args.indexOf(flag)+1];
 const fixture=await startMeetingFixture({port:args.includes("--port")?Number(value("--port")):8797,persist:args.includes("--persist")?resolve(value("--persist")):undefined});
 console.log("Meeting library fixture ready: "+fixture.base+" (synthetic StartupFixture key; real production router/D1)");
 const stop=async()=>{await fixture.mf.dispose();process.exit(0)};process.on("SIGINT",stop);process.on("SIGTERM",stop);
}
