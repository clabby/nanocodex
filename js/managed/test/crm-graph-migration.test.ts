import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
const bindings = env as unknown as { NANOCODEX_CRM: D1Database; CRM_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const legacyId = (table: string, ...keys: unknown[]) => `legacy:${table}:${JSON.stringify(keys)}`;

// Failure scenarios: populated upgrades lose provenance or conflate same IDs;
// legacy updates stop projecting; deletes leave dangling edges; owner boundaries
// leak; graph-native links disappear on a legacy text update.
it("preserves populated legacy assertions and keeps integration writes synchronized", async () => {
 const db = bindings.NANOCODEX_CRM;
 const migrations = bindings.CRM_MIGRATIONS;
 const split = migrations.findIndex(m => m.name.startsWith("0010"));
 expect(split).toBeGreaterThan(0);
 await applyD1Migrations(db, migrations.slice(0, split));
 await db.prepare("INSERT INTO crm_records(owner_id,id,kind,name,created_at,updated_at) VALUES ('owner','same','person','Synthetic Ada',1,2),('owner','company','company','Synthetic Labs',1,2),('other','same','person','Other',1,2)").run();
 await db.prepare("INSERT INTO crm_notes(owner_id,id,record_id,body,source_url,created_at,updated_at) VALUES ('owner','same','same','Original note','https://example.com/source',3,4)").run();
 await db.prepare(`INSERT INTO crm_relationships(owner_id,id,from_id,to_id,type,role,origin,sources,created_at,updated_at) VALUES ('owner','same','same','company','worked_at','Engineer','source','[{"kind":"web","reference":"https://example.com/history"}]',5,6)`).run();
 const original = await db.prepare("SELECT * FROM crm_relationships").first();
 await applyD1Migrations(db, migrations);
 expect(await db.prepare("SELECT * FROM crm_relationships").first()).toEqual(original);
 const relationship = await db.prepare("SELECT * FROM crm_nodes WHERE owner_id='owner' AND id=?").bind(legacyId("crm_relationships", "same")).first<{ text: string; metadata: string }>();
 expect(relationship?.text).toContain("worked at");
 expect(JSON.parse(relationship!.metadata).legacy).toEqual(original);
 expect((await db.prepare("SELECT * FROM crm_links WHERE owner_id='owner'").all()).results).toHaveLength(3);
 await db.prepare("INSERT INTO crm_nodes(owner_id,id,text,metadata,created_at,updated_at) VALUES ('owner','arbitrary-id','Native thought','{}',7,7)").run();
 const recordId = legacyId("crm_records", "same");
 await db.prepare("INSERT INTO crm_links(owner_id,from_id,to_id,created_at,updated_at) VALUES ('owner','arbitrary-id',?,7,7)").bind(recordId).run();
 await db.prepare("UPDATE crm_records SET name='Renamed',updated_at=8 WHERE owner_id='owner' AND id='same'").run();
 expect(await db.prepare("SELECT text FROM crm_nodes WHERE owner_id='owner' AND id=?").bind(recordId).first()).toEqual({ text: "Renamed" });
 expect(await db.prepare("SELECT count(*) AS n FROM crm_links WHERE owner_id='owner' AND from_id='arbitrary-id'").first()).toEqual({ n: 1 });
 await db.prepare("UPDATE crm_notes SET body='Edited note',updated_at=9 WHERE owner_id='owner'").run();
 expect(await db.prepare("SELECT text FROM crm_nodes WHERE owner_id='owner' AND id=?").bind(legacyId("crm_notes", "same")).first()).toEqual({ text: "Edited note" });
 await expect(db.prepare("INSERT INTO crm_links(owner_id,from_id,to_id,created_at,updated_at) VALUES ('other','arbitrary-id',?,1,1)").bind(recordId).run()).rejects.toThrow();
 await db.prepare("DELETE FROM crm_records WHERE owner_id='owner' AND id='same'").run();
 expect(await db.prepare("SELECT count(*) AS n FROM crm_links WHERE owner_id='owner'").first()).toEqual({ n: 0 });
 expect(await db.prepare("SELECT text FROM crm_nodes WHERE owner_id='other'").first()).toEqual({ text: "Other" });
 expect(await db.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
});

// Failure scenarios: composite source keys collide, JSON columns lose their original
// representation, optional contextual links fail to appear/disappear, or source
// updates erase independent native links between projected nodes.
it("projects every contextual source and reconciles late email notes", async () => {
 const db = bindings.NANOCODEX_CRM;
 const migrations = bindings.CRM_MIGRATIONS;
 await applyD1Migrations(db, migrations.slice(0, migrations.findIndex(m => m.name.startsWith("0010"))));
 await db.exec(`
 INSERT INTO crm_records(owner_id,id,kind,name,created_at,updated_at) VALUES ('all','p','person','Person',1,2);
 INSERT INTO crm_facts(owner_id,id,record_id,predicate,value_json,origin,created_at,updated_at) VALUES ('all','f','p','bio.location','"Somewhere"','user',1,2);
 INSERT INTO crm_identities(owner_id,id,record_id,kind,value,normalized,origin,created_at,updated_at) VALUES ('all','i','p','aka','Alias','alias','user',1,2);
 INSERT INTO crm_research(owner_id,record_id,summary,sources,status,checked_at) VALUES ('all','p','Research','[]','needs_review',2);
 INSERT INTO crm_events(owner_id,id,title,start_at,start_ms,origin,sources,created_at,updated_at) VALUES ('all','e','Conference','2026',1,'user','[]',1,2);
 INSERT INTO crm_event_participation(owner_id,id,event_id,record_id,person_id,status,role,origin,sources,created_at,updated_at) VALUES ('all','ep','e','p','p','invited','speaker','user','[]',1,2);
 INSERT INTO crm_meetings(owner_id,id,connection_id,calendar_id,event_id,title,start_time,end_time,start_ms,end_ms,all_day,organizer,status,eligible,self_declined,source_revision,import_token,created_at,updated_at) VALUES ('all','m','c','primary','remote','Meeting','2026-01-01','2026-01-02',1,2,0,'{}','confirmed',1,0,1,'token',1,2);
 INSERT INTO crm_meeting_attendees(owner_id,meeting_id,ordinal,email,person_id) VALUES ('all','m',0,'synthetic@example.com','p');
 INSERT INTO crm_meeting_notes(owner_id,id,meeting_id,body,created_at,updated_at) VALUES ('all','mn','m','Meeting note',1,2);
 INSERT INTO crm_email_imports(owner_id,connection_id,message_id,record_id,note_id,imported_at,received_ms) VALUES ('all','c','message','p','late',2,1);
 INSERT INTO crm_interactions(owner_id,id,person_id,event_id,meeting_id,connection_id,message_id,occurred_at,occurred_ms,body,origin,sources,created_at,updated_at) VALUES ('all','ix','p','e','m','c','message','2026',1,'Discussion','user','[]',1,2);
 INSERT INTO crm_interaction_participants(owner_id,interaction_id,record_id,role) VALUES ('all','ix','p','speaker');
 `);
 const tables = ['crm_records','crm_facts','crm_identities','crm_research','crm_events','crm_event_participation','crm_meetings','crm_meeting_attendees','crm_meeting_notes','crm_email_imports','crm_interactions','crm_interaction_participants'];
 const originals = await Promise.all(tables.map(table => db.prepare(`SELECT * FROM ${table} WHERE owner_id='all'`).first()));
 await applyD1Migrations(db, migrations);
 for (let i=0;i<tables.length;i++) {
  const row = originals[i]!;
  const keys = tables[i] === 'crm_research' ? [row.record_id] : tables[i] === 'crm_meeting_attendees' ? [row.meeting_id,row.ordinal] : tables[i] === 'crm_email_imports' ? [row.connection_id,row.message_id] : tables[i] === 'crm_interaction_participants' ? [row.interaction_id,row.record_id] : [row.id];
  const node = await db.prepare("SELECT metadata FROM crm_nodes WHERE owner_id='all' AND id=?").bind(legacyId(tables[i],...keys)).first<{metadata:string}>();
  expect(JSON.parse(node!.metadata).legacy).toEqual(row);
 }
 const eventNode = await db.prepare("SELECT metadata FROM crm_nodes WHERE owner_id='all' AND id=?").bind(legacyId('crm_events','e')).first<{metadata:string}>();
 expect(JSON.parse(eventNode!.metadata).occurred_at).toBe('2026');
 const participationNode = await db.prepare("SELECT metadata FROM crm_nodes WHERE owner_id='all' AND id=?").bind(legacyId('crm_event_participation','ep')).first<{metadata:string}>();
 expect(JSON.parse(participationNode!.metadata)).toMatchObject({occurred_at:'2026',occurred_at_basis:'event_start'});
 const emailNode = await db.prepare("SELECT metadata FROM crm_nodes WHERE owner_id='all' AND id=?").bind(legacyId('crm_email_imports','c','message')).first<{metadata:string}>();
 expect(JSON.parse(emailNode!.metadata).occurred_at).toBe('1970-01-01T00:00:00.001Z');
 const emailId = legacyId('crm_email_imports','c','message'), noteId = legacyId('crm_notes','late');
 const hasLink = async (a:string,b:string) => (await db.prepare("SELECT count(*) n FROM crm_links WHERE owner_id='all' AND from_id=? AND to_id=?").bind(...[a,b].sort()).first<{n:number}>())!.n;
 expect(await hasLink(emailId,noteId)).toBe(0);
 await db.prepare("INSERT INTO crm_notes(owner_id,id,record_id,body,created_at,updated_at) VALUES ('all','late','p','Imported mail',3,3)").run();
 expect(await hasLink(emailId,noteId)).toBe(1);
 const endpoints = [legacyId('crm_facts','f'),legacyId('crm_events','e')].sort();
 await db.prepare("INSERT INTO crm_links VALUES ('all',?,?,4,4)").bind(...endpoints).run();
 await db.prepare("UPDATE crm_facts SET value_json='null',updated_at=5 WHERE owner_id='all'").run();
 expect(await hasLink(...endpoints as [string,string])).toBe(1);
 // Rescheduled sources refresh contextual dates without claiming attendance or
 // treating note creation/import timestamps as the underlying occurrence.
 await db.prepare("UPDATE crm_events SET start_at='2027',updated_at=9 WHERE owner_id='all'").run();
 await db.prepare("UPDATE crm_meetings SET start_time='2027-01-01',updated_at=9 WHERE owner_id='all'").run();
 await db.prepare("UPDATE crm_interactions SET occurred_at='2027-02',updated_at=9 WHERE owner_id='all'").run();
 for (const [table,keys,date,basis] of [
  ['crm_event_participation',['ep'],'2027','event_start'],
  ['crm_meeting_attendees',['m',0],'2027-01-01','scheduled_meeting_start'],
  ['crm_meeting_notes',['mn'],'2027-01-01','scheduled_meeting_start'],
  ['crm_interaction_participants',['ix','p'],'2027-02','interaction_occurrence'],
 ] as const) {
  const node = await db.prepare("SELECT metadata FROM crm_nodes WHERE owner_id='all' AND id=?").bind(legacyId(table,...keys)).first<{metadata:string}>();
  expect(JSON.parse(node!.metadata)).toMatchObject({occurred_at:date,occurred_at_basis:basis});
 }
 expect(await hasLink(...endpoints as [string,string])).toBe(1);
 const undated = await db.prepare("SELECT metadata FROM crm_nodes WHERE owner_id='all' AND id=?").bind(noteId).first<{metadata:string}>();
 expect(JSON.parse(undated!.metadata)).not.toHaveProperty('occurred_at');

 await db.prepare("DELETE FROM crm_notes WHERE owner_id='all'").run();
 expect(await hasLink(emailId,noteId)).toBe(0);
 expect(await db.prepare("SELECT count(*) n FROM crm_nodes WHERE owner_id='all' AND id=?").bind(emailId).first()).toEqual({n:1});
 expect(await db.prepare("PRAGMA foreign_key_check").all()).toMatchObject({results:[]});
});

it("preserves explicit relationship descriptions instead of interpreting legacy catchall types", async () => {
 const db = bindings.NANOCODEX_CRM;
 const migrations = bindings.CRM_MIGRATIONS;
 await applyD1Migrations(db, migrations.slice(0, migrations.findIndex(m => m.name.startsWith("0010"))));
 await db.exec(`INSERT INTO crm_records(owner_id,id,kind,name,created_at,updated_at) VALUES ('family','child','person','Synthetic Child',1,1),('family','parent','person','Synthetic Parent',1,1);
 INSERT INTO crm_relationships(owner_id,id,from_id,to_id,type,description,origin,created_at,updated_at) VALUES ('family','family-link','child','parent','knows','DAUGHTER OF / inverse FATHER OF','user',1,1);`);
 await applyD1Migrations(db,migrations);
 const read = () => db.prepare("SELECT text,metadata FROM crm_nodes WHERE owner_id='family' AND id=?").bind(legacyId('crm_relationships','family-link')).first<{text:string;metadata:string}>();
 const initial = (await read())!;
 expect(initial.text).toContain('Synthetic Child');
 expect(initial.text).toContain('Synthetic Parent');
 expect(initial.text).toContain('DAUGHTER OF / inverse FATHER OF');
 expect(initial.text).not.toContain('knows');
 expect(JSON.parse(initial.metadata).legacy.type).toBe('knows');
 await db.prepare("UPDATE crm_records SET name='Renamed Parent',updated_at=2 WHERE owner_id='family' AND id='parent'").run();
 expect((await read())!.text).toContain('Renamed Parent');
 expect((await read())!.text).not.toContain('Synthetic Parent');
});
