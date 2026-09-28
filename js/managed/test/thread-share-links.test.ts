import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker, { type DurableAgentSession } from "../src/index";
import type { Principal } from "../src/account-auth";
import { DurableEventLog } from "../src/durable-events";

const owner: Principal = {
  kind: "account_session", userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "owner", subjectId: "user:11111111-1111-4111-8111-111111111111", credentialId: "test-owner",
  authorizationEpoch: 1, capabilities: ["agents:read", "agents:write", "tools:use"],
};
const other: Principal = { ...owner, userId: "22222222-2222-4222-8222-222222222222", subjectId: "user:22222222-2222-4222-8222-222222222222" };
let id = crypto.randomUUID();
let secondId = crypto.randomUUID();
const sessions = () => (env as unknown as { NANOCODEX_SESSIONS: DurableObjectNamespace<DurableAgentSession> }).NANOCODEX_SESSIONS;
const api = (path: string, method = "GET", actor?: Principal, body?: unknown, token?: string, origin?: string) =>
  worker.fetch(new Request(`https://nanocodex.example${path}`, {
    method, headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(origin === undefined ? {} : { origin }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env as Parameters<typeof worker.fetch>[1], createExecutionContext(), actor);

async function seed(agentId = id) {
  await runInDurableObject(sessions().getByName(agentId), async (_, state) => {
    state.storage.sql.exec(`INSERT INTO session_state
      (singleton, session_id, owner_id, organization_id, team_id, authorization_epoch, public_origin, runtime_profile, last_active)
      VALUES (1,?,?,?,?,1,'https://nanocodex.example','managed',?)`,
      agentId, owner.userId, owner.organizationId, owner.teamId, Date.now());
    const log = new DurableEventLog<{ type: string; [key: string]: unknown }>(state.storage);
    log.record({ type: "turn_accepted", id: "synthetic-turn", input: "synthetic hello", replayed: false, hidden: "SECRET_ACCEPTED_METADATA" }, "synthetic-turn");
    log.record({ type: "event", event: { type: "tool.result", payload: { call_id: "synthetic-tool", result: "SECRET_TOOL_OUTPUT", secret: "HIDDEN_TOOL_METADATA" } } }, "synthetic-turn");
    log.record({ type: "turn_completed", id: "synthetic-turn", final_message: "synthetic answer", usage: { secret: "SECRET_USAGE" } }, "synthetic-turn");
  });
}

it("owner issues scoped bearer links, normal transcript projection and immediate revocation", async () => {
  id = crypto.randomUUID(); secondId = crypto.randomUUID(); await seed(); await seed(secondId);
  const path = `/v1/agents/${id}/share-links`;
  expect((await api(path, "POST", other, { permission: "read" }, undefined, "https://nanocodex.example")).status).toBe(404);
  expect((await api(path, "POST", { ...owner, connectGrant: { grantId: `0x${"a".repeat(64)}`, connectors: ["chatgpt"], mcpIds: [] } }, { permission: "read" }, undefined, "https://nanocodex.example")).status).toBe(403);
  expect((await api(path, "POST", owner, { permission: "admin" }, undefined, "https://nanocodex.example")).status).toBe(400);
  expect((await api(path, "POST", owner, { permission: "read" }, undefined, "https://other.example")).status).toBe(403);
  const created = await api(path, "POST", owner, { permission: "read" }, undefined, "https://nanocodex.example");
  expect(created.status).toBe(201);
  const link = await created.json<{ id: string; permission: string; url: string }>();
  const token = new URL(link.url).hash.slice("#token=".length);
  expect(token).toMatch(/^nsl_[A-Za-z0-9_-]{43}$/);
  expect(link.permission).toBe("read");
  const listed = await (await api(path, "GET", owner)).json<{ data: unknown[] }>();
  expect(listed.data).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain(token);
  expect((await api(`/v1/shared/${id}`, "GET", undefined, undefined, token)).status).toBe(200);
  const history = await api(`/v1/shared/${id}/events/history`, "GET", undefined, undefined, token);
  const page = await history.json<{ data: unknown[] }>();
  expect(page.data).toHaveLength(3);
  expect(JSON.stringify(page)).toContain("SECRET_TOOL_OUTPUT");
  expect(JSON.stringify(page)).not.toContain("SECRET_USAGE");
  expect(JSON.stringify(page)).not.toContain("HIDDEN_TOOL_METADATA");
  expect(JSON.stringify(page)).not.toContain("SECRET_ACCEPTED_METADATA");
  expect(page.data).toEqual([
    expect.objectContaining({ type: "turn_accepted", id: "synthetic-turn", input: "synthetic hello" }),
    expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "tool.result" }) }),
    expect.objectContaining({ type: "turn_completed", id: "synthetic-turn", final_message: "synthetic answer" }),
  ]);
  expect(Object.keys(page.data[0] as object).sort()).toEqual(["created_at", "cursor", "id", "input", "turn_id", "type"]);
  expect(Object.keys(page.data[2] as object).sort()).toEqual(["created_at", "cursor", "final_message", "id", "turn_id", "type"]);
  expect((await api(`/v1/shared/${id}/turns`, "POST", undefined, { id: "read-denied", input: "forbidden" }, token, "https://nanocodex.example")).status).toBe(403);
  expect((await api(`/v1/shared/${id}?token=${token}`)).status).toBe(404);
  expect(history.headers.get("cache-control")).toBe("no-store");
  const newest = await (await api(`/v1/shared/${id}/events/history?limit=1`, "GET", undefined, undefined, token)).json<{
    data: { type: string }[]; has_more: boolean; next_cursor: string;
  }>();
  expect(newest.data.map(event => event.type)).toEqual(["turn_completed"]);
  const hiddenOnly = await (await api(`/v1/shared/${id}/events/history?limit=1&before=${newest.next_cursor}`, "GET", undefined, undefined, token)).json<{
    data: unknown[]; has_more: boolean; next_cursor: string;
  }>();
  expect(hiddenOnly.data).toHaveLength(1);
  expect(hiddenOnly.has_more).toBe(true);
  const oldest = await (await api(`/v1/shared/${id}/events/history?limit=1&before=${hiddenOnly.next_cursor}`, "GET", undefined, undefined, token)).json<{
    data: { type: string }[];
  }>();
  expect(oldest.data.map(event => event.type)).toEqual(["turn_accepted"]);
  expect((await api(`/v1/shared/${secondId}`, "GET", undefined, undefined, token)).status).toBe(404);
  expect((await api(`/v1/shared/${id}/turns`, "POST", undefined, { id: "guest-test", input: "hello" }, token, "https://nanocodex.example")).status).toBe(403);
  expect((await api(`/v1/agents/${id}/settings`, "PATCH", undefined, {}, token, "https://nanocodex.example")).status).not.toBe(200);
  expect((await api(`${path}/${link.id}`, "DELETE", owner, undefined, undefined, "https://nanocodex.example")).status).toBe(204);
  expect((await api(`/v1/shared/${id}`, "GET", undefined, undefined, token)).status).toBe(404);
});

