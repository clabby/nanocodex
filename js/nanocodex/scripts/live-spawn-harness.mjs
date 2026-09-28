// Opt-in real-model check against the locally built Rust/WASM subagent tools.
// Run: NANOCODEX_LIVE_ENV_FILE=/path/to/local/.env node js/nanocodex/scripts/live-spawn-harness.mjs
// Credentials stay in this process; the report contains tool names and shapes only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Agent, Subagents, Transport } from "../host/index.mjs";
import { createGatewayResponses } from "../cloudflare/gateway-responses.mjs";

const envText = process.env.NANOCODEX_LIVE_ENV_FILE
  ? await readFile(process.env.NANOCODEX_LIVE_ENV_FILE, "utf8") : "";
function setting(name) {
  if (process.env[name]) return process.env[name];
  const line = envText.split(/\r?\n/).find(line => new RegExp(`^\\s*${name}\\s*=`).test(line));
  if (!line) throw new Error(`${name} is required for the local live harness`);
  let value = line.slice(line.indexOf("=") + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!value) throw new Error(`${name} is empty`);
  return value;
}
const provider = process.env.NANOCODEX_LIVE_SPAWN_PROVIDER ?? "cloudflare";
const model = process.env.NANOCODEX_LIVE_SPAWN_MODEL ?? "gpt-6-sol";
const thinking = process.env.NANOCODEX_LIVE_SPAWN_THINKING ?? "low";
const natural = process.env.NANOCODEX_LIVE_SPAWN_SCENARIO === "natural";
const transport = createGatewayResponses({
  provider, model, reasoningEffort: thinking,
  ...(provider === "cloudflare"
    ? { accountId: setting("NANOCODEX_CLOUDFLARE_ACCOUNT_ID"), apiKey: setting("CLOUDFLARE_AI_API_TOKEN") }
    : { apiKey: setting(provider === "openrouter" ? "OPENROUTER_API_KEY" : "AI_GATEWAY_API_KEY") }),
  fetch: async (url, init) => {
    const requestIndex = ++requests;
    if (requestIndex > 12) throw new Error("local harness model-request budget exceeded");
    const request = JSON.parse(init.body);
    const declaration = request.tools?.find(tool => tool.description?.startsWith("spawn_agent\n")
      || tool.function?.description?.startsWith("spawn_agent\n"));
    if (declaration) {
      const tool = declaration.function ?? declaration;
      assert.equal(tool.strict, true, "provider must receive a strict spawn declaration");
      assert.equal(tool.parameters.additionalProperties, false);
      assert.ok(tool.parameters.properties.output_contract);
      assert.equal(tool.parameters.properties.output_schema, undefined);
      strictRequests += 1;
    }
    console.info(JSON.stringify({ stage: "provider_request", request: requestIndex,
      model: request.model, strict_spawn_declaration: Boolean(declaration) }));
    const response = await fetch(url, init);
    let diagnostic;
    if (!response.ok) {
      try {
        const body = await response.clone().json();
        const allow = value => typeof value === "string" && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : undefined;
        diagnostic = { type: allow(body?.error?.type), code: allow(body?.error?.code),
          param: allow(body?.error?.param),
          mentionsSchema: /schema|strict|additionalProperties|anyOf|\$defs/i.test(String(body?.error?.message ?? "")),
          mentionsModel: /model|unsupported/i.test(String(body?.error?.message ?? "")),
          mentionsTool: /tool|function/i.test(String(body?.error?.message ?? "")) };
      } catch { diagnostic = { unreadable: true }; }
    }
    console.info(JSON.stringify({ stage: "provider_status", request: requestIndex,
      status: response.status, content_type: response.headers.get("content-type"), diagnostic }));
    return response;
  },
});
let requests = 0, strictRequests = 0;
const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
const agent = await Agent.create({
  module, model, thinking, toolMode: "direct",
  transport: Transport.hostManaged({ ...transport, websocketPreconnect: false,
    createWebSocket() { throw new Error("live harness must use streaming HTTPS"); } }),
  tools: [...Subagents.create({ maxConcurrency: 2 })],
  instructions: "This is a local subagent integration test. Use only the named subagent tools. Do not browse, use files, or contact other services.",
});
const events = [];
const watcher = agent.events.watch({ includeAllSessions: true });
watcher.onEvent((event, _bytes, _encoded, agentId) => {
  if (event.type === "tool.call" || event.type === "tool.result") {
    const entry = { type: event.type, tool: event.payload.tool, status: event.payload.status,
      agent_id: agentId ?? null };
    if (event.type === "tool.call" && event.payload.tool === "spawn_agent") {
      const args = event.payload.arguments;
      entry.spawnShape = typeof args === "string" ? JSON.parse(args) : args;
    }
    if (event.type === "tool.result" && ["wait_agent", "submit_result", "spawn_agent"].includes(event.payload.tool)) {
      entry.receipt = event.payload.structured_result;
    }
    events.push(entry);
    console.info(JSON.stringify({ stage: "tool", ...entry }));
  } else if (["run.failed", "model.call.failed"].includes(event.type)) {
    console.info(JSON.stringify({ stage: "failure", type: event.type,
      agent_id: agentId ?? null, error: String(event.payload.error ?? "").slice(0, 180) }));
  }
});
const expected = natural ? { finding: "local OK", evidence: ["one", "two"] }
  : { status: "ok", count: 7 };
