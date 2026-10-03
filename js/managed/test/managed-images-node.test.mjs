import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createCodeRuntime, toolResult } from "../../nanocodex-tools/runtime/code-runtime.mjs";
import { imageGeneration, viewImage, namedTool } from "../../nanocodex-tools/tools/standard.mjs";
import { createManagedImageFetch, managedImageReference } from "../src/managed-image-fetch.ts";
import { recentSessionImages, SESSION_IMAGE_REMEMBER_EVENT } from "../src/session-images.ts";
import { parseCommand } from "../src/protocol.ts";
import { DurableEventLog } from "../src/durable-events.ts";

// Node's real disk SQLite exercises durable storage when the Workers runner is
// unavailable. This adapter is not a Cloudflare/R2 emulator: that integration
// is covered separately by managed-image-journey.test.ts.
function sqliteStorage(db) {
  return { sql: { exec(sql, ...bindings) {
    let rows = [];
    if (sql.trim().endsWith(";") && !bindings.length) db.exec(sql);
    else rows = db.prepare(sql).all(...bindings);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } }, transactionSync(fn) {
    db.exec("BEGIN");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
}

test("real Code Mode generates twice, coalesces slash-ID mirrors, resumes SQLite and edits exact recent refs", async () => {
  mkdirSync("output", { recursive: true });
  const directory = mkdtempSync(join("output", "managed-images-"));
  const file = join(directory, "history.sqlite");
  let db = new DatabaseSync(file);
  let log = new DurableEventLog(sqliteStorage(db));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const requests = [];
  const receipts = [];
  const image = "data:image/png;base64,aW1hZ2U=";
  const relay = createManagedImageFetch(async (path, body) => {
    requests.push({ path, body });
    return Response.json({ data: [{ image_url: image }] });
  });
  const makeTool = () => imageGeneration({ url: "https://managed-tools.internal/images", fetch: relay,
    recentImages: (sessionId, count) => recentSessionImages({ sessionId, rootSessionId: sessionId, count,
      history: async (before, limit) => log.history(before, limit) }),
    rememberImage: async (sessionId, value, context) => {
      const reference = managedImageReference(value);
      assert.ok(reference);
      receipts.push(context);
      log.append({ type: "event", event: { request_id: sessionId, type: SESSION_IMAGE_REMEMBER_EVENT,
        payload: { reference, call_id: context.callId, parent_call_id: context.parentCallId } } });
    },
  });
  let runtime = createCodeRuntime({ image_gen__imagegen: makeTool() });
  try {
    const result = JSON.parse(await runtime.executeCode(`
      const first = await tools.image_gen__imagegen({prompt: "first opaque image"});
      const second = await tools.image_gen__imagegen({prompt: "second identical opaque image"});
      generatedImage(first); generatedImage(second);
    `, sessionId, "public-exec", "gpt-6-astra"));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.nested_calls.length, 2);
    assert.deepEqual(receipts.map(context => context.callId), ["public-exec/code-1", "public-exec/code-2"]);
    for (const call of result.nested_calls) log.append({ type: "event", event: { request_id: sessionId, type: "tool.result",
      payload: { tool: call.name, call_id: call.call_id, structured_result: call.structured_result, status: "success" } } });
    log.append({ type: "event", event: { request_id: sessionId, type: "tool.result",
      payload: { tool: "exec", call_id: "public-exec", result: result.output, status: "success" } } });
    await runtime.reset();
    db.close();
    db = new DatabaseSync(file);
    log = new DurableEventLog(sqliteStorage(db));
    assert.deepEqual(await recentSessionImages({ sessionId, rootSessionId: sessionId, count: 2,
      history: async (before, limit) => log.history(before, limit) }), [{ image_url: image }, { image_url: image }]);
    assert.deepEqual(await recentSessionImages({ sessionId, rootSessionId: sessionId, count: 3,
      history: async (before, limit) => log.history(before, limit) }), [{ image_url: image }, { image_url: image }]);
    const steer = parseCommand(JSON.stringify({ type: "steer", id: "image-steer", input: [{ type: "image", file_id: "file-steered" }] }));
    log.append({ type: "event", event: { request_id: sessionId, type: "input.accepted",
      payload: { kind: "steer", input: steer.input } } });
    runtime = createCodeRuntime({ image_gen__imagegen: makeTool() });
    const edit = JSON.parse(await runtime.executeCode(`
      generatedImage(await tools.image_gen__imagegen({prompt: "edit both transparent", num_last_images_to_include: 2, transparent_background: true}));
    `, sessionId, "edit-exec", "gpt-6-astra"));
    assert.equal(edit.success, true, JSON.stringify(edit));
    assert.deepEqual(requests.map(({ path, body }) => [path, body.background, body.images]), [
      ["/v1/images/generations", "opaque", undefined], ["/v1/images/generations", "opaque", undefined],
      ["/v1/images/edits", "transparent", [{ image_url: image }, { file_id: "file-steered" }]],
    ]);
    // The observed Code Mode path delivers images produced before a failure.
    const failed = JSON.parse(await runtime.executeCodeObserved(`image({file_id: "file-visible-before-error"}); throw Error("after image");`,
      sessionId, "failed-partial", "gpt-6-astra"));
    assert.equal(failed.success, false);
    assert.ok(Array.isArray(failed.output));
    log.append({ type: "event", event: { request_id: sessionId, type: "tool.result",
      payload: { tool: "exec", call_id: "failed-partial", result: failed.output, status: "error" } } });
    assert.deepEqual(await recentSessionImages({ sessionId, rootSessionId: sessionId, count: 1,
      history: async (before, limit) => log.history(before, limit) }), [{ file_id: "file-visible-before-error" }]);
    // Failed provider text/metadata alone must never invent a recent image.
    log.append({ type: "event", event: { request_id: sessionId, type: "tool.result",
      payload: { tool: "image_gen__imagegen", call_id: "failed-generation", structured_result: { file_id: "file-not-generated" }, status: "error" } } });
    assert.deepEqual(await recentSessionImages({ sessionId, rootSessionId: sessionId, count: 1,
      history: async (before, limit) => log.history(before, limit) }), [{ file_id: "file-visible-before-error" }]);
    // Validate only the exact selected newest window, never older candidates.
    log.append({ type: "turn_accepted", input: [
      { type: "image", image_url: "https://older.invalid/image" }, { type: "image", file_id: "file-newest" }], });
    assert.deepEqual(await recentSessionImages({ sessionId, rootSessionId: sessionId, count: 1,
      history: async (before, limit) => log.history(before, limit) }), [{ file_id: "file-newest" }]);
    await assert.rejects(recentSessionImages({ sessionId, rootSessionId: sessionId, count: 2,
      history: async (before, limit) => log.history(before, limit) }), /malformed or unsupported/);
    for (const block of [{ type: "input_image", image_url: "https://unsupported.invalid/image" }, { type: "input_image" }]) {
      log.append({ type: "event", event: { request_id: sessionId, type: "tool.result",
        payload: { tool: "view_image", content: [block], status: "success" } } });
      await assert.rejects(makeTool().handler({ prompt: "must not substitute older images", num_last_images_to_include: 1 },
        { sessionId, callId: "bad-edit", parentCallId: "", signal: new AbortController().signal }), /malformed or unsupported/);
    }
    assert.equal(requests.length, 3);
    // Existing archives contain nested generation+exec mirrors but predate
    // managed remember receipts. Keep separate identical generation operations.
    const legacySession = "33333333-3333-4333-8333-333333333333";
    const legacyRecent = count => recentSessionImages({ sessionId: legacySession, rootSessionId: sessionId, count,
      history: async (before, limit) => log.history(before, limit) });
    log.append({ type: "event", event: { request_id: legacySession, type: "input.accepted",
      payload: { kind: "prompt", input: [{ type: "image", file_id: "file-legacy-older" }] } } });
    await runtime.reset();
    runtime = createCodeRuntime({ image_gen__imagegen: imageGeneration({
      url: "https://managed-tools.internal/images", fetch: relay,
      recentImages: (_, count) => legacyRecent(count),
      // Deliberately no rememberImage hook, matching pre-feature archives.
    }) });
    const legacy = JSON.parse(await runtime.executeCode(
      'generatedImage(await tools.image_gen__imagegen({prompt: "legacy first"}));' +
      'generatedImage(await tools.image_gen__imagegen({prompt: "legacy identical second"}));', legacySession, "legacy-exec"));
    assert.equal(legacy.success, true);
    for (const call of legacy.nested_calls) log.append({ type: "event", event: { request_id: legacySession, type: "tool.result",
      payload: { tool: call.name, call_id: call.call_id, structured_result: call.structured_result, status: "success" } } });
    log.append({ type: "event", event: { request_id: legacySession, type: "tool.result",
      payload: { tool: "exec", call_id: "legacy-exec", result: legacy.output, status: "success" } } });
    assert.deepEqual(await legacyRecent(5), [{ file_id: "file-legacy-older" }, { image_url: image }, { image_url: image }]);
    const legacyEdit = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({
      prompt: "legacy exact window", num_last_images_to_include: 3,
    }), legacySession));
    assert.equal(legacyEdit.success, true);
    assert.deepEqual(requests[5].body.images, [{ file_id: "file-legacy-older" }, { image_url: image }, { image_url: image }]);
    assert.equal(requests.length, 6);
  } finally { await runtime.reset(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("relay Request boundary rejects invalid edits/types and retains only safe provider IDs on all outcomes", async () => {
  const image = "data:image/png;base64,aW1hZ2U=";
  let calls = 0;
  const responses = [
    Response.json({ generation_id: "generation-safe", data: [{ file_id: "file-result", asset_id: "https://private.invalid" }] },
      { headers: { "x-codex-imagegen-request-id": "request-safe" } }),
    Response.json({ generation_id: "generation-error", error: { message: "https://provider.invalid token=secret" } },
      { status: 429, headers: { "x-codex-imagegen-request-id": "request-error" } }),
    new Response("private raw body", { headers: { "x-codex-imagegen-request-id": "request-decode" } }),
    Response.json({ generation_id: "https://unsafe.invalid", data: [] },
      { headers: { "x-codex-imagegen-request-id": "https://unsafe.invalid" } }),
  ];
  const relay = createManagedImageFetch(async (path, body) => {
    calls++;
    assert.equal(path, "/v1/images/edits");
    assert.equal(body.background, "transparent");
    assert.deepEqual(body.images, [{ image_url: image }, { file_id: "file-input" }]);
    return responses.shift();
  });
  const post = value => relay("https://managed-tools.internal/images", { method: "POST", body: JSON.stringify(value) });
  const request = { prompt: "edit safely", transparent_background: true, images: [image, { file_id: "file-input" }] };
  for (const images of [null, {}, [17], [image, false], [{ image_url: image, file_id: "file-both" }], [{ file_id: "" }],
    [{ file_id: "file invalid" }], [{ file_id: "x".repeat(513) }], [{ image_url: "https://fetch.invalid/image" }],
    [{ image_url: "data:image/png;base64," }], [{ image_url: image, extra: true }], Array(6).fill(image)])
    assert.equal((await post({ ...request, images })).status, 400);
  for (const transparent_background of [null, "true", 1, {}, []])
    assert.equal((await post({ ...request, transparent_background })).status, 400);
  for (const value of [null, [], { prompt: " " }, { prompt: "fine", unexpected: true }]) assert.equal((await post(value)).status, 400);
  assert.equal((await relay("https://managed-tools.internal/images", { method: "POST", body: "{" })).status, 400);
  assert.equal(calls, 0);
  assert.deepEqual(await (await post(request)).json(), { file_id: "file-result", generation_id: "generation-safe", imagegen_request_id: "request-safe" });
  assert.deepEqual(await (await post(request)).json(), { error: "image generation failed: HTTP 429", generation_id: "generation-error", imagegen_request_id: "request-error" });
  assert.deepEqual(await (await post(request)).json(), { error: "image generation returned an invalid response", imagegen_request_id: "request-decode" });
  assert.deepEqual(await (await post(request)).json(), { error: "image generation returned no image" });
  assert.equal(calls, 4);
});

test("failed observed Code Mode preserves the delivered latest window and rejects unsupported newer output without stale edits", async () => {
  mkdirSync("output", { recursive: true });
  const directory = mkdtempSync(join("output", "managed-images-partial-"));
  const db = new DatabaseSync(join(directory, "history.sqlite"));
  const log = new DurableEventLog(sqliteStorage(db));
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const requests = [];
  const appendResult = (callId, result, tool = "exec") => {
    for (const call of result.nested_calls ?? []) log.append({ type: "event", event: { request_id: sessionId, type: "tool.result",
      payload: { tool: call.name, call_id: call.call_id, structured_result: call.structured_result, success: call.success } } });
    log.append({ type: "event", event: { request_id: sessionId, type: "tool.result",
      payload: { tool, call_id: callId, result: result.output, success: result.success, cell: result.cell,
        status: result.success ? "success" : "failed" } } });
  };
  const recent = count => recentSessionImages({ sessionId, rootSessionId: sessionId, count,
    history: async (before, limit) => log.history(before, limit) });
  const tool = imageGeneration({ url: "https://managed-tools.internal/images",
    fetch: createManagedImageFetch(async (path, body) => {
      requests.push({ path, body });
      return Response.json({ data: [{ file_id: "file-generated" }] });
    }),
    recentImages: (_, count) => recent(count),
    rememberImage: async (_, reference, context) => log.append({ type: "event", event: { request_id: sessionId,
      type: SESSION_IMAGE_REMEMBER_EVENT, payload: { reference, call_id: context.callId, parent_call_id: context.parentCallId } } }),
  });
  const runtime = createCodeRuntime({ image_gen__imagegen: tool });
  try {
    const steer = parseCommand(JSON.stringify({ type: "steer", id: "partial-steer", input: [{ type: "image", file_id: "file-steered" }] }));
    log.append({ type: "event", event: { request_id: sessionId, type: "input.accepted", payload: { kind: "steer", input: steer.input } } });
    const failed = JSON.parse(await runtime.executeCodeObserved(`
      generatedImage(await tools.image_gen__imagegen({prompt: "retained nested image"}));
      image({file_id: "file-delivered-prefix"});
      throw Error("failure after delivered image");
    `, sessionId, "partial-exec"));
    assert.equal(failed.success, false);
    assert.ok(failed.output.some(block => block.file_id === "file-delivered-prefix"));
    appendResult("partial-exec", failed);
    assert.deepEqual(await recent(5), [{ file_id: "file-steered" }, { file_id: "file-generated" }, { file_id: "file-delivered-prefix" }]);
    // Identical bytes from a later visible occurrence are not a generation mirror.
    const repeated = JSON.parse(await runtime.executeCodeObserved(`image({file_id: "file-delivered-prefix"});`, sessionId, "repeated-exec"));
    appendResult("repeated-exec", repeated);
    assert.deepEqual(await recent(2), [{ file_id: "file-delivered-prefix" }, { file_id: "file-delivered-prefix" }]);
    // A failed generation with no delivered image must not replace the window.
    log.append({ type: "event", event: { request_id: sessionId, type: "tool.result", payload: {
      tool: "image_gen__imagegen", call_id: "undelivered-generation", status: "failed", success: false,
      structured_result: { file_id: "file-not-delivered" }, content: [{ type: "input_text", text: "provider failed" }],
    } } });
    const edit = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({
      prompt: "edit only latest actually delivered image", num_last_images_to_include: 1,
    }), sessionId, "latest-edit"));
    assert.equal(edit.success, true);
    assert.deepEqual(requests[1], { path: "/v1/images/edits", body: {
      images: [{ file_id: "file-delivered-prefix" }], prompt: "edit only latest actually delivered image",
      background: "opaque", model: "gpt-image-2", quality: "auto", size: "auto",
    } });
    // A later wait must retain the original exec operation when coalescing
    // generation receipts/nested results with actually delivered failed output.
    const yielded = JSON.parse(await runtime.executeCodeObserved('// @exec: {"yield_time_ms":1}\n' +
      'await new Promise(resolve => setTimeout(resolve, 100));' +
      'generatedImage(await tools.image_gen__imagegen({prompt: "generation after yield"}));' +
      'image({file_id: "file-wait-prefix"}); throw Error("failure delivered via wait");', sessionId, "wait-origin"));
    assert.equal(yielded.cell.running, true);
    appendResult("wait-origin", yielded);
    const cellId = yielded.output.match(/cell ID ([^\n]+)/)[1];
    const waited = JSON.parse(await runtime.waitCodeObserved(JSON.stringify({ cell_id: cellId }), sessionId, "different-wait-call"));
    assert.equal(waited.success, false);
    assert.deepEqual(waited.cell, { origin_call_id: "wait-origin", running: false });
    appendResult("different-wait-call", waited, "wait");
    assert.deepEqual(await recent(5), [
      { file_id: "file-delivered-prefix" }, { file_id: "file-delivered-prefix" },
      { file_id: "file-generated" }, { file_id: "file-generated" }, { file_id: "file-wait-prefix" },
    ]);
    for (const url of ["data:application/octet-stream;base64,YQ==", "data:image/png;base64,"]) {
      // These are real delivered Code Mode blocks, not hand-made projector input.
      const unsupported = JSON.parse(await runtime.executeCodeObserved(`image(${JSON.stringify(url)}); throw Error("after unsupported image");`,
        sessionId, "unsupported-exec"));
      assert.equal(unsupported.success, false);
      assert.ok(unsupported.output.some(block => block.image_url === url));
      appendResult("unsupported-exec", unsupported);
      const rejected = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({
        prompt: "never substitute an older image", num_last_images_to_include: 1,
      }), sessionId, "rejected-edit"));
      assert.equal(rejected.success, false);
      assert.match(JSON.stringify(rejected), /malformed or unsupported/);
    }
    assert.equal(requests.length, 3, "unsupported latest output never reaches the provider or falls back to an older target");
  } finally { await runtime.reset(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("real view_image/MCP image occurrences coalesce only their outer mirrors; originless legacy wait requires reattachment", async () => {
  mkdirSync("output", { recursive: true });
  const directory = mkdtempSync(join("output", "managed-images-mirrors-"));
  const db = new DatabaseSync(join(directory, "history.sqlite"));
  const log = new DurableEventLog(sqliteStorage(db));
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const file = join(directory, "pixel.png");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=";
  writeFileSync(file, Buffer.from(png, "base64"));
  const inline = "data:image/png;base64," + png;
  const mcpImage = "data:image/png;base64,YQ==";
  const requests = [];
  const recent = count => recentSessionImages({ sessionId, rootSessionId: sessionId, count,
    history: async (before, limit) => log.history(before, limit) });
  const archive = (result, callId, tool = "exec", includeCell = true) => {
    for (const call of result.nested_calls ?? []) log.append({ type: "event", event: { request_id: sessionId, type: "tool.result",
      payload: { tool: call.name, call_id: call.call_id, result: call.output,
        structured_result: call.structured_result, success: call.success } } });
    log.append({ type: "event", event: { request_id: sessionId, type: "tool.result", payload: {
      tool, call_id: callId, result: result.output, success: result.success,
      ...(includeCell ? { cell: result.cell } : {}),
    } } });
  };
  const tool = imageGeneration({ url: "https://managed-tools.internal/images",
    recentImages: (_, count) => recent(count),
    fetch: createManagedImageFetch(async (path, body) => {
      requests.push({ path, body });
      return Response.json({ data: [{ file_id: "file-relay-generated" }] });
    }),
    // No remember hook: exercise pre-feature archive shape too.
  });
  const runtime = createCodeRuntime({
    view_image: viewImage({ workspace: { readFile: async path => new Uint8Array(readFileSync(path)) } }),
    mcp_fixture__images: namedTool("mcp_fixture__images", {
      description: "Controlled external image tool fixture", parameters: { type: "object", properties: { fail: { type: "boolean" } } },
      handler: async input => toolResult([
        { type: "input_image", image_url: mcpImage }, { type: "input_image", image_url: mcpImage },
      ], { content: [{ type: "image", mimeType: "image/png", data: "YQ==" }, { type: "image", mimeType: "image/png", data: "YQ==" }] },
      { success: input.fail !== true, value: { content: [{ type: "image", mimeType: "image/png", data: "YQ==" }, { type: "image", mimeType: "image/png", data: "YQ==" }] } }),
    }),
    image_gen__imagegen: tool,
  });
  try {
    log.append({ type: "turn_accepted", input: [{ type: "image", file_id: "file-older" }] });
    const viewed = JSON.parse(await runtime.executeCodeObserved(
      `const first = await tools.view_image({path:${JSON.stringify(file)}}); image(first);` +
      `image(await tools.view_image({path:${JSON.stringify(file)}})); image(first);`, sessionId, "views-exec"));
    assert.equal(viewed.success, true);
    assert.equal(viewed.nested_calls.length, 2);
    assert.ok(viewed.nested_calls.every(call => Array.isArray(call.output) && call.output.some(block => block.type === "input_image")));
    archive(viewed, "views-exec");
    assert.deepEqual(await recent(5), [{ file_id: "file-older" }, { image_url: inline }, { image_url: inline }, { image_url: inline }]);
    const exact = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({
      prompt: "edit exact view window", num_last_images_to_include: 4,
    }), sessionId));
    assert.equal(exact.success, true);
    assert.deepEqual(requests[0].body.images, [{ file_id: "file-older" }, { image_url: inline }, { image_url: inline }, { image_url: inline }]);
    const mcp = JSON.parse(await runtime.executeCodeObserved(
      'const result = await tools.mcp_fixture__images({}); image(result.content[0]); image(result.content[1]); image(result.content[0]);',
      sessionId, "mcp-exec"));
    assert.equal(mcp.success, true);
    archive(mcp, "mcp-exec");
    assert.deepEqual(await recent(5), [
      { image_url: inline }, { image_url: inline }, { image_url: mcpImage }, { image_url: mcpImage }, { image_url: mcpImage },
    ], "multiple identical images from one operation and a direct redisplay stay distinct");
    // A different wait call safely coalesces a view_image mirror when cell
    // origin is present, without treating it as another identical operation.
    const yieldedView = JSON.parse(await runtime.executeCodeObserved('// @exec: {"yield_time_ms":1}\n' +
      'await new Promise(resolve=>setTimeout(resolve,100));' +
      `image(await tools.view_image({path:${JSON.stringify(file)}}));`, sessionId, "view-origin"));
    assert.equal(yieldedView.cell.running, true);
    archive(yieldedView, "view-origin");
    const viewedCell = yieldedView.output.match(/cell ID ([^\n]+)/)[1];
    const viewWait = JSON.parse(await runtime.waitCodeObserved(JSON.stringify({cell_id:viewedCell}), sessionId, "view-wait"));
    archive(viewWait, "view-wait", "wait");
    assert.deepEqual(await recent(4), [{ image_url: mcpImage }, { image_url: mcpImage }, { image_url: mcpImage }, { image_url: inline }]);
    // Failed generic tools can still deliver image content. Forward the thrown
    // actual result and retain its two occurrences, not two extra mirrors.
    const failedMcp = JSON.parse(await runtime.executeCodeObserved(
      'try { await tools.mcp_fixture__images({fail:true}); } catch (result) {' +
      'image(result.content[0]); image(result.content[1]); } throw Error("after delivered failure images");',
      sessionId, "failed-mcp-exec"));
    assert.equal(failedMcp.success, false);
    assert.equal(failedMcp.nested_calls[0].success, false);
    assert.equal(failedMcp.nested_calls[0].output.filter(block => block.type === "input_image").length, 2);
    archive(failedMcp, "failed-mcp-exec");
    assert.deepEqual(await recent(3), [{ image_url: inline }, { image_url: mcpImage }, { image_url: mcpImage }]);
    // Legacy wait archives omit cell origin. Keep their selected candidate
    // ambiguous instead of inventing a second generation or silently skipping it.
    const yielded = JSON.parse(await runtime.executeCodeObserved('// @exec: {"yield_time_ms":1}\n' +
      'await new Promise(resolve=>setTimeout(resolve,100)); generatedImage(await tools.image_gen__imagegen({prompt:"legacy wait"}));',
      sessionId, "legacy-origin"));
    assert.equal(yielded.cell.running, true);
    archive(yielded, "legacy-origin", "exec", false);
    const cellId = yielded.output.match(/cell ID ([^\n]+)/)[1];
    const waited = JSON.parse(await runtime.waitCodeObserved(JSON.stringify({cell_id:cellId}), sessionId, "legacy-wait"));
    archive(waited, "legacy-wait", "wait", false);
    for (const count of [1, 2]) {
      const rejected = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({
        prompt: "reattach instead of guessing", num_last_images_to_include: count,
      }), sessionId));
      assert.equal(rejected.success, false);
      assert.match(JSON.stringify(rejected), /origin is unavailable; please reattach/);
    }
    assert.equal(requests.length, 2, "ambiguous selected wait never reaches provider");
    log.append({ type: "event", event: { request_id: sessionId, type: "input.accepted",
      payload: { kind: "steer", input: [{ type: "image", file_id: "file-reattached" }] } } });
    assert.deepEqual(await recent(1), [{ file_id: "file-reattached" }]);
    await assert.rejects(recent(2), /origin is unavailable; please reattach/);
  } finally { await runtime.reset(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
