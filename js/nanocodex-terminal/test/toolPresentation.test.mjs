import assert from "node:assert/strict";
import test from "node:test";

import { presentTool } from "../dist/toolPresentation.js";

const spawn = (status, output) => presentTool({
  name: "spawn_agent", status,
  input: JSON.stringify({ role: "automation audit", task: "Read-only audit", output_schema: [] }),
  output, children: [],
});

test("failed spawn does not claim a subagent was created", () => {
  const failed = spawn("failed", 'invalid output_schema: "array" is not of types "boolean", "object"');
  assert.equal(failed.title, "Failed to spawn automation audit");
  assert.equal(failed.source, "Subagent");
  assert.match(failed.outputSummary, /invalid output_schema/);
});

test("spawn title preserves pending and successful states", () => {
  assert.equal(spawn("running").title, "Spawn automation audit");
  assert.equal(spawn("completed", JSON.stringify({ agent_id: 3, status: { state: "running" } })).title,
    "Spawned automation audit");
});
