import assert from "node:assert/strict";
import test from "node:test";

import { presentTool } from "../dist/toolPresentation.js";
import { modelTool } from "../dist/toolModel.js";

const spawnTool = (status, output) => ({
  name: "spawn_agent", status,
  input: JSON.stringify({ role: "automation audit", task: "Read-only audit", output_schema: [] }),
  output, children: [],
});
const spawn = (status, output) => presentTool(spawnTool(status, output));

test("failed spawn does not claim a subagent was created", () => {
  const error = 'invalid output_schema: "array" is not of types "boolean", "object"';
  const failed = spawn("failed", error);
  assert.equal(failed.title, "Failed to spawn automation audit");
  assert.equal(failed.source, "Subagent");
  assert.match(modelTool(spawnTool("failed", error)).error, /invalid output_schema/);
});

test("spawn title preserves pending and successful states", () => {
  assert.equal(spawn("running").title, "Spawn automation audit");
  assert.equal(spawn("completed", JSON.stringify({ agent_id: 3, status: { state: "running" } })).title,
    "Spawned automation audit");
});
