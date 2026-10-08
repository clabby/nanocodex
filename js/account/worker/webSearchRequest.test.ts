import assert from "node:assert/strict";
import { test } from "node:test";
import { webSearchRequest } from "./webSearchRequest.ts";

test("empty Codex commands and zero output budget reach the provider unchanged", () => {
  const request = webSearchRequest({ session_id: "s1", commands: {}, max_output_tokens: 0 });
  assert.deepEqual(request.commands, {});
  assert.equal(request.max_output_tokens, 0);
  assert.throws(() => webSearchRequest({ session_id: "s1", commands: [] }), /commands/);
  assert.throws(() => webSearchRequest({ session_id: "s1", commands: {}, max_output_tokens: -1 }), /budget/);
});

test("omitted search output budget remains absent", () => {
  assert.equal(Object.hasOwn(webSearchRequest({ session_id: "s1", commands: {} }), "max_output_tokens"), false);
  assert.equal(webSearchRequest({ session_id: "s1", commands: {}, max_output_tokens: 250_000 }).max_output_tokens, 250_000);
});
