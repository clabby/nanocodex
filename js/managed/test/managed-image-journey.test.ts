import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { imageGeneration } from "nanocodex/tools";
import { createManagedImageFetch, managedImageReference } from "../src/managed-image-fetch";
import { DurableEventLog } from "../src/durable-events";
import { ManagedEventArchive } from "../src/managed-event-archive";
import { recentSessionImages, SESSION_IMAGE_REMEMBER_EVENT, SESSION_IMAGE_HISTORY_MAX_PAGES } from "../src/session-images";
import { parseCommand } from "../src/protocol";

const inline = "data:image/png;base64,aW1hZ2U=";
const generated = "data:image/png;base64,Z2VuZXJhdGVk";
const runtime = env as unknown as { IMAGE_HISTORY: DurableObjectNamespace; IMAGE_ARCHIVE: R2Bucket };
const post = (fetch: typeof globalThis.fetch, value: unknown) => fetch("https://managed-tools.internal/image-generation", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});

describe("managed image relay transport", () => {
  it("accepts legacy inline edits and exclusive references with deterministic backgrounds", async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const relay = createManagedImageFetch(async (path, body) => {
      requests.push({ path, body });
      return Response.json({ data: [{ b64_json: "Z2VuZXJhdGVk", id: "image-1", asset_id: "asset-1", generation_id: "gen-1", ignored: "private" }] });
    });
    expect(await (await post(relay, { prompt: " generate " })).json()).toEqual({ image_url: generated, id: "image-1", asset_id: "asset-1", generation_id: "gen-1" });
    await post(relay, { prompt: "edit opaque", images: [inline, { file_id: "file-edited" }], transparent_background: false });
    await post(relay, { prompt: "edit transparent", images: [{ image_url: inline }], transparent_background: true });
    expect(requests.map(({ path, body }) => [path, body.background, body.images])).toEqual([
      ["/v1/images/generations", "opaque", undefined],
      ["/v1/images/edits", "opaque", [{ image_url: inline }, { file_id: "file-edited" }]],
      ["/v1/images/edits", "transparent", [{ image_url: inline }]],
    ]);
    expect(requests.every(({ body }) => body.model === "gpt-image-2" && body.quality === "auto" && body.size === "auto")).toBe(true);
  });

  it("rejects bad targets and transparency types before any broker request", async () => {
    let calls = 0;
    const relay = createManagedImageFetch(async () => { calls++; throw new Error("must not call provider"); });
    for (const images of [null, {}, [17], [inline, false], [{ file_id: "file-1", image_url: inline }], [{ file_id: "" }],
      [{ file_id: "file 1" }], [{ image_url: "https://example.test/image.png" }], [{ image_url: "data:image/png;base64," }],
      [{ image_url: inline, extra: true }], Array(6).fill(inline)]) {
      expect((await post(relay, { prompt: "invalid edit", images })).status).toBe(400);
    }
    for (const transparent_background of [null, "true", 1, {}, []])
      expect((await post(relay, { prompt: "invalid transparency", transparent_background })).status).toBe(400);
    for (const value of [null, [], { prompt: " " }, { prompt: "fine", unexpected: true }])
      expect((await post(relay, value)).status).toBe(400);
    expect((await relay("https://managed-tools.internal/image-generation", { method: "POST", body: "{" })).status).toBe(400);
    expect(calls).toBe(0);
  });

  it("retains provider file/image references, drops unsafe metadata, and reports provider/missing-image failures", async () => {
    const provider = [
      Response.json({ generation_id: "gen-top", data: [{ file_id: "file-result", id: "safe-1", asset_id: "https://private.invalid" }] }, { headers: { "x-codex-imagegen-request-id": "request-success" } }),
      Response.json({ data: [{ image_url: inline }] }),
      Response.json({ data: [{ file_id: "file-result", image_url: inline }] }),
      Response.json({ generation_id: "gen-empty", data: [] }, { headers: { "x-codex-imagegen-request-id": "request-empty" } }),
      Response.json({ generation_id: "gen-error", error: { message: "private https://provider.invalid token=secret" } }, { status: 429, headers: { "x-codex-imagegen-request-id": "request-error" } }),
      new Response("invalid response body with credentials", { headers: { "x-codex-imagegen-request-id": "request-decode" } }),
    ];
    const relay = createManagedImageFetch(async () => provider.shift()!);
    expect(await (await post(relay, { prompt: "file" })).json()).toEqual({ file_id: "file-result", id: "safe-1", generation_id: "gen-top", imagegen_request_id: "request-success" });
    expect(await (await post(relay, { prompt: "inline" })).json()).toEqual({ image_url: inline });
    expect((await post(relay, { prompt: "ambiguous" })).status).toBe(502);
    expect(await (await post(relay, { prompt: "empty" })).json()).toEqual({ error: "image generation returned no image", generation_id: "gen-empty", imagegen_request_id: "request-empty" });
    expect(await (await post(relay, { prompt: "error" })).json()).toEqual({ error: "image generation failed: HTTP 429", generation_id: "gen-error", imagegen_request_id: "request-error" });
    expect(await (await post(relay, { prompt: "decode" })).json()).toEqual({ error: "image generation returned an invalid response", imagegen_request_id: "request-decode" });
  });
});

