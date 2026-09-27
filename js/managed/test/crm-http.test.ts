import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import type { Principal } from "../src/account-auth";
import { routeCrmRequest } from "../src/crm-http";
import { crmRequest } from "../src/crm";
import { crmIdentityRequest } from "../src/crm-identities";
import { crmFactRequest, crmRelationshipRequest } from "../src/crm-context";

const bindings = env as unknown as { NANOCODEX_CRM: D1Database; CRM_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const owner: Principal = { kind: "api_key", userId: "crm-http-owner", organizationId: "example-org", teamId: "example-team", role: "owner", subjectId: "user:crm-http-owner", credentialId: "example-key", authorizationEpoch: 1, capabilities: ["agents:read", "tools:use"] };
const other = { ...owner, userId: "crm-http-other" };
const call = (path: string, principal: Principal | null = owner, method = "GET", db: D1Database | undefined = bindings.NANOCODEX_CRM) => routeCrmRequest(new Request(`https://example.test/v1/crm${path}`, { method }), db, principal);
beforeAll(async () => { await applyD1Migrations(bindings.NANOCODEX_CRM, bindings.CRM_MIGRATIONS); });

it("rejects unauthorized, Connect and write requests before reading storage", async () => {
  expect((await call("", null)).status).toBe(401);
  expect((await call("", { ...owner, kind: "connect_grant" })).status).toBe(403);
  expect((await call("", { ...owner, connectGrant: {} } as Principal)).status).toBe(403);
  expect((await call("", { ...owner, capabilities: ["agents:read"] })).status).toBe(403);
  expect((await call("", owner, "POST")).status).toBe(405);
  expect((await routeCrmRequest(new Request("https://example.test/v1/crm"), undefined, owner)).status).toBe(503);
});

it("browses synthetic profiles and independently pages notes, identities, facts and relationships without crossing owners", async () => {
  const db = bindings.NANOCODEX_CRM;
  await crmRequest(db, owner.userId, "save", { kind: "company", name: "Example Company" }, "http-company");
  await crmRequest(db, owner.userId, "save", { kind: "person", name: "Example Person" }, "http-person");
  for (let i = 0; i < 2; i++) {
    await crmRequest(db, owner.userId, "save_note", { record_id: "http-person", body: `Note ${i}` }, `http-note-${i}`);
    await crmIdentityRequest(db, owner.userId, "save", { record_id: "http-person", kind: "aka", value: `Example ${i}`, origin: "user" }, `http-identity-${i}`);
    await crmFactRequest(db, owner.userId, "save", { record_id: "http-person", predicate: `bio.fact_${i}`, value: `Value ${i}`, origin: "user" }, `http-fact-${i}`);
    await crmRelationshipRequest(db, owner.userId, "save", { from_id: "http-person", to_id: "http-company", type: i ? "worked_at" : "works_at", description: `Employment context ${i}`, origin: "user" }, `http-link-${i}`);
  }
  const search = await (await call("?limit=1")).json() as any;
  expect(search.records).toHaveLength(1);
  expect((await (await call(`?limit=1&cursor=${encodeURIComponent(search.next_cursor)}`)).json() as any).records).toHaveLength(1);
  expect((await call(`?cursor=${encodeURIComponent(search.next_cursor)}`, other)).status).toBe(400);
  expect((await (await call("", other)).json() as any).records).toEqual([]);
  const filtered = await (await call("?q=Person&kind=person")).json() as any;
  expect(filtered.records.map((row: { id: string }) => row.id)).toEqual(["http-person"]);
  expect((await (await call("?q=Company&kind=company")).json() as any).records.map((row: { id: string }) => row.id)).toEqual(["http-company"]);
  expect((await (await call("?q=NoSuchSyntheticName&kind=company")).json() as any).records).toEqual([]);
  const detail = await (await call("/http-person?notes_limit=1")).json() as any;
  expect(detail.record.name).toBe("Example Person");
  expect(detail.identities).toHaveLength(2);
  expect(detail.facts).toHaveLength(2);
  expect(detail.relationships).toHaveLength(2);
  expect(detail.relationships.map((row: { description: string }) => row.description).sort()).toEqual(["Employment context 0", "Employment context 1"]);
  expect(detail.relationships[0]).toMatchObject({ from_name: "Example Person", to_name: "Example Company" });
  expect(detail.notes).toHaveLength(1);
  const nextNotes = await (await call(`/http-person?notes_limit=1&notes_cursor=${encodeURIComponent(detail.next_cursor)}`)).json() as any;
  expect(nextNotes.notes[0].id).not.toBe(detail.notes[0].id);
  for (const section of ["identities", "facts", "relationships"]) {
    const first = await (await call(`/http-person/${section}?limit=1`)).json() as any;
    const last = await (await call(`/http-person/${section}?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`)).json() as any;
    expect(first[section]).toHaveLength(1);
    expect(last[section]).toHaveLength(1);
    expect(last[section][0].id).not.toBe(first[section][0].id);
    expect(last.next_cursor).toBeNull();
    if (section === "relationships") expect(last.relationships[0]).toMatchObject({ from_name: "Example Person", to_name: "Example Company" });
    expect((await call(`/http-person/${section}`, other)).status).toBe(404);
  }
  expect((await call("/http-person", other)).status).toBe(404);
  for (const query of ["?owner_id=crm-http-owner", "?limit=0", "?limit=abc", "?cursor=bad", "?limit=1&limit=2"]) expect((await call(query)).status).toBe(400);
  expect((await call("/http-person/unknown")).status).toBe(404);
  expect((await call("/http-person")).headers.get("cache-control")).toBe("no-store");
});
