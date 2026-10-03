import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { imageGeneration } from "nanocodex-tools/standard";
import { createCodeRuntime } from "nanocodex-tools/runtime/code-runtime";

// Exercise the shipped tool and Code Mode over real HTTP; only image inference is a fixture.
test("generation/edit HTTP journey forwards opaque defaults and mixed file references without decoding them", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    if (requests.length === 4) {
      response.statusCode = 502;
      response.end(JSON.stringify({ error: "image generation failed", imagegen_request_id: "req-failed", generation_id: "gen-failed" }));
    } else response.end(JSON.stringify(requests.length === 1 ? { file_id: "file-generated" } : { image_url: "data:image/png;base64,YQ==" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const histories = new Map([["session-a", ["data:image/png;base64,Yg==", { file_id: "file-user" }]], ["session-b", []]]);
  const tool = imageGeneration({
    url: `http://127.0.0.1:${server.address().port}/images`,
    async recentImages(sessionId, count) { return (histories.get(sessionId) ?? []).slice(-count); },
    async rememberImage(sessionId, reference) {
      const images = histories.get(sessionId) ?? [];
      images.push(reference); histories.set(sessionId, images.slice(-5));
    },
  });
  const runtime = createCodeRuntime({ image_gen__imagegen: tool });
  t.after(() => runtime.reset());
  const generated = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({ prompt: "cutout", transparent_background: true }), "session-a"));
  assert.equal(generated.success, true);
  assert.deepEqual(generated.structured_result, { file_id: "file-generated" });
  const edited = JSON.parse(await runtime.executeCode("generatedImage(await tools.image_gen__imagegen({ prompt: 'mix', num_last_images_to_include: 3 }));", "session-a"));
  assert.equal(edited.success, true);
  assert.equal(edited.output.at(-1).type, "input_image");
  assert.deepEqual(requests[1].images, [
    "data:image/png;base64,Yg==", { file_id: "file-user" }, { file_id: "file-generated" },
  ]);
  await runtime.executeTool("image_gen__imagegen", JSON.stringify({ prompt: "edit transparency", transparent_background: true, num_last_images_to_include: 2 }), "session-a");
  assert.deepEqual(requests[2].images, [{ file_id: "file-generated" }, "data:image/png;base64,YQ=="]);
  const failed = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({ prompt: "fixture failure" }), "session-a"));
  assert.equal(failed.success, false);
  assert.equal(failed.structured_result.imagegen_request_id, "req-failed");
  assert.equal(failed.metadata.generation_id, "gen-failed");
  assert.deepEqual(requests.map(value => value.transparent_background), [true, false, true, false]);
  // Session separation, malformed references, count bounds and type errors never touch HTTP.
  for (const value of [null, "true", 1]) {
    const output = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({ prompt: "x", transparent_background: value }), "session-a"));
    assert.equal(output.success, false);
  }
  for (const count of [0, 6, 1]) {
    const output = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({ prompt: "x", num_last_images_to_include: count }), "session-b"));
    assert.equal(output.success, false);
  }
  histories.set("malformed", [{ file_id: "bad/path" }]);
  let output = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({ prompt: "x", num_last_images_to_include: 1 }), "malformed"));
  assert.equal(output.success, false);
  histories.set("malformed", [{ image_url: "data:image/png;base64,YQ==", file_id: "file-ambiguous" }]);
  output = JSON.parse(await runtime.executeTool("image_gen__imagegen", JSON.stringify({ prompt: "x", num_last_images_to_include: 1 }), "malformed"));
  assert.equal(output.success, false);
  assert.equal(requests.length, 4);
  const file = JSON.parse(await runtime.executeCode("image({ file_id: 'file-model', detail: 'original' }); generatedImage({ file_id: 'file-result' });", "file-output"));
  assert.equal(file.success, true);
  assert.deepEqual(file.output.slice(1), [
    { type: "input_image", file_id: "file-model", detail: "original" },
    { type: "input_image", file_id: "file-result", detail: "high" },
  ]);
  for (const value of [{ file_id: "" }, { file_id: "file\nsecret" }, { file_id: "file-x", image_url: "data:image/png;base64,YQ==" }]) {
    const bad = JSON.parse(await runtime.executeCode(`image(${JSON.stringify(value)});`, "file-output"));
    assert.equal(bad.success, false);
  }
  t.diagnostic("4 localhost HTTP receipts; transparency true/false defaults; mixed exact windows; file output; session/type/ref validation; safe failure IDs");
});
