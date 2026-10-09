import { codeEvaluator } from '../quickjs-fixture.mjs';
// Real public Agent in a fresh process, sharing only the SQLite durability file.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { Agent, Transport } from "../../host/index.mjs";
import { createSqliteDurabilityStore, sqliteDurabilitySchema } from "../../runtime/durability-store.mjs";

const [directory, phase, websocketUrl, modulePath] = process.argv.slice(2);
const module = await readFile(modulePath);
const db = new DatabaseSync(`${directory}/durability.sqlite`);
for (const sql of sqliteDurabilitySchema) db.exec(sql);
const store = createSqliteDurabilityStore({ transaction(callback) {
  db.exec("BEGIN");
  try {
    const result = callback((sql, args) => db.prepare(sql).all(...args));
    db.exec("COMMIT");
    return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
} });
let interrupted = false;
const durability = { ...store, replace(id, request) {
  const result = store.replace(id, request);
  // Lose the acknowledgement after the second model receipt really commits,
  // before its duration and output advance the current execution continuation.
  if (phase === "prepare" && !interrupted && request.records.some(record => {
    if (!record.value.startsWith("=")) return false;
    return JSON.parse(record.value.slice(1))?.response?.id === "response-2";
  })) {
    interrupted = true;
    throw new Error("lost model receipt acknowledgement");
  }
  return result;
} };
const events = [];
const agent = await Agent.create({ module, codeEvaluator, durability, durabilityId: "timing-operation",
  transport: Transport.openAi({ apiKey: "synthetic", WebSocketImpl: WebSocket,
    websocketUrl, websocketWarmup: false }),
  tools: { marker: {
    description: "Append a synthetic marker using a native process.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const { stdout } = await promisify(execFile)(process.execPath, ["-e",
        "setTimeout(() => { require('node:fs').appendFileSync(process.argv[1], 'effect\\n'); process.stdout.write('marker written'); }, 130)",
        `${directory}/native-marker.txt`]);
      return stdout;
    },
  } },
});
agent.events.watch().onEvent(event => events.push({ observedAt: Date.now(), event }));
try {
  const turn = agent.turn.prompt({ id: "synthetic-timing-turn", input: "Write the synthetic marker and finish." });
  if (phase === "prepare") {
    let interruption;
    await assert.rejects(turn.result(), error => {
      assert.match(error.message, /lost model receipt acknowledgement/);
      assert.equal(error.code, "reopen_required");
      interruption = { code: error.code, message: error.message };
      return true;
    });
    await writeFile(`${directory}/prepare-error.json`, JSON.stringify(interruption, null, 2));
    assert.equal(interrupted, true);
    assert.equal(events.filter(({ event }) => ["run.completed", "run.failed"].includes(event.type)).length, 0);
  } else {
    const result = await turn.result();
    assert.equal(result.finalMessage, "finished");
    await writeFile(`${directory}/${phase}-result.json`, JSON.stringify({
      finalMessage: result.finalMessage, usage: await result.usage(),
    }, null, 2));
    assert.equal(events.filter(({ event }) => event.type === "run.completed").length, 1);
  }
  await writeFile(`${directory}/${phase}-state.json`, JSON.stringify(store.load("timing-operation"), null, 2));
} finally {
  await agent.session.shutdown().catch(() => {});
  await writeFile(`${directory}/${phase}-events.json`, JSON.stringify(events, null, 2));
  await appendFile(`${directory}/processes.ndjson`, `${JSON.stringify({ phase, pid: process.pid, interrupted })}\n`);
  db.close();
}
