import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { CrmError } from "./crm";

export type CrmGraphOperation = "search" | "get" | "save" | "delete" | "links" | "link_save" | "link_delete" | "neighbors" | "path" | "timeline";
type Input = Record<string, unknown>;
type Row = { id: string; text: string; metadata: string; created_at: number; updated_at: number };
type Link = { from_id: string; to_id: string };
// Match SQLite BINARY collation, including non-BMP legacy source keys.
function compareIds(a:string,b:string):number { return Buffer.compare(Buffer.from(a),Buffer.from(b)); }
function invalid(message: string): never { throw new CrmError("invalid_input", message); }
function missing(): never { throw new CrmError("not_found", "CRM node or link not found."); }
function object(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) invalid("Expected an object.");
  return value as Input;
}
function text(value: unknown, field: string, max = 20000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid(`Invalid ${field}.`);
  return value.trim();
}
function id(value: unknown, native = false): string {
  if(typeof value !== "string") invalid("Invalid node id.");
  if(value.startsWith("legacy:")) {
    if(native) invalid("The legacy: prefix is reserved for source-managed nodes.");
    const match = /^legacy:([a-z_]+):(\[.*\])$/.exec(value);
    if(value.length>8192 || !match) invalid("Invalid legacy node id.");
    try { const keys: unknown=JSON.parse(match[2]); if(!Array.isArray(keys)||!keys.length||keys.some(k=>typeof k!=="string"&&typeof k!=="number")) invalid("Invalid legacy key."); } catch { invalid("Invalid legacy node id."); }
  } else if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid("Invalid node id.");
  return value;
}
function integer(value:unknown, fallback:number, max:number):number {
 const n=value??fallback;
 if(typeof n!=="number"||!Number.isInteger(n)||n<1||n>max) invalid(`Expected an integer from 1 to ${max}.`);
 return n;
}
function date(value:unknown):number {
 const s=text(value,"occurred_at",64), p=/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
 if(p) return date(`${p[1]}-${p[2]??"01"}-${p[3]??"01"}T00:00:00Z`);
 const m=/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(s);
 if(!m) invalid("Expected YYYY, YYYY-MM, YYYY-MM-DD or absolute RFC3339.");
 const y=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
 const days=[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]||Number(m[4])>23||Number(m[5])>59||Number(m[6])>59||Number(m[7]??0)>23||Number(m[8]??0)>59||!Number.isFinite(Date.parse(s))) invalid("Invalid occurred_at.");
 return Date.parse(s);
}
function metadata(value:unknown):string {
 const meta=object(value), seen=new Set<object>();
 const visit=(v:unknown,depth:number):void=>{
  if(depth>32) invalid("Metadata exceeds nesting depth.");
  if(v===null||typeof v==="string"||typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v)) return;
  if(!v||typeof v!=="object"||seen.has(v)||(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))||Object.getOwnPropertySymbols(v).length) invalid("Metadata must contain JSON values.");
  seen.add(v); for(const child of Object.values(v)) visit(child,depth+1); seen.delete(v);
 };
 visit(meta,0);
 const encoded=JSON.stringify(meta);
 if(Buffer.byteLength(encoded)>16384) invalid("Metadata exceeds 16 KiB.");
 if(meta.occurred_at!==undefined&&meta.occurred_at!==null) date(meta.occurred_at);
 if(meta.origin!==undefined&&meta.origin!=="user"&&meta.origin!=="source"&&meta.origin!=="inferred") invalid("Invalid statement origin.");
 if(meta.origin==="source"||meta.origin==="inferred") {
  if(!Array.isArray(meta.sources)||!meta.sources.length||meta.sources.length>50) invalid("Source and inferred statements require evidence in metadata.sources.");
  for(const raw of meta.sources) {
   const s=object(raw); if(!["web","email","calendar","document","user"].includes(String(s.kind))) invalid("Invalid evidence kind.");
   const ref=text(s.reference,"evidence reference",2048);
   if(s.kind==="web"||/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) { let url:URL; try{url=new URL(ref);}catch{invalid("Invalid evidence URL.");} if(!["http:","https:"].includes(url.protocol)||url.username||url.password||/[\s\\]/.test(ref)) invalid("Invalid evidence URL."); }
   if(s.detail!==undefined) text(s.detail,"evidence detail",2000);
  }
  if(meta.origin==="inferred"&&(!["low","medium","high"].includes(String(meta.confidence))||!meta.rationale)) invalid("Inferences require confidence and rationale.");
  if(meta.origin==="inferred") text(meta.rationale,"rationale",2000);
 }
 return encoded;
}
function node(row:Row) { return {id:row.id,text:row.text,metadata:JSON.parse(row.metadata),created_at:row.created_at,updated_at:row.updated_at,source_managed:row.id.startsWith("legacy:")}; }
function cursorScope(owner:string,operation:string,filters:unknown):string {return createHash("sha256").update(JSON.stringify([owner,operation,filters])).digest("hex");}
function decode(value:unknown,scope:string):Input|null {
 if(value===undefined)return null;
 try {if(typeof value!=="string"||value.length>32768||!/^[A-Za-z0-9_-]+$/.test(value)) invalid("Invalid cursor.");const c=object(JSON.parse(Buffer.from(value,"base64url").toString()));if(c.scope!==scope||c.v!==1)invalid("Invalid cursor.");return c;}catch{invalid("Invalid cursor for this owner and query.");}
}
function encode(scope:string,fields:Input):string {return Buffer.from(JSON.stringify({v:1,scope,...fields})).toString("base64url");}

