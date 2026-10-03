import assert from "node:assert/strict";
import {appendFile, mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import asyncVariant from "@jitl/quickjs-wasmfile-release-asyncify";
import {newQuickJSAsyncWASMModuleFromVariant} from "quickjs-emscripten-core";
import {createCodeRuntime} from "../runtime/code-runtime.mjs";
import {createQuickJsEvaluator} from "../runtime/quickjs-evaluator.mjs";

// Application-defined tools and real disk effects, through the public runtime
// and actual QuickJS. Catalog descriptions/schemas remain data, not guest code.
test("fresh QuickJS cells retain exact admitted catalog JSON without compiling schema literals", async () => {
  const root=fileURLToPath(new URL("../../../",import.meta.url));
  const output=join(root,"output/code-mode-warm-latency-20261002",`quickjs-data-${Date.now()}-${process.pid}`);
  await mkdir(output,{recursive:true});
  const effects=join(output,"effects.log"),transcript=[];
  const evaluator=createQuickJsEvaluator(await newQuickJSAsyncWASMModuleFromVariant(asyncVariant));
  const omitted=[];
  await evaluator('text(typeof ALL_TOOLS);', {tools:{},text:value=>omitted.push(value)});
  assert.deepEqual(omitted,["undefined"]);
  const runtime=createCodeRuntime({catalog_echo:{description:'quotes " and \\ and Unicode \u2028 ; throw new Error("MUST_NOT_EXECUTE")',parameters:{type:"object",properties:JSON.parse('{"__proto__":{"type":"string"},"name":{"type":"string"}}')},handler:async()=>{await appendFile(effects,"E\n");return "ECHO";}}},{evaluate:evaluator});
  try {
    const expected=JSON.parse(runtime.toolDefinitions());
    const run=async(source,id)=>{const receipt=JSON.parse(await runtime.executeCode(source,"catalog-session",id));transcript.push({source,receipt});assert.equal(receipt.success,true,JSON.stringify(receipt));return receipt;};
    const values=r=>r.output.slice(1).map(x=>{try{return JSON.parse(x.text);}catch{return x.text;}});
    const first=await run('text(ALL_TOOLS); text({ownProto:Object.hasOwn(ALL_TOOLS[0].parameters.properties,"__proto__"),arrayFrozen:Object.isFrozen(ALL_TOOLS),result:await tools.catalog_echo({})}); ALL_TOOLS[0].description="guest edited"; ALL_TOOLS[0].parameters.properties.name.type="number";',"first");
    assert.deepEqual(values(first),[expected,{ownProto:true,arrayFrozen:true,result:"ECHO"}]);
    const next=await run('text(ALL_TOOLS); text(await tools.catalog_echo({}));',"next");
    assert.deepEqual(values(next),[expected,"ECHO"]);
    runtime.addTools({later:{description:"Discovered later",handler:async()=>{await appendFile(effects,"L\n");return "LATE";}}});
    const afterDiscovery=await run('text(ALL_TOOLS); text(await tools.later({}));',"after-discovery");
    assert.deepEqual(values(afterDiscovery),[JSON.parse(runtime.toolDefinitions()),"LATE"]);
    assert.equal(await readFile(effects,"utf8"),"E\nE\nL\n");
  } finally {await runtime.reset();await writeFile(join(output,"transcript.json"),JSON.stringify(transcript,null,2));}
});
