import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../managed/index.mjs";

const baseUrl = "https://managed.example";
const agentId = "0198d3f0-8844-7000-8000-000000000001";
const RECEIVED = Date.UTC(2026, 8, 30, 20);
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function eventResponse() {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('id: 1\ndata: {"type":"event","turn_id":"t"}\n\n'));
  } }), { headers: { "content-type": "text/event-stream" } });
}

for (const [label, header, bodyDelay, expected, wallJump = 0] of [
  ["numeric", "2", 750, 1_250],
  ["HTTP-date", "Wed, 30 Sep 2026 20:00:02 GMT", 750, 1_250],
  ["expired date", "Wed, 30 Sep 2026 19:59:59 GMT", 750, 0],
  ["body outlasts deadline", "2", 2_500, 0],
  ["malformed fallback", "not a date", 750, 1_000],
  ["forward wall jump", "2", 750, 1_250, 86_400_000],
  ["backward wall jump", "2", 750, 1_250, -86_400_000],
]) {
  test(`managed rejected SSE reconnect honors ${label} advice`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: RECEIVED });
    const clockNow = Date.now.bind(Date);
    let skew = 0;
    t.mock.method(Date, "now", () => clockNow() + skew);
    t.mock.method(performance, "now", () => clockNow() - RECEIVED);
    let calls = 0;
    const agent = Agent.open(agentId, { baseUrl, fetch: async () => {
      calls++;
      if (calls > 1) return eventResponse();
      const response = Response.json({ error: "server_error" }, { status: 503, headers: { "retry-after": header } });
      const json = response.json.bind(response);
      response.json = async () => { const body = await json(); t.mock.timers.tick(bodyDelay); skew = wallJump; return body; };
      return response;
    } });
    const events = agent.events.watch({ cursor: "0" });
    const pending = events.next();
    await flush();
    if (expected > 0) {
      assert.equal(calls, 1, "no reconnect before deadline");
      t.mock.timers.tick(expected - 1);
      await flush();
      assert.equal(calls, 1);
      t.mock.timers.tick(1);
      await flush();
    }
    assert.equal(calls, 2);
    assert.equal((await pending).value.cursor, "1");
    await events.return();
  });
}

test("large SSE retry deadline is chunked rather than overflowing a timer", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: RECEIVED });
    t.mock.method(performance, "now", () => Date.now() - RECEIVED);
  let calls = 0;
  const agent = Agent.open(agentId, { baseUrl, fetch: async () => {
    calls++;
    return calls === 1 ? Response.json({ error: "server_error" }, { status: 503, headers: { "retry-after": "2147484" } }) : eventResponse();
  } });
  const events = agent.events.watch({ cursor: "0" });
  const pending = events.next();
  await flush();
  t.mock.timers.tick(2_147_483_647);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(352);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  assert.equal((await pending).value.cursor, "1");
  await events.return();
});

for (const status of [429, 503]) {
  test(`terminal quota/usage/policy failures do not reconnect at HTTP ${status}`, async () => {
    for (const code of ["insufficient_quota", "usage_not_included", "cyber_policy", "misalignment_policy_violation", "bio_policy"]) {
      let calls = 0;
      const agent = Agent.open(agentId, { baseUrl, fetch: async () => {
        calls++;
        return Response.json({ error: code }, { status, headers: { "retry-after": "0" } });
      } });
      const events = agent.events.watch({ cursor: "0" });
      await assert.rejects(events.next(), { code, status });
      assert.equal(calls, 1);
      await events.return();
    }
  });
}

test("managed mutation errors expose receipt advice without adding retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: RECEIVED });
    t.mock.method(performance, "now", () => Date.now() - RECEIVED);
  let calls = 0;
  const agent = Agent.open(agentId, { baseUrl, fetch: async () => {
    calls++;
    const response = Response.json({ error: "insufficient_quota" }, { status: 429, headers: { "retry-after": "2" } });
    const json = response.json.bind(response);
    response.json = async () => { const body = await json(); t.mock.timers.tick(3_000); return body; };
    return response;
  } });
  await assert.rejects(agent.settings.update({ thinking: "low" }), (error) => {
    assert.equal(error.retry_after, 2);
    assert.equal(error.retry_after_deadline_ms, RECEIVED + 2_000);
    return true;
  });
  assert.equal(calls, 1);
});

test("structured terminal failures also veto HTTP reconnect", async () => {
  let calls = 0;
  const agent = Agent.open(agentId, { baseUrl, fetch: async () => {
    calls++;
    return Response.json({ error: { code: "usage_not_included" } }, { status: 503 });
  } });
  const events = agent.events.watch({ cursor: "0" });
  await assert.rejects(events.next(), { code: "usage_not_included", status: 503 });
  assert.equal(calls, 1);
  await events.return();
});

test("type-only terminal quota/policy failures veto rejected HTTP SSE reconnect", async () => {
  for (const code of ["insufficient_quota", "cyber_policy"]) {
    let calls = 0;
    const agent = Agent.open(agentId, { baseUrl, fetch: async () => {
      calls++;
      return Response.json({ error: { type: code } }, { status: 503, headers: { "retry-after": "0" } });
    } });
    const events = agent.events.watch({ cursor: "0" });
    await assert.rejects(events.next(), { code, status: 503 });
    assert.equal(calls, 1);
    await events.return();
  }
});

for (const [label, body, code] of [
  ["nested terminal type", { error: { code: "rate_limit_exceeded", type: "insufficient_quota" } }, "rate_limit_exceeded"],
  ["top-level transient code", { code: "rate_limit_exceeded", error: { type: "bio_policy" } }, "rate_limit_exceeded"],
  ["nested terminal response", { error: { code: "rate_limit_exceeded" }, response: { error: { code: "usage_not_included" } } }, "rate_limit_exceeded"],
]) {
  test(`conflicting discriminators cannot mask ${label} on managed SSE rejection`, async () => {
    let calls = 0;
    const agent = Agent.open(agentId, { baseUrl, fetch: async () => {
      calls++;
      return calls === 1 ? Response.json(body, { status: 503, headers: { "retry-after": "0" } }) : eventResponse();
    } });
    const events = agent.events.watch({ cursor: "0" });
    await assert.rejects(events.next(), { code, status: 503 });
    assert.equal(calls, 1);
    await events.return();
  });
}
