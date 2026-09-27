import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { crmTools, type CrmAuthorization } from "../src/crm-tools";
import { importCalendarEvents } from "../src/crm-meetings";

// Defined before implementation. Real D1 tool journeys cover revoked authority,
// Connect isolation, statement-based relationships, connectivity without inference,
// stable legacy anchors, protected projections, and editable native graph nodes.
const bindings = env as unknown as { NANOCODEX_CRM: D1Database; CRM_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.NANOCODEX_CRM;
beforeAll(async () => { await applyD1Migrations(db, bindings.CRM_MIGRATIONS); });
const full = { capabilities: ["agents:read", "agents:write", "tools:use"] };
const context = () => ({ callId: crypto.randomUUID(), parentCallId: "", sessionId: "graph-session", model: "test", signal: new AbortController().signal });
const setup = (ownerId = crypto.randomUUID(), authorization: () => CrmAuthorization | undefined = () => full) => {
  const tools = crmTools({ db, ownerId, authorization });
  const run = (name: string, input: unknown) => tools.find(t => t.name === name)!.handler(input, context()) as Promise<any>;
  return { run, graph: (operation: string, input: object = {}) => run("crm_graph", { operation, ...input }) };
};

it("stores friendship and family as statements and explains graph connectivity", async () => {
  const { graph } = setup();
  const alex = (await graph("save", { text: "Alex Sample" })).node;
  const sam = (await graph("save", { text: "Sam Example" })).node;
  const lee = (await graph("save", { text: "Lee Example" })).node;
  const friendship = (await graph("save", { text: "Alex and Sam are friends", metadata: { origin: "user", occurred_at: "2026-02", sources: [{ kind: "user", reference: "User statement" }] } })).node;
  const family = (await graph("save", { text: "Sam and Lee are siblings", metadata: { origin: "user", occurred_at: "2025" } })).node;
  for (const [from_id, to_id] of [[alex.id, friendship.id], [sam.id, friendship.id], [sam.id, family.id], [lee.id, family.id]]) await graph("link_save", { from_id, to_id });
  await graph("link_save", { from_id: friendship.id, to_id: alex.id });
  expect((await graph("links", { id: alex.id })).links).toEqual([{ from_id: [alex.id, friendship.id].sort()[0], to_id: [alex.id, friendship.id].sort()[1] }]);
  const path = await graph("path", { from_id: alex.id, to_id: lee.id, max_depth: 5 });
  expect(path.found).toBe(true);
  expect(path.nodes.map((node: any) => node.id)).toEqual([alex.id, friendship.id, sam.id, family.id, lee.id]);
  expect(path.relationship_inference).toBe(false);
  expect((await graph("search", { q: "siblings" })).nodes.map((node: any) => node.id)).toEqual([family.id]);
  await graph("save", { id: friendship.id, text: "Alex and Sam have been friends since school" });
  expect((await graph("get", { id: friendship.id })).node.metadata.occurred_at).toBe("2026-02");
  const timeline = await graph("timeline", { id: sam.id });
  expect(timeline.nodes.map((node: any) => [node.id, node.metadata.occurred_at])).toEqual([[family.id, "2025"], [friendship.id, "2026-02"]]);
  expect((await graph("neighbors", { id: alex.id })).nodes.map((node: any) => node.id)).toContain(friendship.id);
  await graph("link_delete", { from_id: alex.id, to_id: friendship.id });
  expect((await graph("path", { from_id: alex.id, to_id: lee.id, max_depth: 5 })).found).toBe(false);
  await graph("delete", { id: friendship.id });
  await expect(graph("get", { id: friendship.id })).rejects.toThrow();
});

it("anchors existing CRM records without allowing projected nodes to be edited", async () => {
  const { run, graph } = setup();
  const { record } = await run("crm_save", { kind: "person", name: "Legacy anchor" });
  const anchor = `legacy:crm_records:${JSON.stringify([record.id])}`;
  expect((await run("crm_get", { id: record.id })).record.graph_node_id).toBe(anchor);
  expect((await run("crm_search", { q: "Legacy anchor" })).records[0].graph_node_id).toBe(anchor);
  expect((await graph("get", { id: anchor })).node.text).toContain("Legacy anchor");
  const statement = (await graph("save", { text: "Legacy anchor is my friend" })).node;
  await graph("link_save", { from_id: anchor, to_id: statement.id });
  expect((await graph("path", { from_id: anchor, to_id: statement.id })).found).toBe(true);
  await expect(graph("save", { id: anchor, text: "Overwrite" })).rejects.toThrow();
  await expect(graph("delete", { id: anchor })).rejects.toThrow();
  expect((await run("crm_get", { id: record.id })).record.name).toBe("Legacy anchor");
});

it("rechecks account authority and denies Connect and cross-account access", async () => {
  let authorization: CrmAuthorization | undefined = full;
  const { graph } = setup(crypto.randomUUID(), () => authorization);
  const node = (await graph("save", { text: "Private graph" })).node;
  const stranger = setup();
  expect((await stranger.graph("search", { q: "Private graph" })).nodes).toEqual([]);
  await expect(stranger.graph("get", { id: node.id })).rejects.toThrow();
  authorization = { capabilities: ["agents:read", "tools:use"] };
  expect((await graph("get", { id: node.id })).node.id).toBe(node.id);
  for (const operation of ["save", "delete", "link_save", "link_delete"]) await expect(graph(operation, { id: node.id })).rejects.toThrow(/authoriz|forbidden|requires/i);
  for (const denied of [undefined, { capabilities: ["agents:read", "agents:write"] }, { ...full, connectGrant: {} }]) {
    authorization = denied;
    for (const operation of ["search", "get", "save", "delete", "links", "link_save", "link_delete", "neighbors", "path", "timeline"]) await expect(graph(operation)).rejects.toThrow(/authoriz|forbidden|requires/i);
  }
  authorization = full;
  await expect(graph("search", { owner_id: "other-account" })).rejects.toThrow();
  await expect(graph("save", { text: "Forbidden typed node", type: "person" })).rejects.toThrow();
  await expect(graph("link_save", { from_id: node.id, to_id: node.id, label: "friend" })).rejects.toThrow();
});

// Refresh must preserve a retained attendee anchor, but reusing its ordinal for
// another identity must remove the prior attendee's native graph assertions.
it("preserves attendee graph links across refresh without transferring them to a replacement", async () => {
  const ownerId = crypto.randomUUID();
  const { run, graph } = setup(ownerId);
  const event = {
    id: "attendee-anchor-refresh", status: "confirmed", summary: "Synthetic planning",
    updated: "2026-03-01T00:00:00Z",
    start: { dateTime: "2026-03-05T10:00:00Z" }, end: { dateTime: "2026-03-05T11:00:00Z" },
    organizer: { email: "owner@example.test", self: true },
    attendees: [{ email: "alex@example.test", displayName: "Alex Sample", responseStatus: "accepted" }],
  };
  const refresh = (snapshot: typeof event) => importCalendarEvents(db, ownerId, {
    connection_id: "synthetic-google", calendar_id: "primary", events: [snapshot],
  }, Date.parse("2026-03-06T00:00:00Z"));
  expect(await refresh(event)).toMatchObject({ imported: 1 });
  const meeting = (await run("crm_meetings", { operation: "list" })).meetings[0];
  const anchor = `legacy:crm_meeting_attendees:${JSON.stringify([meeting.id, 0])}`;
  expect((await graph("get", { id: anchor })).node.metadata.legacy.email).toBe("alex@example.test");
  const statement = (await graph("save", { text: "Alex volunteered to bring a prototype", metadata: { origin: "user" } })).node;
  await graph("link_save", { from_id: anchor, to_id: statement.id });
  const edge = { from_id: [anchor, statement.id].sort()[0], to_id: [anchor, statement.id].sort()[1] };
  expect((await graph("links", { id: statement.id })).links).toContainEqual(edge);

  expect(await refresh({ ...event, updated: "2026-03-02T00:00:00Z", summary: "Updated planning title" })).toMatchObject({ imported: 1 });
  expect((await graph("links", { id: statement.id })).links).toContainEqual(edge);
  expect((await graph("get", { id: anchor })).node.metadata.legacy.email).toBe("alex@example.test");

  expect(await refresh({ ...event, updated: "2026-03-03T00:00:00Z", attendees: [
    { email: "sam@example.test", displayName: "Sam Example", responseStatus: "accepted" },
  ] })).toMatchObject({ imported: 1 });
  expect((await graph("get", { id: anchor })).node.metadata.legacy.email).toBe("sam@example.test");
  expect((await graph("links", { id: statement.id })).links).toEqual([]);
  expect((await graph("get", { id: statement.id })).node.text).toBe("Alex volunteered to bring a prototype");
});

// Provider ordering is not attendee identity: an email-matched attendee keeps
// its original graph anchor when the incoming guest array is reordered.
it("keeps graph assertions attached to the same attendee when provider order changes", async () => {
  const ownerId = crypto.randomUUID();
  const { run, graph } = setup(ownerId);
  const alex = { email: "alex-order@example.test", displayName: "Alex Order", responseStatus: "accepted" };
  const sam = { email: "sam-order@example.test", displayName: "Sam Order", responseStatus: "accepted" };
  const event = {
    id: "attendee-order-refresh", status: "confirmed", summary: "Synthetic reorder",
    updated: "2026-04-01T00:00:00Z",
    start: { dateTime: "2026-04-05T10:00:00Z" }, end: { dateTime: "2026-04-05T11:00:00Z" },
    organizer: { email: "owner@example.test", self: true }, attendees: [alex, sam],
  };
  const refresh = (snapshot: typeof event) => importCalendarEvents(db, ownerId, {
    connection_id: "synthetic-google", calendar_id: "primary", events: [snapshot],
  }, Date.parse("2026-04-06T00:00:00Z"));
  expect(await refresh(event)).toMatchObject({ imported: 1 });
  const meeting = (await run("crm_meetings", { operation: "list" })).meetings[0];
  const anchor = `legacy:crm_meeting_attendees:${JSON.stringify([meeting.id, 0])}`;
  const original = (await graph("get", { id: anchor })).node;
  expect(original.metadata.legacy.email).toBe(alex.email);
  const personAnchor = `legacy:crm_records:${JSON.stringify([original.metadata.legacy.person_id])}`;
  const statement = (await graph("save", { text: "Alex will share the design" })).node;
  await graph("link_save", { from_id: statement.id, to_id: anchor });
  const statementEdge = { from_id: [anchor, statement.id].sort()[0], to_id: [anchor, statement.id].sort()[1] };
  const personEdge = { from_id: [anchor, personAnchor].sort()[0], to_id: [anchor, personAnchor].sort()[1] };

  expect(await refresh({ ...event, updated: "2026-04-02T00:00:00Z", attendees: [sam, alex] })).toMatchObject({ imported: 1 });
  const retained = (await graph("get", { id: anchor })).node;
  expect(retained.metadata.legacy.email).toBe(alex.email);
  expect(retained.metadata.legacy.person_id).toBe(original.metadata.legacy.person_id);
  expect((await graph("links", { id: anchor })).links).toEqual(expect.arrayContaining([statementEdge, personEdge]));
});