const prompt = natural
  ? "Delegate one tiny self-contained check using spawn_agent. Ask the child to submit exactly "
    + "{finding: 'local OK', evidence: ['one', 'two']} via submit_result. The output must be an "
    + "object with required finding (string) and evidence (array of strings) fields. Choose the "
    + "tool's output contract yourself; do not use raw JSON Schema. Use inherited model and "
    + "thinking. Wait for the child and report its actual accepted result. No other actions."
  : `Perform exactly one delegation with spawn_agent. Set role="local-contract-check" and task="Submit {status: 'ok', count: 7} using submit_result. Do not use other tools." Set model and thinking to null. Give this child an output_contract with kind="object", fields status (kind="string_enum", values=["ok"], required=true) and count (kind="integer", required=true). Wait for that child using wait_agent. Then report its actual submitted result, not an invented result, in your final answer.`;
try {
  const turn = agent.turn.prompt({ input: prompt });
  const timeout = setTimeout(() => { void turn.cancel(); }, 120_000);
  let result;
  try { result = await turn.result(); } finally { clearTimeout(timeout); }
  const spawns = events.filter(event => event.type === "tool.call" && event.tool === "spawn_agent");
  const submits = events.filter(event => event.type === "tool.call" && event.tool === "submit_result");
  const waits = events.filter(event => event.type === "tool.call" && event.tool === "wait_agent");
  const summary = { provider, model, thinking, requests, strictRequests,
    spawnCalls: spawns.length, childSubmissions: submits.length, waitCalls: waits.length,
    toolResults: events.filter(event => event.type === "tool.result"), finalMessage: result.finalMessage };
  console.log(JSON.stringify({ stage: "result", ...summary }, null, 2));
  assert.ok(strictRequests > 0, "real provider never saw the strict spawn declaration");
  assert.equal(spawns.length, 1, "real model did not spawn exactly one child");
  assert.equal(submits.length, 1, "real child did not submit exactly one result");
  assert.ok(waits.length > 0, "real root did not wait for its child");
  const childState = events.find(event => event.type === "tool.result" && event.tool === "wait_agent")
    ?.receipt?.agents?.[0]?.status;
  assert.equal(childState?.state, "completed", "real child did not complete successfully");
  assert.deepEqual(childState.output, expected);
  assert.equal(spawns[0].spawnShape.output_schema, undefined);
  assert.equal(spawns[0].spawnShape.output_contract.kind, "object");
  assert.equal(spawns[0].spawnShape.model, null);
  assert.equal(spawns[0].spawnShape.thinking, null);
  assert.match(result.finalMessage, natural ? /local OK/ : /ok/);
  assert.match(result.finalMessage, natural ? /two/ : /7/);
} finally {
  watcher.off();
  await agent.session.shutdown();
}
