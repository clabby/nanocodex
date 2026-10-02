import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import asyncVariant from "@jitl/quickjs-wasmfile-release-asyncify";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import { createCodeRuntime } from "../runtime/code-runtime.mjs";
import { createQuickJsEvaluator } from "../runtime/quickjs-evaluator.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const routerSource = process.env.CODE_MODE_WARM_SOURCE ? resolve(process.env.CODE_MODE_WARM_SOURCE) : join(repo,"js/nanocodex-tools/runtime/tool-router.mjs");
const { ToolRouter, toolMapSource, providerSource } = await import(pathToFileURL(routerSource));
const contract = (name, description) => ({type:"function", name, description, strict:false, parameters:{type:"object",properties:{},additionalProperties:false}});

// Integration journey through the shipped public router/Code Mode boundaries
// and actual QuickJS WASM evaluator. These are intentional application-defined
// tools with disk effects, not mocks of routing or admission. The cache's public
// factory definition array is the only static source being edited.
test("warm Code Mode sees live provider/catalog changes but retains each admitted cell", {timeout:30_000}, async () => {
  const label = process.env.CODE_MODE_DISCOVERY_LABEL ?? `discovery-${Date.now()}-${process.pid}`;
  assert.match(label,/^[a-zA-Z0-9_-]+$/);
  const output=join(repo,"output/code-mode-warm-latency-20261002",label);
  await mkdir(output,{recursive:true});
  const transcript=[],expectedEffects=[];
  const effectPath=join(output,"effects.log");
  const effect = async value => {await appendFile(effectPath,value+"\n");return value;};
  let gateStarted,releaseGate;
  const started=new Promise(resolve=>{gateStarted=resolve;});
  const gate=new Promise(resolve=>{releaseGate=resolve;});
  const factory=toolMapSource("application-static",{
    "stable.echo":{description:"Original stable definition",handler:()=>effect("STATIC")},
    gate:{description:"Pause an admitted cell",handler:async()=>{gateStarted();await gate;return effect("GATE");}},
  });
  const definitions=factory.definitions(),original=definitions[0];
  let dynamicDefinitions=[contract("dynamic_echo","Dynamic version one")];
  let handler=()=>effect("V1");
  const provider={definitions:()=>dynamicDefinitions,resolve:name=>name==="dynamic_echo"?{name,handler,parallelSafe:true}:name==="later_lookup"?{name,handler:()=>effect("LATE"),parallelSafe:true}:undefined};
  const router=new ToolRouter([factory,providerSource("live-provider",provider)]);
  const runtime=createCodeRuntime(router,{evaluate:createQuickJsEvaluator(await newQuickJSAsyncWASMModuleFromVariant(asyncVariant))});
  let failure;
  const run=async(name,script,expectedSuccess=true)=>{
    const updates=[];
    const receipt=JSON.parse(await runtime.executeCode(script,"discovery-session",name,"synthetic-model",update=>updates.push(structuredClone(update))));
    transcript.push({name,script,receipt,updates});
    assert.equal(receipt.success,expectedSuccess,JSON.stringify(receipt));
    return receipt;
  };
  const values=receipt=>receipt.output.slice(1).map(row=>{try{return JSON.parse(row.text);}catch{return row.text;}});
  try {
    for(let i=0;i<3;i++) {
      const receipt=await run(`warm-${i}`,'text({stable:await tools.stable_echo({}),dynamic:await tools.dynamic_echo({})});');
      assert.deepEqual(values(receipt),[{stable:"STATIC",dynamic:"V1"}]);expectedEffects.push("STATIC","V1");
    }
    // Admission occurs before gate dispatch. Mutate sources while its real
    // application handler is awaiting; the rest of this cell must stay pinned.
    const pending=run("pinned-old-cell",'text({catalog:ALL_TOOLS.map(tool=>({name:tool.name,description:tool.description}))}); await tools.gate({}); let lateMissing; try { await tools.later_lookup({}); } catch(error) { lateMissing=error.code; } text({stable:await tools.stable_echo({}),dynamic:await tools.dynamic_echo({}),lateMissing});');
    await started;
    dynamicDefinitions=[contract("dynamic_echo","Dynamic version two"),contract("later_lookup","New late catalog entry")];
    handler=()=>effect("V2");
    definitions.splice(0,1); // Public array mutation, despite frozen source.
    const liveCatalog=router.definitions();
    assert.equal(liveCatalog.some(row=>row.name==="stable.echo"),false);
    assert.equal(liveCatalog.find(row=>row.name==="dynamic_echo").description,"Dynamic version two");
    transcript.push({name:"live-catalog-during-old-cell",catalog:liveCatalog});
    releaseGate();
    const pinned=await pending;
    const pinnedValues=values(pinned);
    assert.ok(pinnedValues[0].catalog.some(tool=>tool.name==="stable.echo"&&tool.description==="Original stable definition"));
    assert.ok(pinnedValues[0].catalog.some(tool=>tool.name==="dynamic_echo"&&tool.description==="Dynamic version one"));
    assert.deepEqual(pinnedValues.at(-1),{stable:"STATIC",dynamic:"V1",lateMissing:"TOOL_NOT_AVAILABLE"});expectedEffects.push("GATE","STATIC","V1");
    const changed=await run("new-catalog-cell",'let missing; try { await tools.stable_echo({}); } catch(error) { missing=error.code; } text({missing,dynamic:await tools.dynamic_echo({}),late:await tools.later_lookup({}),catalog:ALL_TOOLS.map(tool=>({name:tool.name,description:tool.description}))});');
    const changedValue=values(changed)[0];
    assert.equal(changedValue.missing,"TOOL_NOT_AVAILABLE");assert.equal(changedValue.dynamic,"V2");assert.equal(changedValue.late,"LATE");
    assert.ok(!changedValue.catalog.some(tool=>tool.name==="stable.echo"));expectedEffects.push("V2","LATE");
    // Definition bytes AND provider identity stay unchanged: replacing the
    // handler still has to affect the next admitted cell.
    handler=()=>effect("V3");
    const rebound=await run("same-definition-new-handler",'text(await tools.dynamic_echo({}));');
    assert.deepEqual(values(rebound),["V3"]);expectedEffects.push("V3");
    definitions.unshift({...original,description:"Changed static description"});
    const restored=await run("restored-static-array",'text({stable:await tools.stable_echo({}),description:ALL_TOOLS.find(tool=>tool.name==="stable.echo").description});');
    assert.deepEqual(values(restored),[{stable:"STATIC",description:"Changed static description"}]);expectedEffects.push("STATIC");
    // Cached entries must not mask a public-array collision. Failed admission
    // runs no tools; restoring the array immediately restores public behavior.
    definitions.push(definitions[0]);
    const before=await readFile(effectPath,"utf8");
    const rejected=await run("mutated-array-collision",'text(await tools.stable_echo({}));',false);
    assert.match(rejected.output,/duplicate tool name/);
    assert.equal(await readFile(effectPath,"utf8"),before);
    definitions.pop();
    const afterArrayRollback=await run("after-array-rollback",'text(await tools.stable_echo({}));');
    assert.deepEqual(values(afterArrayRollback),["STATIC"]);expectedEffects.push("STATIC");
    // Public source publication also rolls back when normalized names collide.
    assert.throws(()=>router.addSource(toolMapSource("collision-source",{stable_echo:{handler:()=>effect("MUST_NOT_RUN")}})),/normalized tool name collision/);
    assert.equal(router.hasSource("collision-source"),false);
    const afterPublicationRollback=await run("after-publication-rollback",'text({stable:await tools.stable_echo({}),dynamic:await tools.dynamic_echo({})});');
    assert.deepEqual(values(afterPublicationRollback),[{stable:"STATIC",dynamic:"V3"}]);expectedEffects.push("STATIC","V3");
    const effects=(await readFile(effectPath,"utf8")).trim().split("\n");
    assert.deepEqual(effects,expectedEffects);
    console.log(JSON.stringify({evidence:output,routerSource,passed:true,effects:effects.length,checks:["warm cells","live dynamic catalog","handler replacement with identical definition bytes","static definition-array mutation","changed static definition","admitted cell catalog/handler pinning","array collision predispatch","source collision publication rollback"]}));
  } catch(error) {failure=error;throw error;}
  finally {releaseGate();await runtime.reset();await router.reset();
    await writeFile(join(output,"transcript.json"),JSON.stringify({routerSource,router_sha256:createHash("sha256").update(await readFile(routerSource)).digest("hex"),status:failure?"failed":"passed",error:failure?.stack,expectedEffects,transcript},null,2));
    await writeFile(join(output,"test-source.mjs"),await readFile(fileURLToPath(import.meta.url)));
    await writeFile(join(output,"README.md"),`Run: node --test js/nanocodex/test/tool-discovery-warm-journey.test.mjs\nStatus: ${failure?"FAIL: "+failure.message:"PASS"}\nActual public ToolRouter/createCodeRuntime with actual QuickJS WASM cells, disk effect receipts, provider updates and pinned admissions. Intentional application tool handlers are not network mocks. This narrow public-runtime journey supplements the full managed HTTP/WebSocket benchmark; it is not a deployed Worker/model or WAN measurement.\n`);
  }
});
