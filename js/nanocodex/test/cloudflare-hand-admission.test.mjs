import assert from "node:assert/strict";
import test from "node:test";
import { forwardHandViewerUpgrade, isHandViewerUpgrade } from "nanocodex/cloudflare/hand-admission";

const viewer = () => new Request("https://example.test/v1/account/hands/view", { headers: { upgrade: "websocket" } });
test("Hand viewer forwarding accepts only the public viewer upgrade", () => {
  assert.equal(isHandViewerUpgrade(viewer()), true);
  for (const path of ["host", "renew", "screens", "view/extra"]) {
    assert.equal(isHandViewerUpgrade(new Request(`https://example.test/v1/account/hands/${path}`, { headers: { upgrade: "websocket" } })), false);
  }
  assert.equal(isHandViewerUpgrade(new Request(viewer().url)), false);
});
test("rejected authority never reaches a broker and retains rejection response identity", async () => {
  const rejected = Response.json({ error: "unauthorized" }, { status: 401, headers: { "x-nanocodex-access-rejected": "1" } });
  const response = await forwardHandViewerUpgrade(viewer(), { prepare: async () => rejected }, { getByName() { throw new Error("must not admit"); } });
  assert.equal(response, rejected);
});
test("a broker failure is never retried after the admission boundary", async () => {
  let calls = 0;
  await assert.rejects(forwardHandViewerUpgrade(viewer(), { prepare: async request => ({ ownerId: "account", request, headers: [] }) }, {
    getByName() { return { async fetch() { calls++; throw new Error("lost after admission"); } }; },
  }), /lost after admission/);
  assert.equal(calls, 1);
});