it("an owner API key can administer thread links from the TUI but no other key or delegated grant can", async () => {
  id = crypto.randomUUID(); await seed();
  const path = `/v1/agents/${id}/share-links`;
  const key: Principal = { ...owner, kind: "api_key", subjectId: `api_key:${crypto.randomUUID()}`, credentialId: "test-api-key" };
  expect((await api(path, "POST", { ...key, capabilities: ["agents:read"] }, { permission: "read" })).status).toBe(403);
  expect((await api(path, "POST", { ...key, connectGrant: { grantId: `0x${"a".repeat(64)}`, connectors: ["chatgpt"], mcpIds: [] } }, { permission: "read" })).status).toBe(403);
  expect((await api(path, "POST", { ...key, userId: other.userId }, { permission: "read" })).status).toBe(404);
  const created = await api(path, "POST", key, { permission: "read" });
  expect(created.status).toBe(201);
  const link = await created.json<{ id: string; url: string }>();
  expect(link.url).toMatch(new RegExp(`^https://nanocodex.example/share/${id}#token=nsl_`));
  expect((await api(path, "GET", key)).status).toBe(200);
  expect((await api(`${path}/${link.id}`, "DELETE", key)).status).toBe(204);
  expect((await api(`/v1/shared/${id}`, "GET", undefined, undefined, new URL(link.url).hash.slice(7))).status).toBe(404);
});