/** Owner-scoped freeform statements and undirected structural links. */
export async function crmGraphRequest(db:D1Database,owner:string,operation:CrmGraphOperation,input:unknown,createId:string):Promise<unknown> {
 text(owner,"owner",512);
 const args=object(input), allowed:Record<CrmGraphOperation,string[]>={search:["q","limit","cursor"],get:["id"],save:["id","text","metadata"],delete:["id"],links:["id","limit","cursor"],link_save:["from_id","to_id"],link_delete:["from_id","to_id"],neighbors:["id","max_depth","max_nodes"],path:["from_id","to_id","max_depth","max_nodes"],timeline:["id","from","to","limit","cursor"]};
 if(!allowed[operation]||Object.keys(args).some(k=>!allowed[operation].includes(k)))invalid("Unknown operation or field.");
 const session=db.withSession("first-primary");
 const read=async(key:string):Promise<Row>=>{const row=await session.prepare("SELECT id,text,metadata,created_at,updated_at FROM crm_nodes WHERE owner_id=? AND id=?").bind(owner,key).first<Row>();if(!row)missing();return row;};
 const editable=(key:string)=>{if(key.startsWith("legacy:"))invalid("This node is source-managed; edit or delete its original source record.");};
 const endpoints=async()=>{const keys=[id(args.from_id),id(args.to_id)].sort(compareIds);if(keys[0]===keys[1])invalid("A link needs two distinct nodes.");await read(keys[0]);await read(keys[1]);return keys;};
 try {
  if(operation==="get")return {node:node(await read(id(args.id)))};
  if(operation==="save") {
   const key=id(args.id??createId,args.id===undefined);editable(key);
   const existing=args.id===undefined?null:await read(key);
   const body=args.text===undefined&&existing?existing.text:text(args.text,"text");
   const meta=args.metadata===undefined?(existing?.metadata??"{}"):metadata(args.metadata);
   // Replacing metadata must not reclassify a saved assertion or silently
   // remove the evidence required for its original source/inference.
   if(existing){const prior=JSON.parse(existing.metadata) as Input;const next=JSON.parse(meta) as Input;
    if(prior.origin!==undefined&&prior.origin!==next.origin)invalid("Statement origin is immutable; save a correction as a new statement.");}
   const now=Date.now();
   const row=existing?await session.prepare("UPDATE crm_nodes SET text=?,metadata=?,updated_at=max(updated_at,?) WHERE owner_id=? AND id=? AND text=? AND metadata=? RETURNING id,text,metadata,created_at,updated_at").bind(body,meta,now,owner,key,existing.text,existing.metadata).first<Row>():await session.prepare("INSERT INTO crm_nodes(owner_id,id,text,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id,id) DO NOTHING RETURNING id,text,metadata,created_at,updated_at").bind(owner,key,body,meta,now,now).first<Row>();
   if(!row){if(existing)invalid("Node changed during edit; read it and retry.");const previous=await read(key);if(previous.text!==body||previous.metadata!==meta)invalid("Node id already exists with different content.");return {node:node(previous)};}
   return {node:node(row)};
  }
  if(operation==="delete") {const key=id(args.id);editable(key);if(!await session.prepare("DELETE FROM crm_nodes WHERE owner_id=? AND id=? RETURNING id").bind(owner,key).first())missing();return {deleted:true};}
  if(operation==="link_save"||operation==="link_delete") {
   const [from,to]=await endpoints();
   if(operation==="link_delete") {
    const deleted=await session.prepare("DELETE FROM crm_links WHERE owner_id=? AND from_id=? AND to_id=? AND NOT EXISTS (SELECT 1 FROM crm_legacy_links s WHERE s.owner_id=crm_links.owner_id AND s.from_id=crm_links.from_id AND s.to_id=crm_links.to_id) RETURNING from_id").bind(owner,from,to).first();
    if(!deleted) {
     if(await session.prepare("SELECT 1 FROM crm_legacy_links WHERE owner_id=? AND from_id=? AND to_id=? LIMIT 1").bind(owner,from,to).first())invalid("This link is source-managed; edit its original source record.");
     missing();
    }
    return {deleted:true};
   }
   const now=Date.now();
   // A projected edge is rebuilt from its source. A duplicate INSERT would
   // otherwise acknowledge a native link that the next source update removes.
   const added=await session.prepare(`INSERT INTO crm_links(owner_id,from_id,to_id,created_at,updated_at)
     SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM crm_legacy_links WHERE owner_id=? AND from_id=? AND to_id=?)
     ON CONFLICT(owner_id,from_id,to_id) DO NOTHING RETURNING from_id`).bind(owner,from,to,now,now,owner,from,to).first();
   if(!added&&await session.prepare("SELECT 1 FROM crm_legacy_links WHERE owner_id=? AND from_id=? AND to_id=? LIMIT 1").bind(owner,from,to).first())
    invalid("This link is source-managed; edit its original source record.");
   return {link:{from_id:from,to_id:to}};
  }
  if(operation==="search") {
   const q=args.q===undefined?null:text(args.q,"q",512),limit=integer(args.limit,20,100),scope=cursorScope(owner,operation,[q]),c=decode(args.cursor,scope);
   const values:(string|number)[]=[owner],where=["owner_id=?"];
   if(q!==null){where.push("(instr(lower(text),lower(?))>0 OR instr(lower(metadata),lower(?))>0)");values.push(q,q);}
   if(c){where.push("id>?");values.push(id(c.id));}
   const rows=(await session.prepare(`SELECT id,text,metadata,created_at,updated_at FROM crm_nodes WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`).bind(...values,limit+1).all<Row>()).results;
   const page=rows.slice(0,limit);return {nodes:page.map(node),next_cursor:rows.length>limit?encode(scope,{id:page.at(-1)!.id}):null};
  }
  if(operation==="links") {
   const key=id(args.id);await read(key);const limit=integer(args.limit,50,100),scope=cursorScope(owner,operation,[key]),c=decode(args.cursor,scope);
   const values:(string|number)[]=[owner,key,key],where=["owner_id=?","(from_id=? OR to_id=?)"];
   if(c){const a=id(c.from_id),b=id(c.to_id);where.push("(from_id>? OR (from_id=? AND to_id>?))");values.push(a,a,b);}
   const rows=(await session.prepare(`SELECT from_id,to_id FROM crm_links WHERE ${where.join(" AND ")} ORDER BY from_id,to_id LIMIT ?`).bind(...values,limit+1).all<Link>()).results;
   const page=rows.slice(0,limit);return {links:page,next_cursor:rows.length>limit?encode(scope,page.at(-1)!):null};
  }
  if(operation==="timeline") {
   const key=args.id===undefined?null:id(args.id);if(key)await read(key);
   const from=args.from===undefined?null:date(args.from),to=args.to===undefined?null:date(args.to);if(from!==null&&to!==null&&from>=to)invalid("from must precede to.");
   const limit=integer(args.limit,20,100),scope=cursorScope(owner,operation,[key,from,to]),c=decode(args.cursor,scope);
   // Partial dates use their UTC period floor solely for ordering; metadata is unchanged.
   const at="upper(json_extract(metadata,'$.occurred_at'))";
   // SQLite rejects otherwise valid RFC3339 offsets above 14 hours. Parse
   // the offset separately so every accepted absolute timestamp stays visible.
   const offset=`(length(${at})>=25 AND substr(${at},-6,1) IN ('+','-'))`;
   const local=`CASE WHEN ${offset} THEN substr(${at},1,length(${at})-6)||'Z' ELSE CASE length(${at}) WHEN 4 THEN ${at}||'-01-01' WHEN 7 THEN ${at}||'-01' ELSE ${at} END END`;
   const shift=`CASE WHEN ${offset} THEN (CASE substr(${at},-6,1) WHEN '+' THEN 1 ELSE -1 END)*(CAST(substr(${at},-5,2) AS INTEGER)*60+CAST(substr(${at},-2) AS INTEGER))*60000 ELSE 0 END`;
   const milliseconds=`CASE WHEN substr(${local},20,1)='.' AND length(${local})>24 THEN substr(${local},1,23)||'Z' ELSE ${local} END`;
   const ms=`(CAST(round((julianday(${milliseconds})-2440587.5)*86400000) AS INTEGER)-(${shift}))`;
   const where=["owner_id=?","occurred_ms IS NOT NULL"],values:(string|number)[]=[owner];
   if(key){where.push("(id=? OR id IN (SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END FROM crm_links WHERE owner_id=? AND (from_id=? OR to_id=?)))");values.push(key,key,owner,key,key);}
   if(from!==null){where.push("occurred_ms>=?");values.push(from);}if(to!==null){where.push("occurred_ms<?");values.push(to);}
   if(c){if(typeof c.at!=="number"||!Number.isSafeInteger(c.at))invalid("Invalid cursor date.");where.push("(occurred_ms>? OR (occurred_ms=? AND id>?))");values.push(c.at,c.at,id(c.id));}
   const rows=(await session.prepare(`SELECT * FROM (SELECT id,text,metadata,created_at,updated_at,owner_id,${ms} AS occurred_ms FROM crm_nodes WHERE owner_id=?) WHERE ${where.join(" AND ")} ORDER BY occurred_ms,id LIMIT ?`).bind(owner,...values,limit+1).all<Row&{occurred_ms:number}>()).results;
   const page=rows.slice(0,limit),last=page.at(-1);return {nodes:page.map(node),next_cursor:rows.length>limit&&last?encode(scope,{at:last.occurred_ms,id:last.id}):null,undated:"excluded"};
  }
  const start=id(operation==="path"?args.from_id:args.id),target=operation==="path"?id(args.to_id):null;
  const startRow=await read(start);if(target)await read(target);
  const maxDepth=integer(args.max_depth,operation==="path"?6:1,10),maxNodes=integer(args.max_nodes,100,500);
  const visited=new Map<string,{row:Row;depth:number;parent:string|null}>([[start,{row:startRow,depth:0,parent:null}]]),queue=[start];
  let truncated=false;
  for(let i=0;i<queue.length&&!(target&&visited.has(target));i++) {
   const current=queue[i],entry=visited.get(current)!;
   const remaining=maxNodes-visited.size;
   const next=(await session.prepare("SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS id FROM crm_links WHERE owner_id=? AND (from_id=? OR to_id=?) AND CASE WHEN from_id=? THEN to_id ELSE from_id END NOT IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?").bind(current,owner,current,current,current,JSON.stringify([...visited.keys()]),entry.depth>=maxDepth?1:remaining+1).all<{id:string}>()).results;
   if(entry.depth>=maxDepth){if(next.length)truncated=true;continue;}
   if(next.length>remaining)truncated=true;
   for(const n of next.slice(0,remaining)){visited.set(n.id,{row:await read(n.id),depth:entry.depth+1,parent:current});queue.push(n.id);}
  }
  if(target) {
   const path:string[]=[];
   if(visited.has(target)){let current:string|null=target;while(current!==null){path.push(current);current=visited.get(current)!.parent;}path.reverse();}
   return {found:path.length>0,nodes:path.map(k=>node(visited.get(k)!.row)),links:path.slice(1).map((k,i)=>{const [from_id,to_id]=[path[i],k].sort(compareIds);return {from_id,to_id};}),truncated,relationship_inference:false};
  }
  const keys=JSON.stringify([...visited.keys()]);
  const links=(await session.prepare("SELECT from_id,to_id FROM crm_links WHERE owner_id=? AND from_id IN (SELECT value FROM json_each(?)) AND to_id IN (SELECT value FROM json_each(?)) ORDER BY from_id,to_id LIMIT 2001").bind(owner,keys,keys).all<Link>()).results;
  return {nodes:[...visited.values()].map(v=>node(v.row)),links:links.slice(0,2000),truncated:truncated||links.length>2000,relationship_inference:false};
 } catch(error) {
  if(error instanceof CrmError)throw error;
  if(error instanceof Error&&/constraint/i.test(error.message))invalid("Invalid or conflicting CRM node or link.");
  throw error;
 }
}
