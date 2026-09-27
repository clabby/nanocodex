import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { crmGraphRequest } from "../src/crm-graph";
// Real D1 scenarios specified before implementation: stable updates preserve omitted
// provenance and date precision; owner/filter cursor isolation; undirected duplicate
// links and FK ownership; bounded explainable traversal; cascade and legacy protection.
const bindings = env as unknown as { NANOCODEX_CRM: D1Database; CRM_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.NANOCODEX_CRM;
beforeAll(async () => { await applyD1Migrations(db, bindings.CRM_MIGRATIONS); });
const request = (owner: string, operation: Parameters<typeof crmGraphRequest>[2], input: unknown, id = crypto.randomUUID()): Promise<any> => crmGraphRequest(db, owner, operation, input, id);
it("updates stable nodes without inventing or dropping omitted metadata and scopes cursors", async () => {
 const owner = crypto.randomUUID();
 await request(owner, "save", { text: "Alpha", metadata: { occurred_at: "2026-02", sources: [{ reference: "user statement" }] } }, "a");
 await request(owner, "save", { id: "a", text: "Alpha revised" });
 expect((await request(owner, "get", { id: "a" })).node).toMatchObject({ id: "a", text: "Alpha revised", metadata: { occurred_at: "2026-02", sources: [{ reference: "user statement" }] } });
 await request(owner, "save", { text: "Alpha second" }, "b");
 const page = await request(owner, "search", { q: "Alpha", limit: 1 });
 expect(page.nodes).toHaveLength(1);
 expect((await request(owner, "search", { q: "Alpha", cursor: page.next_cursor })).nodes).toHaveLength(1);
 for (const [o,q] of [[owner,"other"],[crypto.randomUUID(),"Alpha"]]) await expect(request(o, "search", { q, cursor: page.next_cursor })).rejects.toMatchObject({ code: "invalid_input" });
 await expect(request(owner, "save", { id: "missing", text: "No upsert" })).rejects.toMatchObject({ code: "not_found" });
 await expect(request(owner, "save", { text: "large", metadata: { body: "x".repeat(16384) } })).rejects.toMatchObject({ code: "invalid_input" });
});
it("keeps undirected links owner scoped, explains paths and cascades deletion", async () => {
 const owner = crypto.randomUUID(), foreign = crypto.randomUUID();
 for (const id of ["a","b","c"]) await request(owner,"save",{text:id},id);
 await request(foreign,"save",{text:"foreign"},"d");
 await request(owner,"link_save",{from_id:"b",to_id:"a"});
 await request(owner,"link_save",{from_id:"a",to_id:"b"});
 await request(owner,"link_save",{from_id:"b",to_id:"c"});
 expect((await request(owner,"links",{id:"a"})).links).toEqual([{from_id:"a",to_id:"b"}]);
 await expect(request(owner,"link_save",{from_id:"a",to_id:"d"})).rejects.toMatchObject({code:"not_found"});
 const path = await request(owner,"path",{from_id:"a",to_id:"c"});
 expect(path.nodes.map((n:any)=>n.id)).toEqual(["a","b","c"]);
 expect(path.links).toHaveLength(2); expect(path.relationship_inference).toBe(false);
 expect((await request(owner,"path",{from_id:"a",to_id:"c",max_depth:1})).found).toBe(false);
 await request(owner,"delete",{id:"b"});
 expect((await request(owner,"links",{id:"a"})).links).toEqual([]);
 await expect(request(foreign,"get",{id:"a"})).rejects.toMatchObject({code:"not_found"});
});
it("bounds traversal truthfully and keeps undated statements outside the dated timeline", async () => {
 const owner=crypto.randomUUID();
 for(const [id,metadata] of [["a",{}],["b",{occurred_at:"2026"}],["c",{occurred_at:"2026-02"}],["d",{occurred_at:"2026-02-03"}]] as const) await request(owner,"save",{text:id,metadata},id);
 for(const to_id of ["b","c","d"]) await request(owner,"link_save",{from_id:"a",to_id});
 const bounded=await request(owner,"neighbors",{id:"a",max_nodes:2});
 expect(bounded.nodes).toHaveLength(2); expect(bounded.truncated).toBe(true);
 expect((await request(owner,"neighbors",{id:"a",max_depth:1})).truncated).toBe(false);
 const timeline=await request(owner,"timeline",{id:"a",from:"2026-02",limit:1});
 expect(timeline.nodes.map((n:any)=>n.id)).toEqual(["c"]); expect(timeline.undated).toBe("excluded");
 expect((await request(owner,"timeline",{id:"a",from:"2026-02",cursor:timeline.next_cursor})).nodes.map((n:any)=>n.id)).toEqual(["d"]);
 await expect(request(owner,"timeline",{id:"b",from:"2026-02",cursor:timeline.next_cursor})).rejects.toMatchObject({code:"invalid_input"});
 for(const metadata of [{origin:"source"},{origin:"inferred",sources:[{kind:"web",reference:"https://example.org"}]},{occurred_at:"2026-02-30"}]) await expect(request(owner,"save",{text:"invalid",metadata})).rejects.toMatchObject({code:"invalid_input"});
 await expect(request(owner,"save",{text:"reserved"},'legacy:crm_records:["x"]')).rejects.toMatchObject({code:"invalid_input"});
});
it("protects projected legacy content while allowing native links to it",async()=>{
 const owner=crypto.randomUUID(), legacy='legacy:crm_records:["old:id"]';
 await db.prepare("INSERT INTO crm_records(owner_id,id,kind,name,created_at,updated_at) VALUES (?,?,'person','Legacy person',1,1)").bind(owner,"old:id").run();
 expect((await request(owner,"get",{id:legacy})).node.text).toContain("Legacy person");
 await request(owner,"save",{text:"Statement"},"statement");
 await request(owner,"link_save",{from_id:legacy,to_id:"statement"});
 expect((await request(owner,"neighbors",{id:legacy})).nodes.map((n:any)=>n.id)).toContain("statement");
 for(const op of ["save","delete"] as const) await expect(request(owner,op,{id:legacy,...(op==="save"?{text:"overwrite"}:{})})).rejects.toThrow(/source.managed/i);
 await request(owner,"link_delete",{from_id:legacy,to_id:"statement"});
 expect((await request(owner,"links",{id:legacy})).links).toEqual([]);
});
// Boundary regressions specified before fixes: case-insensitive RFC3339 parsing,
// literal metadata discovery, and long composite source identifiers in cursors.
it("finds metadata and orders lowercase RFC3339 without losing long legacy IDs",async()=>{
 const owner=crypto.randomUUID();
 await request(owner,"save",{text:"Statement",metadata:{identity:"unique@example.org",occurred_at:"2026-02-03t04:05:06z"}},"dated");
 expect((await request(owner,"search",{q:"unique@example.org"})).nodes.map((n:any)=>n.id)).toEqual(["dated"]);
 expect((await request(owner,"timeline",{})).nodes.map((n:any)=>n.id)).toEqual(["dated"]);
 const legacy=`legacy:crm_email_imports:${JSON.stringify(["c".repeat(1024),"m".repeat(1024)])}`;
 await db.prepare("INSERT INTO crm_nodes VALUES (?,?,?,'{}',1,1)").bind(owner,legacy,"Long source identity").run();
 expect((await request(owner,"get",{id:legacy})).node.id).toBe(legacy);
 const page=await request(owner,"search",{limit:1});
 expect((await request(owner,"search",{cursor:page.next_cursor})).nodes.map((n:any)=>n.id)).toContain(legacy);
});
// Deletion must check source ownership in the DELETE itself, even when a legacy
// writer establishes an edge between the endpoint reads and the mutation.
it("rejects unlinking a source-managed edge and leaves it visible",async()=>{
 const owner=crypto.randomUUID();
 await db.prepare("INSERT INTO crm_records(owner_id,id,kind,name,created_at,updated_at) VALUES (?,'person','person','Person',1,1)").bind(owner).run();
 await db.prepare("INSERT INTO crm_notes(owner_id,id,record_id,body,created_at,updated_at) VALUES (?,'note','person','Source note',1,1)").bind(owner).run();
 const from_id='legacy:crm_records:["person"]',to_id='legacy:crm_notes:["note"]';
 await expect(request(owner,"link_delete",{from_id,to_id})).rejects.toThrow(/source.managed/i);
 expect((await request(owner,"links",{id:from_id})).links).toHaveLength(1);
});
// UTF-16 orders supplementary characters before U+E000, while SQLite BINARY
// orders their UTF-8 bytes after it. API links must use the database ordering.
it("canonicalizes Unicode legacy endpoints using SQLite binary ordering",async()=>{
 const owner=crypto.randomUUID(),first='legacy:crm_records:["\ue000"]',second='legacy:crm_records:["\u{10000}"]';
 for(const key of [first,second]) await db.prepare("INSERT INTO crm_nodes VALUES (?,?,?,'{}',1,1)").bind(owner,key,"Unicode source").run();
 const expected={from_id:first,to_id:second};
 expect((await request(owner,"link_save",{from_id:second,to_id:first})).link).toEqual(expected);
 expect((await request(owner,"path",{from_id:second,to_id:first})).links).toEqual([expected]);
 await request(owner,"link_save",expected);
 expect((await request(owner,"links",{id:first})).links).toEqual([expected]);
 await request(owner,"link_delete",{from_id:second,to_id:first});
 expect((await request(owner,"links",{id:first})).links).toEqual([]);
});
// SQLite julianday rejects offsets above 14 hours although RFC3339 permits
// them and the API validator accepts them. Accepted dates must stay visible.
it("orders accepted large RFC3339 offsets and preserves their original value",async()=>{
 const owner=crypto.randomUUID();
 await request(owner,"save",{text:"Offset statement",metadata:{occurred_at:"2026-02-03T04:05:06+15:00"}},"offset");
 const page=await request(owner,"timeline",{from:"2026-02-02T13:05:06Z",to:"2026-02-02T13:05:07Z"});
 expect(page.nodes.map((n:any)=>n.id)).toEqual(["offset"]);
 expect(page.nodes[0].metadata.occurred_at).toBe("2026-02-03T04:05:06+15:00");
});
// Date.parse uses millisecond truncation; SQLite's fractional rounding must not
// move an accepted timestamp past an exclusive boundary.
it("truncates submillisecond fractions for timeline filtering without rewriting metadata",async()=>{
 const owner=crypto.randomUUID(),occurred_at="2026-02-03T04:05:06.9999+15:00";
 await request(owner,"save",{text:"Fractional statement",metadata:{occurred_at}},"fractional");
 const page=await request(owner,"timeline",{from:"2026-02-02T13:05:06.999Z",to:"2026-02-02T13:05:07Z"});
 expect(page.nodes.map((n:any)=>n.id)).toEqual(["fractional"]);
 expect(page.nodes[0].metadata.occurred_at).toBe(occurred_at);
});