it("write link admits real owner-thread turns, isolates identities, limits abuse and revokes immediately", async () => {
  id = crypto.randomUUID(); await seed();
  const path = `/v1/agents/${id}/share-links`;
  const created = await api(path, "POST", owner, { permission: "write" }, undefined, "https://nanocodex.example");
  const { id: linkId, url } = await created.json<{ id: string; url: string }>();
  const token = new URL(url).hash.slice(7);
  const turns = `/v1/shared/${id}/turns`;
  expect((await api(turns, "POST", undefined, { id: "guest-turn", input: "hello" }, token, "https://other.example")).status).toBe(403);
  expect((await api(turns, "POST", undefined, { id: "guest-turn", input: "  " }, token, "https://nanocodex.example")).status).toBe(400);
  expect((await api(turns, "POST", undefined, { id: "guest-turn", input: "hello", role: "assistant" }, token, "https://nanocodex.example")).status).toBe(400);
  expect((await api(turns, "POST", undefined, { id: "oversized", input: "a".repeat(33_000) }, token, "https://nanocodex.example")).status).toBe(413);
  const posted = await api(turns, "POST", undefined, { id: "guest-turn", input: "hello" }, token, "https://nanocodex.example");
  expect(posted.status).toBe(202);
  expect(await posted.json()).toMatchObject({ turn_id: "guest-turn" });
  await runInDurableObject(sessions().getByName(id), async (_, state) => {
    const row = state.storage.sql.exec<{ authorization_json: string }>(
      "SELECT authorization_json FROM managed_turns WHERE id = 'guest-turn'").one();
    expect(JSON.parse(row.authorization_json)).toMatchObject({ guestShareLinkId: linkId,
      connectGrant: { connectors: ["chatgpt"], mcpIds: [] } });
    expect(state.storage.sql.exec("SELECT * FROM managed_share_turn_admissions WHERE turn_id = 'guest-turn'").toArray()).toHaveLength(1);
  });
  const replay = await api(turns, "POST", undefined, { id: "guest-turn", input: "hello" }, token, "https://nanocodex.example");
  expect(replay.status).toBe(200);
  expect((await api(turns, "POST", undefined, { id: "guest-turn", input: "different" }, token, "https://nanocodex.example")).status).toBe(409);
  const second = await api(path, "POST", owner, { permission: "write" }, undefined, "https://nanocodex.example");
  const secondToken = new URL((await second.json<{ url: string }>()).url).hash.slice(7);
  expect((await api(turns, "POST", undefined, { id: "guest-turn", input: "hello" }, secondToken, "https://nanocodex.example")).status).toBe(403);
  // Rate-limit state is retained on the same Durable Object and never counts a replay.
  await runInDurableObject(sessions().getByName(id), async (_, state) => {
    for (let i = 0; i < 19; i++) state.storage.sql.exec(
      "INSERT INTO managed_share_turn_admissions(turn_id,link_id,admitted_at) VALUES(?,?,?)", `prior-${i}`, linkId, Date.now());
  });
  expect((await api(turns, "POST", undefined, { id: "limited", input: "hello" }, token, "https://nanocodex.example")).status).toBe(429);
  expect((await api(turns, "POST", undefined, { id: "guest-turn", input: "hello" }, token, "https://nanocodex.example")).status).toBe(200);
  expect((await api(`${path}/${linkId}`, "DELETE", owner, undefined, undefined, "https://nanocodex.example")).status).toBe(204);
  expect((await api(turns, "POST", undefined, { id: "guest-turn", input: "hello" }, token, "https://nanocodex.example")).status).toBe(404);
  expect((await api(turns, "POST", undefined, { id: "another", input: "hello" }, token, "https://nanocodex.example")).status).toBe(404);
  expect((await api(`/v1/shared/${id}/comments`, "GET", undefined, undefined, secondToken)).status).toBe(404);
});

