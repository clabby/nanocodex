import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import WebSocket from "ws";
import { createBrowserHost } from "../browser/host.mjs";
import { startResponsesServer, messageReader } from "./support/responses.mjs";

// Actual public browser-host transport, TCP WebSockets and binary frames.
// Runtime lifecycle inputs are explicit because a single WASM loop cannot
// deterministically produce unrelated completions while two calls are active.
// The existing web-wasm journey independently covers the real loop/host bridge.
test("socket telemetry preserves response, phase and operation identity across actual transport", { timeout: 15000 }, async t => {
  const server = await startResponsesServer();
  const records = [], transcript = [];
  const session = "11111111-1111-4111-8111-111111111111";
  const turn = "22222222-2222-4222-8222-222222222222";
  const host = createBrowserHost({ WebSocketImpl: WebSocket, onSocketEvent(event) {
    records.push(event);
    // Observer exceptions must not affect frame delivery or request completion.
    if (event.event === "request.finished") throw Error("synthetic observer failure");
  } });
  const runtime = (phase, state, index, responseId, turnId = turn) => host.emitEvent(JSON.stringify({
    type: `model.${phase}.${state}`, request_id: session, payload: {
      turn_id: turnId, ...(index === undefined ? {} : phase === "compaction" ? { after_model_call_index: index } : { call_index: index }),
      ...(responseId === undefined ? {} : { response_id: responseId }),
    },
  }));
  const finished = () => records.filter(x => x.event === "request.finished");
  async function open() {
    const pending = host.connect(server.url, "synthetic-key", session);
    const peer = await server.nextConnection();
    const reader = messageReader(peer);
    const { handle } = JSON.parse(await pending);
    return { handle, peer, reader };
  }
  async function send(socket) {
    assert.deepEqual(JSON.parse(await host.send(socket.handle, '{"type":"response.create","input":[]}')), { ok: true });
    assert.equal((await socket.reader.next()).type, "response.create");
  }
  async function frame(socket, value) {
    const text = JSON.stringify(value);
    socket.peer.send(text);
    assert.deepEqual(JSON.parse(await host.next(socket.handle)), { kind: "text", text });
    transcript.push({ handle: socket.handle, delivered: value.type, response: value.response?.id });
  }
  try {
    host.emitEvent(JSON.stringify({ type: "input.accepted", request_id: session, payload: { session_id: session, turn_id: turn } }));
    runtime("call", "started", 1);
    const a = await open(), b = await open();
    await send(a); await send(b);
    await frame(a, { type: "response.created", response: { id: "resp_actual_A" } });
    await frame(b, { type: "response.created", response: { id: "resp_actual_B" } });
    a.peer.send(Buffer.from("opaque binary"), { binary: true });
    assert.deepEqual(JSON.parse(await host.next(a.handle)), { kind: "binary" });
    runtime("call", "completed", 1, "resp_unrelated");
    runtime("call", "failed", 1);
    assert.equal(finished().length, 0, "unrelated response and ambiguous no-response failure cannot finish either socket");
    runtime("compaction", "started", 1);
    const c = await open(); await send(c);
    await frame(c, { type: "response.created", response: { id: "resp_compact" } });
    runtime("compaction", "completed", 1, "resp_actual_A");
    runtime("call", "completed", 1, "resp_actual_A", "33333333-3333-4333-8333-333333333333");
    assert.equal(finished().length, 0, "phase and turn mismatch cannot finish a known response");
    runtime("call", "completed", 1, "resp_actual_A");
    assert.deepEqual(finished().map(x => [x.response_id, x.phase]), [["resp_actual_A", "generation"]]);
    // An older generation completion must not erase current compaction context.
    const d = await open(); await send(d);
    await frame(d, { type: "response.created", response: { id: "resp_compact_other" } });
    runtime("compaction", "failed", 1);
    assert.equal(finished().length, 1);
    runtime("compaction", "completed", 1, "resp_compact");
    runtime("call", "completed", 1, "resp_actual_B");
    assert.deepEqual(finished().map(x => x.response_id), ["resp_actual_A", "resp_compact", "resp_actual_B"]);
    assert.equal(new Set(finished().map(x => x.socket_id)).size, 3);
    // Conflicting later wire identifiers cannot overwrite an established link.
    await frame(d, { type: "response.in_progress", response: { id: "resp_conflicting" } });
    runtime("compaction", "completed", 1, "resp_conflicting");
    assert.equal(finished().length, 3);
    runtime("compaction", "completed", 1, "resp_compact_other");
    assert.equal(finished().at(-1).response_id, "resp_compact_other");
    assert.equal(finished().at(-1).phase, "compaction");
    // No known response: a completion ID is not authority to bind the socket.
    runtime("call", "started", 2);
    await send(a); await send(b);
    runtime("call", "completed", 2, "resp_never_observed");
    runtime("call", "failed", 2);
    assert.equal(finished().length, 4);
    // Delivery continues after rejected observations, including late response IDs.
    await frame(a, { type: "response.output_text.delta", delta: "still running" });
    await frame(a, { type: "response.created", response: { id: "resp_late" } });
    runtime("call", "completed", 2, "resp_late");
    assert.equal(finished().at(-1).response_id, "resp_late");
    runtime("call", "failed", 2);
    assert.equal(finished().length, 5, "a formerly ambiguous operation remains ambiguous after one response finishes");
    runtime("call", "started", 4); await send(a);
    runtime("call", "failed", 4);
    assert.equal(finished().at(-1).outcome, "failed");
    assert.equal(finished().at(-1).response_id, undefined);
    // Undefined indices on both sides do not constitute operation evidence.
    runtime("warmup", "started"); await send(a);
    runtime("warmup", "failed");
    assert.equal(finished().length, 6);
    await frame(a, { type: "response.created", response: { id: "resp_warm" } });
    runtime("warmup", "completed", undefined, "resp_warm");
    assert.equal(finished().length, 7);
    // Retried starts may reuse turn/index. An older attempt finishing must
    // not erase the newer start, even though their public correlation matches.
    runtime("call", "started", 3); await send(a);
    await frame(a, { type: "response.created", response: { id: "resp_attempt_old" } });
    host.close(b.handle);
    const retry = await open();
    runtime("call", "started", 3); await send(retry);
    await frame(retry, { type: "response.created", response: { id: "resp_attempt_new" } });
    runtime("call", "failed", 3);
    assert.equal(finished().length, 7);
    runtime("call", "completed", 3, "resp_attempt_old");
    runtime("call", "failed", 3);
    assert.equal(finished().length, 8, "retry attempts remain ambiguous after the older response finishes");
    await send(c);
    await frame(c, { type: "response.created", response: { id: "resp_attempt_third" } });
    runtime("call", "failed", 3);
    assert.equal(finished().length, 8, "new attempt context survives the old completion");
    runtime("call", "completed", 3, "resp_attempt_third");
    runtime("call", "completed", 3, "resp_attempt_new");
    assert.equal(finished().length, 10);
    assert.equal(finished().at(-2).model_call_index, 3);
    t.diagnostic(JSON.stringify({ textFramesDelivered: transcript.length, binaryFramesDelivered: 1, finished: finished().map(x => ({ response: x.response_id, phase: x.phase, outcome: x.outcome })) }));
  } finally {
    await host.dispose(); await server.close();
    const output = new URL("../../../../output/integration/socket-attribution/", import.meta.url);
    await mkdir(output, { recursive: true });
    await writeFile(new URL("trace.json", output), JSON.stringify({ records, transcript }, null, 2) + "\n");
  }
});
