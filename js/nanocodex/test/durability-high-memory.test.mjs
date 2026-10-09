import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Agent, Subagents, Transport } from "../host/index.mjs";
import { codeEvaluator } from "./quickjs-fixture.mjs";
import { initializeBrowserEngine } from "../browser/engine.mjs";
import { createMemoryDurabilityStore } from "../runtime/durability-store.mjs";

class WaitingSocket extends EventTarget {
  readyState = 1;
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send() {}
  close() { this.readyState = 3; }
}

test("durable subagent messaging survives a WASM heap beyond the Worker subarray ceiling", { timeout: 30_000 }, async t => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const engine = await initializeBrowserEngine({ module });
  // Reserve address space without filling it. This puts subsequent allocations
  // above 128 MiB without launching a delegation storm or contacting a model.
  const size = 144 * 1024 * 1024;
  // wasm-bindgen assigns numbered export names in release builds. Resolve the
  // allocator from the generated glue rather than depending on debug names.
  const glue = await readFile(new URL("../pkg-web/nanocodex.js", import.meta.url), "utf8");
  const allocator = glue.match(/passStringToWasm0\([^\n]+?, wasm\.(\w+), wasm\.\w+\)/)?.[1];
  const deallocator = glue.match(/wasm\.(\w+)\(deferred\d+_0, deferred\d+_1, 1\)/)?.[1];
  assert.ok(allocator && deallocator, "generated glue exposes its string allocator");
  const padding = engine[allocator](size, 1);
  const nativeSubarray = Uint8Array.prototype.subarray;
  const store = createMemoryDurabilityStore("high-memory-messaging");
  const options = { module, codeEvaluator, tools: [], durability: store, durabilityId: "high-memory-messaging",
    transport: Transport.openAi({ apiKey: "fixture", WebSocketImpl: WaitingSocket }) };
  let agent;
  try {
    // Cloudflare remote preview has this native V8 check. Node does not, so
    // retain the real WASM/SDK/store and emulate only the embedder constraint.
    Uint8Array.prototype.subarray = function(begin, end) {
      if (begin > 128 * 1024 * 1024) throw new RangeError("Invalid array buffer length");
      return nativeSubarray.call(this, begin, end);
    };
    assert.ok(engine.memory.buffer.byteLength > 128 * 1024 * 1024);
    agent = await Agent.create(options);
    const children = [];
    for (const role of ["one", "two"]) children.push(await Subagents.spawn(agent, {
      role, task: "Wait for directed messages", outputSchema: { type: "object" },
    }));
    const rootContext = await agent.session.context();
    for (let index = 0; index < 8; index++) {
      const child = children[index % 2];
      const result = await Subagents.send(agent, {
        agentId: child.agent_id, priority: "urgent", purpose: "question", message: `Message Ελληνικά 😀 ${index}`,
      });
      assert.equal(result.to_agent_id, child.agent_id);
    }
    assert.deepEqual(await agent.session.context(), rootContext,
      "directed child messages must not enter the root transcript");
    assert.equal((await Subagents.list(agent)).agents.length, 2);
    await agent.session.shutdown();
    agent = await Agent.create(options);
    const restored = (await Subagents.list(agent, { includeCompleted: true })).agents;
    assert.deepEqual(restored.map(child => child.agent_id).sort(), children.map(child => child.agent_id).sort());
    assert.deepEqual(restored.map(child => child.role).sort(), ["one", "two"]);
    assert.ok(restored.every(child => child.status.state === "interrupted" && child.can_message),
      "the child journal must retain interrupted, messageable children");
    assert.deepEqual(await agent.session.context(), rootContext,
      "reopening the child journal must not copy messages into the root transcript");
    const replacement = await Subagents.spawn(agent, {
      role: "after-reopen", task: "Verify directed messaging after reopen", outputSchema: { type: "object" },
    });

    assert.equal((await Subagents.send(agent, {
      agentId: replacement.agent_id, priority: "urgent", message: "Directed Ελληνικά message after reopen 😀",
    })).to_agent_id, replacement.agent_id);
    assert.deepEqual(await agent.session.context(), rootContext);
    t.diagnostic(JSON.stringify({ wasmBytes: engine.memory.buffer.byteLength,
      sentBeforeReopen: 8, retainedChildren: restored.map(({ agent_id, role, status }) => ({ agent_id, role, status })), sentAfterReopen: 1,
      rootTranscriptUnchanged: true }));
  } finally {
    Uint8Array.prototype.subarray = nativeSubarray;
    try { await agent?.session.shutdown(); }
    finally { engine[deallocator](padding, size, 1); }
  }
});
