import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const appId = "nanocodex-cli";
const appOrigin = "https://cli.nanocodex.xyz";
const token = "t".repeat(43);
const grantId = `0x${"a".repeat(64)}`;
const accountAddress = `0x${"1".repeat(40)}`;

// Exercise the deployed worker's authenticated HTTP boundary.
test("Connect search preserves omitted and explicit output budgets", async (t) => {
  const outdir = await mkdtemp(path.join(os.tmpdir(), "nanocodex-search-budget-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await promisify(execFile)(process.execPath, [
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname,
    "deploy", "--dry-run", "--config", "./wrangler.jsonc", "--outdir", outdir,
  ], { cwd: new URL("..", import.meta.url) });
  const worker = (await import(new URL(`file://${path.join(outdir, "index.js")}`))).default;
  const grant = { id: grantId, appId, appOrigin, accountAddress,
    brokerUserId: "11111111-1111-4111-8111-111111111111", agentId: "search-budget-test",
    permission: "agent.run", status: "active", expiresAt: Math.floor(Date.now() / 1000) + 3600,
    capabilities: ["chatgpt", "tools:use"], spentAtomics: "0", egressSubject: "s".repeat(43) };
  const forwarded = [];
  const env = {
    CONNECT_STATE: { idFromName: name => name, get: () => ({ fetch: async () =>
      Response.json({ grant, principal: { accountAddress, appId, appOrigin, grantId } }) }) },
    EGRESS: { fetch: async request => { forwarded.push(await request.json()); return Response.json({ ok: true }); } },
  };
  const call = body => worker.fetch(new Request("https://connect.example/api/tools/web-search", {
    method: "POST", headers: { authorization: `Bearer ${token}`, origin: appOrigin,
      "x-nanocodex-app-id": appId, "content-type": "application/json" },
    body: JSON.stringify({ session_id: "fixture", commands: {}, ...body }),
  }), env, { waitUntil() {} });
  for (const body of [{}, { max_output_tokens: 0 }, { max_output_tokens: 131072 }]) {
    const response = await call(body);
    assert.equal(response.status, 200, await response.text());
    assert.equal(forwarded.at(-1).max_output_tokens, body.max_output_tokens);
    assert.equal(Object.hasOwn(forwarded.at(-1), "max_output_tokens"), Object.hasOwn(body, "max_output_tokens"));
  }
  for (const max_output_tokens of [-1, 1.5, "100", null]) {
    assert.equal((await call({ max_output_tokens })).status, 400);
  }
  assert.equal(forwarded.length, 3);
});
