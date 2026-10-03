/** Deterministic, account-private identity registry for prepared work. A model
 * cannot add links. Exact saved addresses/aliases are assertions, not proof of
 * sender authenticity. All text is untrusted and all reads are bounded. */
import type { PreparationEvidence } from "./todo-preparation-model";
export type TodoPersonSource = { kind: string; reference: string; detail?: string; origin?: string; updated_at?: number };
export type TodoLinkedPerson = {
  record_id: string; name: string; email: string; title: string | null; company: string | null; summary: string | null;
  match: "exact_email" | "exact_alias"; sources: TodoPersonSource[];
  relationships: { id: string; from_id: string; to_id: string; type: string; role: string | null; description: string | null; effective_from: string | null; effective_to: string | null; sources: TodoPersonSource[] }[];
  timeline: { id: string; kind: "note" | "interaction"; text: string; occurred_at: string; timestamp_basis: "created_at" | "occurred_at"; sources: TodoPersonSource[] }[];
};
export type TodoPeopleContext = {
  people: TodoLinkedPerson[];
  people_status: "matched" | "unmatched" | "ambiguous" | "partial";
  people_coverage: { limited: true; checked_at: string | null; reasons: string[];
    resolutions: { email: string; status: "matched" | "unmatched" | "ambiguous" | "unavailable"; record_id: string | null }[] };
};
export const emptyTodoPeople = (): TodoPeopleContext => ({ people: [], people_status: "unmatched", people_coverage: {
  limited: true, checked_at: null, reasons: ["No exact email/alias identity has been resolved; names and domains never establish a link."], resolutions: [],
} });
const clip = (value: string | null, max = 640): string | null => value === null ? null : value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
/** Extract literal addresses only. Never resolve a display name or domain. */
export function todoContextEmails(text: string): string[] {
  return [...new Set((text.match(/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/g) ?? []).map(email => email.toLowerCase()))];
}
/** Header identity must be a single mailbox, not an address appearing in prose. */
export function todoSenderEmail(raw: string): string[] {
  const match = /^(?:[^<>\r\n]*<([^<>\r\n]+)>|([^<>\r\n]+))$/.exec(raw.trim());
  const email = (match?.[1] ?? match?.[2] ?? "").trim().toLowerCase();
  return /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(email) ? [email] : [];
}
function sources(raw: string): TodoPersonSource[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(s => s && ["web", "email", "calendar", "document", "user"].includes(s.kind) && typeof s.reference === "string" && s.reference.trim()).slice(0, 3)
      .map(s => ({ kind: s.kind, reference: clip(s.reference, 2048)!, ...(typeof s.detail === "string" ? { detail: clip(s.detail)! } : {}) })) : [];
  } catch { return []; }
}
export async function readTodoPeople(db: D1Database | undefined, owner: string, inputs: string[]): Promise<TodoPeopleContext> {
  const all = [...new Set(inputs.map(email => email.trim().toLowerCase()).filter(email => todoSenderEmail(email).length))], emails = all.slice(0, 6);
  const result = emptyTodoPeople();
  result.people_coverage = { limited: true, checked_at: new Date().toISOString(), reasons: [
    "Saved CRM assertions only; exact email/alias matching does not verify sender authenticity. No name/domain inference.",
    "At most 6 addresses, 3 explicit relationships and 3 saved timeline entries per person; not exhaustive/live history. Invitations never prove attendance.",
  ], resolutions: emails.map(email => ({ email, status: "unavailable", record_id: null })) };
  if (!emails.length) { result.people_coverage.reasons.push("No literal email address available for identity resolution."); return result; }
  if (all.length > emails.length) result.people_coverage.reasons.push("Additional addresses omitted.");
  if (!db) { result.people_status = "partial"; result.people_coverage.reasons.push("CRM source unavailable."); return result; }
  let session: D1DatabaseSession;
  try { session = db.withSession("first-primary"); } catch { result.people_status = "partial"; result.people_coverage.reasons.push("CRM identity read unavailable."); return result; }
  let failed = false;
  const read = async <T>(sql: string, ...values: (string | number)[]): Promise<T[]> => {
    try { const rows = await session.prepare(sql).bind(...values).all<T>(); if (!rows.success) throw Error("read_failed"); return rows.results; }
    catch { failed = true; return []; }
  };
  type Match = { input_email: string; id: string; name: string; email: string | null; title: string | null; company: string | null; company_id: string | null; updated_at: number; alias_id: string | null; alias_origin: string | null; alias_source: string | null };
  const matches = await read<Match>(`WITH inputs AS (SELECT value AS email FROM json_each(?2)) SELECT e.email AS input_email,r.id,r.name,r.email,r.title,c.name AS company,c.id AS company_id,r.updated_at,
    i.id AS alias_id,i.origin AS alias_origin,i.source_ref AS alias_source FROM inputs e JOIN crm_records r ON r.owner_id=?1 AND r.kind='person'
    AND (lower(trim(r.email))=e.email OR EXISTS (SELECT 1 FROM crm_identities a WHERE a.owner_id=r.owner_id AND a.record_id=r.id AND a.kind='email' AND a.normalized=e.email))
    LEFT JOIN crm_records c ON c.owner_id=r.owner_id AND c.id=r.company_id AND c.kind='company'
    LEFT JOIN crm_identities i ON i.owner_id=r.owner_id AND i.record_id=r.id AND i.kind='email' AND i.normalized=e.email
    ORDER BY e.email,r.id LIMIT 100`, owner, JSON.stringify(emails));
  // The query cap must never turn a multiple-match address into a unique one.
  if (failed || matches.length >= 100) { result.people_status = "partial"; result.people_coverage.reasons.push("CRM identity read unavailable or exceeded its bound."); return result; }
  for (const resolution of result.people_coverage.resolutions) {
    const candidates = matches.filter(row => row.input_email === resolution.email);
    resolution.status = candidates.length === 1 ? "matched" : candidates.length ? "ambiguous" : "unmatched";
    if (candidates.length !== 1) continue;
    const row = candidates[0]!; resolution.record_id = row.id;
    const primary = row.email?.trim().toLowerCase() === resolution.email;
    const identity: TodoPersonSource = { kind: primary ? "crm_record" : "crm_identity", reference: primary ? row.id : row.alias_id!, origin: primary ? "saved" : row.alias_origin!, detail: `Exact ${primary ? "email" : "alias"}: ${resolution.email}`, updated_at: row.updated_at };
    if (!primary && row.alias_source) identity.detail += `; source: ${clip(row.alias_source, 2048)}`;
    const existing = result.people.find(person => person.record_id === row.id);
    if (existing) { existing.sources.push(identity); continue; }
    const person: TodoLinkedPerson = { record_id: row.id, name: clip(row.name, 160)!, email: resolution.email, title: clip(row.title, 160), company: clip(row.company, 160), summary: null,
      match: primary ? "exact_email" : "exact_alias", sources: [identity, { kind: "crm_record", reference: row.id, origin: "saved", updated_at: row.updated_at }], relationships: [], timeline: [] };
    if (row.company_id) person.sources.push({ kind: "crm_record", reference: row.company_id, origin: "saved", detail: "Explicit saved company link; not inferred from domain." });
    result.people.push(person); // Keep the link even if optional enrichment fails.
    const [profiles, relationships, timeline] = await Promise.all([
      read<{summary:string;title:string|null;sources:string;checked_at:number}>("SELECT summary,title,sources,checked_at FROM crm_research WHERE owner_id=? AND record_id=? AND status='complete'", owner, row.id),
      read<{id:string;from_id:string;to_id:string;type:string;role:string|null;description:string|null;effective_from:string|null;effective_to:string|null;origin:string;sources:string}>(
        "SELECT id,from_id,to_id,type,role,description,effective_from,effective_to,origin,sources FROM crm_relationships WHERE owner_id=? AND (from_id=? OR to_id=?) AND origin IN ('user','source') ORDER BY updated_at DESC,id LIMIT 3", owner, row.id, row.id),
      read<{id:string;kind:"note"|"interaction";text:string;occurred_at:string;origin:string;sources:string;updated_at:number}>(`SELECT * FROM (
        SELECT n.id,'note' AS kind,n.body AS text,strftime('%Y-%m-%dT%H:%M:%fZ',n.created_at/1000.0,'unixepoch') AS occurred_at,'saved' AS origin,'[]' AS sources,n.updated_at,n.created_at AS at
        FROM crm_notes n WHERE n.owner_id=?1 AND n.record_id=?2 AND NOT EXISTS (SELECT 1 FROM crm_email_imports e WHERE e.owner_id=n.owner_id AND e.record_id=n.record_id AND e.note_id=n.id)
        UNION ALL SELECT i.id,'interaction',coalesce(i.summary,i.body),i.occurred_at,i.origin,i.sources,i.updated_at,i.occurred_ms FROM crm_interactions i
        WHERE i.owner_id=?1 AND i.origin IN ('user','source') AND EXISTS (SELECT 1 FROM crm_interaction_participants p WHERE p.owner_id=i.owner_id AND p.interaction_id=i.id AND p.record_id=?2)
      ) ORDER BY at DESC,id LIMIT 3`, owner, row.id),
    ]);
    const profile = profiles[0], profileSources = profile ? sources(profile.sources) : [];
    if (profile && profileSources.length) {
      person.summary = clip(profile.summary); person.title ??= clip(profile.title, 160);
      person.sources.push({ kind: "crm_research", reference: row.id, origin: "source", updated_at: profile.checked_at }, ...profileSources);
    }
    person.relationships = relationships.flatMap(edge => {
      const evidence = sources(edge.sources); if (edge.origin !== "user" && !evidence.length) return [];
      return [{ id: edge.id, from_id: edge.from_id, to_id: edge.to_id, type: edge.type, role: clip(edge.role, 160), description: clip(edge.description), effective_from: edge.effective_from, effective_to: edge.effective_to,
        sources: [{ kind: "crm_relationship", reference: edge.id, origin: edge.origin }, ...evidence] }];
    });
    person.timeline = timeline.flatMap(entry => {
      const evidence = sources(entry.sources); if (entry.origin === "source" && !evidence.length) return [];
      return [{ id: entry.id, kind: entry.kind, text: clip(entry.text)!, occurred_at: entry.occurred_at, timestamp_basis: entry.kind === "note" ? "created_at" : "occurred_at",
        sources: [{ kind: `crm_${entry.kind}`, reference: entry.id, origin: entry.origin, updated_at: entry.updated_at }, ...evidence] }];
    });
  }
  const statuses = result.people_coverage.resolutions.map(r => r.status);
  result.people_status = failed || all.length > emails.length || new Set(statuses).size > 1 ? "partial"
    : statuses[0] === "matched" ? "matched" : statuses[0] === "ambiguous" ? "ambiguous" : "unmatched";
  if (failed) result.people_coverage.reasons.push("Some linked CRM context could not be read; verified links retained.");
  return result;
}
export function todoPeopleEvidence(context: TodoPeopleContext): PreparationEvidence[] {
  return [{ kind: "crm", reference: "crm:verified-people", detail: "Deterministic exact email/alias registry; no model-created identity links. Saved assertions, not sender authentication.", content: JSON.stringify(context) }];
}