it("generates, edits attached/file images, resumes archived history, and isolates sessions without network or uploads", async () => {
  await runInDurableObject(runtime.IMAGE_HISTORY.getByName(crypto.randomUUID()), async (_instance, ctx) => {
    type Message = { type: string; [key: string]: unknown };
    let log = new DurableEventLog<Message>(ctx.storage);
    const storageId = ctx.id.toString();
    let archive = new ManagedEventArchive<Message>(ctx.storage, runtime.IMAGE_ARCHIVE, storageId,
      { recentEventCount: 1, sealThresholdBytes: 1 });
    const rootSessionId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const context = (sessionId: string) => ({ sessionId, callId: crypto.randomUUID(), parentCallId: "", model: "gpt-6-astra", signal: new AbortController().signal });
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const relay = createManagedImageFetch(async (path, body) => {
      requests.push({ path, body });
      return Response.json({ data: requests.length === 1 ? [{ b64_json: "Z2VuZXJhdGVk" }] : [{ file_id: "file-final", id: "generation-2" }] });
    });
    let lastResultCallId = "";
    const makeTool = () => imageGeneration({ url: "https://managed-tools.internal/image-generation", fetch: relay,
      recentImages: (sessionId, count) => recentSessionImages({ sessionId, rootSessionId, count,
        history: (before, limit) => archive.history(log, before, limit) }),
      rememberImage: async (sessionId, value, context) => {
        const reference = managedImageReference(value);
        if (!reference) throw new Error("invalid remembered reference");
        lastResultCallId = context.callId;
        log.append({ type: "event", event: { request_id: sessionId, type: SESSION_IMAGE_REMEMBER_EVENT, payload: { reference, call_id: context.callId, parent_call_id: context.parentCallId } } });
      },
    });
    try {
      const tool = makeTool();
      expect(await tool.handler({ prompt: "make an opaque icon" }, context(rootSessionId) as never)).toEqual({ image_url: generated });
      const accepted = parseCommand(JSON.stringify({ type: "prompt", id: "edit-attachments", input: [
        { type: "image", image_url: inline }, { type: "image", file_id: "file-uploaded" },
      ] }));
      if (accepted.type !== "prompt") throw new Error("prompt was not accepted");
      log.append({ type: "turn_accepted", input: accepted.input });
      // Unrelated child and textual output must never enter root recent images.
      log.append({ type: "event", event: { request_id: childSessionId, type: SESSION_IMAGE_REMEMBER_EVENT, payload: { reference: { file_id: "file-child" } } } });
      log.append({ type: "event", event: { request_id: rootSessionId, type: "tool.result", payload: { result: { file_id: "file-spoof" }, tool: "unrelated", content: [{ type: "input_text", text: inline }] } } });
      expect(await tool.handler({ prompt: "combine with transparent background", transparent_background: true,
        num_last_images_to_include: 3 }, context(rootSessionId) as never)).toEqual({ file_id: "file-final", id: "generation-2" });
      expect(requests.map(({ path, body }) => [path, body.background, body.images])).toEqual([
        ["/v1/images/generations", "opaque", undefined],
        ["/v1/images/edits", "transparent", [{ image_url: generated }, { image_url: inline }, { file_id: "file-uploaded" }]],
      ]);
      // Mirror of the successful remembered result must not count as a second image.
      log.append({ type: "event", event: { request_id: rootSessionId, type: "tool.result", payload: {
        tool: "image_gen__imagegen", call_id: lastResultCallId, structured_result: { file_id: "file-final" }, status: "success" } } });
      while ((await archive.seal(true)).sealed) { /* force image history into real R2 */ }
      log = new DurableEventLog<Message>(ctx.storage);
      archive = new ManagedEventArchive<Message>(ctx.storage, runtime.IMAGE_ARCHIVE, storageId);
      const rootImages = await recentSessionImages({ sessionId: rootSessionId, rootSessionId, count: 3,
        history: (before, limit) => archive.history(log, before, limit) });
      expect(rootImages).toEqual([{ image_url: inline }, { file_id: "file-uploaded" }, { file_id: "file-final" }]);
      expect(await recentSessionImages({ sessionId: childSessionId, rootSessionId, count: 1,
        history: (before, limit) => archive.history(log, before, limit) })).toEqual([{ file_id: "file-child" }]);
      expect(await recentSessionImages({ sessionId: crypto.randomUUID(), rootSessionId, count: 1,
        history: (before, limit) => archive.history(log, before, limit) })).toEqual([]);
      await expect(makeTool().handler({ prompt: "missing context", num_last_images_to_include: 5 }, context(childSessionId) as never)).rejects.toThrow("only 1");
      expect(requests).toHaveLength(2);
      // Distinct calls with byte-identical references count twice; only mirrors
      // of those operations (including generatedImage in outer exec) coalesce.
      for (const call_id of ["identical-a", "identical-b"]) {
        log.append({ type: "event", event: { request_id: rootSessionId, type: SESSION_IMAGE_REMEMBER_EVENT,
          payload: { reference: { file_id: "file-identical" }, call_id, parent_call_id: "outer-exec" } } });
        log.append({ type: "event", event: { request_id: rootSessionId, type: "tool.result",
          payload: { tool: "image_gen__imagegen", call_id, structured_result: { file_id: "file-identical" }, status: "success" } } });
      }
      log.append({ type: "event", event: { request_id: rootSessionId, type: "tool.result",
        payload: { tool: "exec", call_id: "outer-exec", content: [
          { type: "input_image", file_id: "file-identical" }, { type: "input_image", file_id: "file-identical" }], status: "success" } } });
      expect(await recentSessionImages({ sessionId: rootSessionId, rootSessionId, count: 3,
        history: (before, limit) => archive.history(log, before, limit) })).toEqual([
          { file_id: "file-final" }, { file_id: "file-identical" }, { file_id: "file-identical" }]);
      for (const block of [{ type: "input_image", image_url: "https://unsupported.invalid/image" },
        { type: "input_image" }, { type: "input_image", file_id: "file-invalid", image_url: inline }]) {
        log.append({ type: "event", event: { request_id: rootSessionId, type: "tool.result",
          payload: { tool: "view_image", content: [block], status: "success" } } });
        await expect(makeTool().handler({ prompt: "no stale fallback", num_last_images_to_include: 1 },
          context(rootSessionId) as never)).rejects.toThrow("malformed or unsupported");
      }
      expect(requests).toHaveLength(2);
      // Bounded archive reads: a long text-only tail cannot scan all old history.
      for (let i = 0; i < 300; i++) log.append({ type: "text", text: "ordinary turn" });
      let pages = 0;
      expect(await recentSessionImages({ sessionId: rootSessionId, rootSessionId, count: 1,
        history: (before, limit) => { pages++; return archive.history(log, before, limit); } })).toEqual([]);
      expect(pages).toBe(SESSION_IMAGE_HISTORY_MAX_PAGES);
    } finally { await archive.deleteAll(); log.clear(); }
  });
});

it("prompt/steer transport accepts exclusive file references and rejects ambiguous or malformed IDs", () => {
  for (const type of ["prompt", "steer"]) {
    const command = { type, id: "image-input", input: [{ type: "image", file_id: "file-uploaded", detail: "original" }] };
    expect(parseCommand(JSON.stringify(command))).toEqual(command);
    for (const entry of [{ type: "image" }, { type: "image", file_id: "file uploaded" },
      { type: "image", file_id: null }, { type: "image", file_id: "x".repeat(513) },
      { type: "image", file_id: "file-uploaded", image_url: inline }]) {
      expect(() => parseCommand(JSON.stringify({ ...command, input: [entry] }))).toThrow("exactly one valid");
    }
  }
});
