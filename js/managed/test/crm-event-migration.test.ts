import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
const bindings = env as unknown as { NANOCODEX_CRM: D1Database; CRM_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

// Migration failure scenario: rebuilding participation must retain old IDs,
// assertions, provenance, timestamps, foreign keys and date-only history.
it("upgrades populated legacy event graphs without losing assertions or date precision", async () => {
 const db = bindings.NANOCODEX_CRM;
 const migrations = bindings.CRM_MIGRATIONS;
 const split = migrations.findIndex(m => m.name.startsWith("0009"));
 expect(split).toBeGreaterThan(0);
 await applyD1Migrations(db, migrations.slice(0, split));
 await db.prepare("INSERT INTO crm_records(owner_id,id,kind,name,created_at,updated_at) VALUES ('legacy','company','company','Synthetic',1,2)").run();
 await db.prepare("INSERT INTO crm_events(owner_id,id,title,start_at,start_ms,end_at,end_ms,origin,sources,created_at,updated_at) VALUES ('legacy','event','Synthetic','2026-01-02T12:00:00Z',1767355200000,'2026-01-02T13:00:00Z',1767358800000,'user','[]',3,4)").run();
 await db.prepare("INSERT INTO crm_event_participation(owner_id,id,event_id,record_id,person_id,status,role,origin,sources,confidence,rationale,created_at,updated_at) VALUES ('legacy','assertion','event','company',NULL,'expected','organizer','inferred','[{\"kind\":\"document\",\"reference\":\"synthetic.md\"}]','medium','Synthetic rationale',5,6)").run();
 await db.prepare("INSERT INTO crm_interactions(owner_id,id,event_id,occurred_at,occurred_ms,precision,body,origin,sources,created_at,updated_at) VALUES ('legacy','interaction','event','2026-01-02',1767312000000,'date','Synthetic observation','user','[]',7,8)").run();
 const legacy = await db.prepare("SELECT * FROM crm_event_participation").first();
 await applyD1Migrations(db, migrations);
 expect(await db.prepare("SELECT * FROM crm_event_participation").first()).toEqual({ ...legacy, metadata: "{}" });
 expect(await db.prepare("SELECT start_precision,end_precision,metadata FROM crm_events").first()).toEqual({ start_precision: "datetime", end_precision: "datetime", metadata: "{}" });
 expect(await db.prepare("SELECT occurred_at,occurred_precision,metadata FROM crm_interactions").first()).toEqual({ occurred_at: "2026-01-02", occurred_precision: "date", metadata: "{}" });
 await db.prepare("UPDATE crm_event_participation SET role='sponsor' WHERE id='assertion'").run();
 await expect(db.prepare("UPDATE crm_event_participation SET origin='user' WHERE id='assertion'").run()).rejects.toThrow();
 await db.prepare("DELETE FROM crm_events WHERE owner_id='legacy' AND id='event'").run();
 expect(await db.prepare("SELECT * FROM crm_event_participation").first()).toBeNull();
 expect(await db.prepare("SELECT event_id,body FROM crm_interactions").first()).toEqual({ event_id: null, body: "Synthetic observation" });
});
