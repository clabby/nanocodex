import assert from "node:assert/strict";
import test from "node:test";
import { createJustBashRuntime } from "nanocodex-tools/bash";
import { Bash } from "nanocodex-tools/just-bash/browser";

const context = (signal = new AbortController().signal) => ({
  callId: "synthetic-call", parentCallId: "synthetic-parent", sessionId: "synthetic-thread",
  turnId: "synthetic-turn", model: "synthetic", signal,
});

test("public exec_command telemetry follows failure, retry, and recovery without retaining content", async (t) => {
  const filesystem = new Bash().fs;
  await filesystem.mkdir("/brain", { recursive: true });
  const events = [];
  const shell = await createJustBashRuntime({ filesystem, cwd: "/brain", lazyInitialize: true,
    executionTimeoutMs: 100, executionLimits: { maxSourceBytes: 16384 },
    onExecution: (event, ctx) => { events.push({ ...event, call_id: ctx.callId }); },
  });
  const secret = "synthetic-private-sentinel";
  await filesystem.writeFile("/brain/private-file", secret + "\n");
  for (const [cmd, category, command, exit] of [
    [`rg -F '${secret}' private-file`, "none", "rg", 0],
    [`sed -n '1p' private-file`, "none", "sed", 0],
    [`grep absent private-file`, "command_exit", "grep", 1],
    [`missing-${secret}`, "command_not_found", "other", 127],
    ["if then", "syntax", "other", 2],
    ["rg '" + "x".repeat(9000) + "' private-file", "search_admission", "rg", undefined],
    ["echo '" + "x".repeat(17000) + "'", "resource_limit", "echo", undefined],
    ["sleep 1", "timeout", "sleep", 124],
    ["echo recovered", "none", "echo", 0],
  ]) {
    events.length = 0;
    const result = await shell.tool.handler({ cmd }, context());
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(e => e.phase), ["queued", "started", "finished"]);
    const event = events[2];
    assert.equal(event.exit_code, result.exit_code);
    if (exit !== undefined) assert.equal(result.exit_code, exit, result.output);
    else assert.notEqual(result.exit_code, 0, result.output);
    assert.equal(event.category, category, result.output);
    assert.equal(event.command, command);
    assert.equal(event.status, result.exit_code === 0 ? "success" : "error");
    assert.ok(event.duration_ms >= 0);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(JSON.stringify(events).includes("private-file"), false);
    t.diagnostic(JSON.stringify({ event, exit_code: result.exit_code }));
  }
  events.length = 0;
  await assert.rejects(shell.tool.handler({ cmd: "echo secret", tty: true }, context()));
  assert.equal(events.at(-1).category, "input_validation");
  assert.equal(events.at(-1).exit_code, null);
  events.length = 0;
  const aborted = new AbortController(); aborted.abort(new Error(secret));
  const cancelled = await shell.tool.handler({ cmd: "echo secret" }, context(aborted.signal));
  assert.equal(cancelled.exit_code, 124);
  assert.equal(events.at(-1).category, "cancelled");
});

test("lazy loader failure is observed and a throwing telemetry sink cannot break recovery", async () => {
  const filesystem = new Bash().fs;
  await filesystem.mkdir("/brain", { recursive: true });
  let fail = true;
  const events = [];
  const shell = await createJustBashRuntime({ filesystem, cwd: "/brain", lazyInitialize: true,
    loadInterpreter: async () => { if (fail) throw new Error("private loader detail"); return { Bash }; },
    onExecution: event => { events.push(event); throw new Error("sink unavailable"); },
  });
  await assert.rejects(shell.tool.handler({ cmd: "echo recovered" }, context()), /private loader detail/);
  assert.equal(events.at(-1).category, "exception");
  assert.equal(events.at(-1).exit_code, null);
  fail = false;
  const result = await shell.tool.handler({ cmd: "echo recovered" }, context());
  assert.equal(result.exit_code, 0);
  assert.equal(result.output, "recovered\n");
  assert.equal(events.at(-1).category, "none");
});
