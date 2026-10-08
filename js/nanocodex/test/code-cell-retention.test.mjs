import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { createCodeRuntime } from "../../nanocodex-tools/runtime/code-runtime.mjs";

globalThis.crypto ??= webcrypto;
const text = receipt => typeof receipt.output === "string" ? receipt.output
  : receipt.output.filter(item => item.type === "input_text").map(item => item.text).join("\n");
const parse = async receipt => JSON.parse(await receipt);
const id = receipt => text(receipt).match(/Script running with cell ID ([^\s]+)/)?.[1];
const tick = () => new Promise(resolve => setImmediate(resolve));

async function yielded() {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const admitted = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const runtime = createCodeRuntime({ effect: { async handler() {
    calls++;
    started();
    await gate;
    return { receipt: "synthetic-once" };
  } } });
  runtime.beginTurn("owner");
  const pending = runtime.executeCodeObserved(
    'text("partial"); text(await tools.effect({})); text("finished");', "owner", "origin");
  await admitted;
  assert.equal(runtime.preempt("owner", "origin"), true);
  const first = await parse(pending);
  assert.ok(id(first));
  assert.match(text(first), /partial/);
  return { runtime, first, release, calls: () => calls };
}

// This integration boundary executes the real native evaluator and cell
// registry. It characterizes lifecycle loss without replaying production work;
// it does not establish which lifecycle occurred in a production incident.
test("completion between yielded exec and wait retains final output and receipt exactly once", async () => {
  const cell = await yielded();
  try {
    cell.release();
    await tick();
    const final = await parse(cell.runtime.waitCodeObserved(
      JSON.stringify({ cell_id: id(cell.first) }), "owner", "wait"));
    assert.equal(final.success, true);
    assert.equal(final.cell.running, false);
    assert.equal(final.cell.origin_call_id, "origin");
    assert.match(text(final), /Script completed/);
    assert.match(text(final), /finished/);
    assert.doesNotMatch(text(final), /partial/);
    assert.equal(final.nested_calls.length, 1);
    assert.equal(cell.calls(), 1);
    console.log(JSON.stringify({ scenario: "completion-before-wait", initial: cell.first, final, calls: cell.calls() }));
  } finally { cell.release(); await cell.runtime.reset(); }
});

for (const loss of ["cancel-turn", "release-session", "replace-runtime"]) {
  test(`${loss} after yielded exec reproduces missing cell without a second effect`, async () => {
    const cell = await yielded();
    let replacement;
    try {
      if (loss === "cancel-turn") cell.runtime.cancelTurn("owner");
      if (loss === "release-session") cell.runtime.releaseSession("owner");
      if (loss === "replace-runtime") {
        await cell.runtime.reset();
        replacement = createCodeRuntime();
      }
      const final = await parse((replacement ?? cell.runtime).waitCodeObserved(
        JSON.stringify({ cell_id: id(cell.first) }), "owner", "wait"));
      assert.equal(final.success, false);
      assert.match(text(final), /CODE_CELL_UNAVAILABLE: exec cell .* not found/);
      assert.match(text(final), /execution outcome is unknown/);
      assert.match(text(final), /Do not rerun the script or retry uncertain effects/);
      assert.equal(final.cell, undefined); // No fabricated terminal receipt.
      assert.deepEqual(final.nested_calls, []);
      assert.match(text(final), loss === "replace-runtime"
        ? /different runtime generation/ : /unavailable in this session/);
      const again = await parse((replacement ?? cell.runtime).waitCodeObserved(
        JSON.stringify({ cell_id: id(cell.first), terminate: true }), "owner", "wait-again"));
      assert.equal(again.success, false);
      assert.match(text(again), /cannot resume it or confirm termination/);
      assert.equal(cell.calls(), 1);
      console.log(JSON.stringify({ scenario: loss, initial: cell.first, final, calls: cell.calls() }));
    } finally { cell.release(); await cell.runtime.reset(); await replacement?.reset(); }
  });
}


test("wrong session cannot inspect, consume, or terminate another session's yielded cell", async () => {
  const cell = await yielded();
  try {
    const wrong = await parse(cell.runtime.waitCodeObserved(
      JSON.stringify({ cell_id: id(cell.first), terminate: true }), "other", "wait"));
    assert.equal(wrong.success, false);
    assert.match(text(wrong), /unavailable in this session/);
    assert.doesNotMatch(text(wrong), /synthetic-once|partial/);
    assert.equal(wrong.cell, undefined);
    cell.release();
    await tick();
    const final = await parse(cell.runtime.waitCodeObserved(
      JSON.stringify({ cell_id: id(cell.first) }), "owner", "wait"));
    assert.equal(final.success, true);
    assert.match(text(final), /Script completed/);
    assert.equal(final.nested_calls.length, 1);
    assert.equal(cell.calls(), 1);
  } finally { cell.release(); await cell.runtime.reset(); }
});

test("consumed final receipt is not misreported as runtime replacement or replayed", async () => {
  const cell = await yielded();
  try {
    cell.release();
    await tick();
    const first = await parse(cell.runtime.waitCodeObserved(
      JSON.stringify({ cell_id: id(cell.first) }), "owner", "wait"));
    assert.equal(first.success, true);
    const second = await parse(cell.runtime.waitCodeObserved(
      JSON.stringify({ cell_id: id(cell.first) }), "owner", "wait-again"));
    assert.equal(second.success, false);
    assert.match(text(second), /CODE_CELL_UNAVAILABLE/);
    assert.doesNotMatch(text(second), /different runtime generation/);
    assert.deepEqual(second.nested_calls, []);
    assert.equal(cell.calls(), 1);
  } finally { cell.release(); await cell.runtime.reset(); }
});
