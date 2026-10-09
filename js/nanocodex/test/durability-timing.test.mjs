import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocketServer } from "ws";

const modulePath = process.env.NANOCODEX_TIMING_WASM
  ?? fileURLToPath(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
const runner = fileURLToPath(new URL("./support/durability-timing-process.mjs", import.meta.url));

for (const mode of ["control", "recovered", ...(process.env.NANOCODEX_TIMING_LEGACY_WASM ? ["legacy"] : [])]) {
  test(`public WASM Agent logical elapsed time: ${mode}`, { timeout: 60_000 }, async t => {
    const retained = process.env.NANOCODEX_TIMING_EVIDENCE;
    if (retained) await mkdir(retained, { recursive: true });
    const directory = await mkdtemp(join(retained ?? tmpdir(), `nanocodex-timing-${mode}-`));
    let generations = 0;
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const websocketUrl = `ws://127.0.0.1:${server.address().port}`;
    server.on("connection", socket => socket.on("message", async bytes => {
      const index = ++generations;
      await appendFile(`${directory}/model.ndjson`, `${JSON.stringify({ observedAt: Date.now(), index, request: JSON.parse(bytes) })}\n`);
      assert.ok(index <= 2, "reconstruction and exact receipt replay cannot call the provider again");
      await delay(index === 1 ? 120 : 420);
      const response = { id: `response-${index}`, status: "completed", end_turn: index === 2,
        output: index === 1
          ? [{ type: "custom_tool_call", call_id: "native-marker", name: "exec", input: "text(await tools.marker({}));" }]
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "finished" }] }],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      };
      await appendFile(`${directory}/model.ndjson`, `${JSON.stringify({ observedAt: Date.now(), index, response })}\n`);
      socket.send(JSON.stringify({ type: "response.completed", response }));
    }));
    const invoke = async (phase, wasm = modulePath) => {
      const args = [runner, directory, phase, websocketUrl, wasm];
      await appendFile(`${directory}/commands.ndjson`, `${JSON.stringify({ command: process.execPath, args })}\n`);
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, args, { timeout: 30_000 });
        await writeFile(`${directory}/${phase}-process.log`, stdout + stderr);
      } catch (error) {
        await writeFile(`${directory}/${phase}-process.log`, (error.stdout ?? "") + (error.stderr ?? ""));
        throw error;
      }
      return JSON.parse(await readFile(`${directory}/${phase}-events.json`, "utf8"));
    };
    try {
      let firstEvents;
      let completion;
      let downtimeMs = 0;
      if (mode === "control") {
        firstEvents = await invoke("control");
        completion = firstEvents;
      } else {
        firstEvents = await invoke("prepare", mode === "legacy" ? process.env.NANOCODEX_TIMING_LEGACY_WASM : modulePath);
        assert.equal(generations, 2);
        const downtimeStart = Date.now();
        await delay(180);
        downtimeMs = Date.now() - downtimeStart;
        completion = await invoke("recover");
      }
      const terminal = completion.find(({ event }) => event.type === "run.completed");
      const payload = terminal.event.payload;
      const firstStart = firstEvents.find(({ event }) => event.type === "run.started").observedAt;
      const observedElapsedMs = terminal.observedAt - firstStart;
      assert.equal(payload.model_calls, 2);
      assert.equal(payload.tool_calls, 2, "exec and its nested marker are retained");
      assert.ok(payload.model_duration_ns >= 500_000_000, "both original model durations survive recovery");
      assert.ok(payload.tool_wall_duration_ns >= 130_000_000, "the original native tool timing survives recovery");
      assert.equal(payload.duration_ms, Math.floor(payload.duration_ns / 1e6));
      if (mode !== "legacy") {
        assert.ok(payload.duration_ns >= payload.model_duration_ns + payload.tool_wall_duration_ns + downtimeMs * 1e6 - 10_000_000,
          "this sequential journey's elapsed time covers completed work, receipt replay and recovery downtime");
        assert.ok(Math.abs(payload.duration_ms - observedElapsedMs) < 250,
          `logical duration ${payload.duration_ms}ms must follow the first-start timeline ${observedElapsedMs}ms`);
      } else {
        assert.ok(payload.duration_ns > 0, "legacy continuations must recover without an elapsed origin");
      }
      const replay = await invoke("replay");
      const replayPayload = replay.find(({ event }) => event.type === "run.completed").event.payload;
      const completionPhase = mode === "control" ? "control" : "recover";
      assert.deepEqual(JSON.parse(await readFile(`${directory}/replay-result.json`, "utf8")),
        JSON.parse(await readFile(`${directory}/${completionPhase}-result.json`, "utf8")),
        "exact receipt replay must return the committed public result and usage");
      assert.deepEqual(replayPayload.usage, payload.usage);
      assert.equal(generations, 2);
      assert.equal(await readFile(`${directory}/native-marker.txt`, "utf8"), "effect\n",
        "the native effect must execute exactly once across cold recovery and terminal replay");
      const summary = { mode, evidenceDirectory: retained ? directory : undefined,
        expected: mode === "legacy"
          ? "legacy recovery with retained counters and a new elapsed basis, exact result replay, one native effect"
          : "two model calls, one native effect, logical elapsed time and exact result replay",
        observed: { generations, nativeEffects: 1, durationMs: payload.duration_ms,
          observedElapsedMs, downtimeMs, modelDurationMs: payload.model_duration_ns / 1e6,
          toolWallDurationMs: payload.tool_wall_duration_ns / 1e6, exactResultReplay: true,
          replayTerminalDurationMs: replayPayload.duration_ms,
          replayTerminalModelCalls: replayPayload.model_calls } };
      await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
      t.diagnostic(JSON.stringify(summary));
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      if (!retained) await rm(directory, { recursive: true, force: true });
    }
  });
}