it("streams only safe guest transcript events and closes the feed when its link is revoked", async () => {
  id = crypto.randomUUID(); await seed();
  // A real final-answer delta and an unrelated tool event share the durable log.
  await runInDurableObject(sessions().getByName(id), async (_, state) => {
    const log = new DurableEventLog<{ type: string; [key: string]: unknown }>(state.storage);
    log.record({ type: "event", event: { type: "assistant.delta", payload: {
      phase: "final_answer", text: "safe live token", hidden: "SECRET_DELTA_METADATA",
    } } }, "synthetic-turn");
    log.record({ type: "event", event: { type: "reasoning.summary.delta", payload: { text: "SECRET_REASONING" } } }, "synthetic-turn");
  });
  const path = `/v1/agents/${id}/share-links`;
  const created = await api(path, "POST", owner, { permission: "read" }, undefined, "https://nanocodex.example");
  expect(created.status).toBe(201);
  const link = await created.json<{ id: string; url: string }>();
  const token = new URL(link.url).hash.slice(7);
  expect((await api(`/v1/shared/${id}/events?after=invalid`, "GET", undefined, undefined, token)).status).toBe(400);
  expect((await api(`/v1/shared/${secondId}/events?after=0`, "GET", undefined, undefined, token)).status).toBe(404);
  const stream = await api(`/v1/shared/${id}/events?after=0`, "GET", undefined, undefined, token);
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  const reader = stream.body!.getReader();
  let transcript = "";
  for (let index = 0; index < 12 && !transcript.includes("SECRET_REASONING"); index++) {
    const next = await reader.read();
    if (next.done) break;
    transcript += new TextDecoder().decode(next.value);
  }
  expect(transcript).toContain('event: turn_accepted');
  expect(transcript).toContain('event: turn_completed');
  expect(transcript).toContain('event: event');
  expect(transcript).toContain('"text":"safe live token"');
  expect(transcript).toContain("SECRET_TOOL_OUTPUT");
  expect(transcript).toContain("SECRET_REASONING");
  expect(transcript).not.toMatch(/SECRET_USAGE|SECRET_ACCEPTED_METADATA|nsl_/);
  // Anonymous guests are capped below the owner's stream capacity.
  const otherStreams: Response[] = [];
  for (let index = 0; index < 15; index++) {
    const next = await api(`/v1/shared/${id}/events?after=5`, "GET", undefined, undefined, token);
    expect(next.status).toBe(200);
    otherStreams.push(next);
  }
  const overLimit = await api(`/v1/shared/${id}/events?after=5`, "GET", undefined, undefined, token);
  expect(overLimit.status).toBe(429);
  expect(await overLimit.json()).toMatchObject({ error: "event_stream_limit", limit: 16 });
  const ownerFeed = await api(`/v1/agents/${id}/events?after=5`, "GET", owner);
  expect(ownerFeed.status).toBe(200);
  await ownerFeed.body?.cancel();
  expect((await api(`${path}/${link.id}`, "DELETE", owner, undefined, undefined, "https://nanocodex.example")).status).toBe(204);
  for (const feed of otherStreams) await feed.body?.cancel().catch(() => {});
  const closed = await reader.read().catch(() => ({ done: true }));
  expect(closed.done).toBe(true);
  expect((await api(`/v1/shared/${id}/events?after=0`, "GET", undefined, undefined, token)).status).toBe(404);
});
