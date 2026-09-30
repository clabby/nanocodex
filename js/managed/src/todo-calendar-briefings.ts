/** Compact, deterministic preparation from imported account-private sources.
 * Strings are untrusted evidence, never instructions. This reader has no model,
 * network, sync, note-collection, or outbound-action dependencies.
 */
export type TodoCalendarSnippet = {
  text: string;
  source: {
    kind: "calendar_description" | "crm_note" | "crm_research" | "email_metadata" | "user_meeting_note";
    reference: string;
    url: string | null;
    updated_at?: number;
    connection_id?: string;
    message_id?: string;
    sources?: { kind: string; reference: string; detail?: string }[];
  };
};
export type TodoCalendarBriefing = {
  id: string; title: string; start: string; end: string; all_day: boolean;
  location: string | null; status: string;
  source: { kind: "calendar"; connection_id: string; calendar_id: string; event_id: string; url: string | null; source_updated: string | null };
  description: TodoCalendarSnippet | null;
  notes: TodoCalendarSnippet[];
  attendees: { person_id: string | null; name: string | null; email: string | null; response_status: string | null; context: TodoCalendarSnippet[] }[];
  coverage: { limited: true; reasons: string[] };
};
export type TodoCalendarBriefingError = {
  source: "calendar" | "attendees" | "notes" | "research" | "email";
  code: "read_failed";
};
export type TodoCalendarBriefingsResult = { briefings: TodoCalendarBriefing[]; partial: boolean; errors: TodoCalendarBriefingError[] };
const DAY = 86_400_000;
function compact(value: string | null, max = 320): string | null {
  if (value === null) return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
function safeURL(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
type Meeting = { id: string; title: string; start_time: string; end_time: string; all_day: number; location: string | null; status: string; connection_id: string; calendar_id: string; event_id: string; html_link: string | null; source_updated: string | null; description: string | null; attendees_complete: number };
type Attendee = { meeting_id: string; email: string | null; name: string | null; response_status: string | null; person_id: string | null };
type Note = { id: string; record_id: string; body: string; source_url: string | null; updated_at: number };
type Research = { record_id: string; summary: string; sources: string; checked_at: number };
type Mail = Note & { connection_id: string; message_id: string; received_ms: number };

/** Next [now, now + 14 days) starts, <=10 meetings, <=6 invitees each.
 * partial is true for DB-backed reads: imported Calendar/CRM and selected email
 * metadata can never establish exhaustive/live coverage. Missing DB is an empty
 * optional source, not a read error. Errors are sanitized, never provider text.
 */
export async function readTodoCalendarBriefings(db: D1Database | undefined, ownerID: string): Promise<TodoCalendarBriefingsResult> {
  const result: TodoCalendarBriefingsResult = { briefings: [], partial: false, errors: [] };
  if (!db) return result;
  result.partial = true;
  let session: D1DatabaseSession;
  try { session = db.withSession("first-primary"); } catch { result.errors.push({ source: "calendar", code: "read_failed" }); return result; }
  const read = async <T>(source: TodoCalendarBriefingError["source"], sql: string, ...bindings: (string | number)[]): Promise<T[]> => {
    try {
      const rows = await session.prepare(sql).bind(...bindings).all<T>();
      if (!rows.success) throw new Error("read_failed");
      return rows.results;
    } catch { result.errors.push({ source, code: "read_failed" }); return []; }
  };
  const now = Date.now();
  const meetings = await read<Meeting>("calendar", `SELECT id,title,start_time,end_time,all_day,location,status,connection_id,calendar_id,event_id,html_link,source_updated,description,attendees_complete
    FROM crm_meetings WHERE owner_id=? AND start_ms>=? AND start_ms<? AND status!='cancelled' AND self_declined=0 ORDER BY start_ms,id LIMIT 11`, ownerID, now, now + 14 * DAY);
  if (!meetings.length) return result;
  const selected = meetings.slice(0, 10), meetingIDs = JSON.stringify(selected.map(m => m.id));
  // Existing person_id is not sufficient: a later profile edit or ambiguous
  // alias must not attach the wrong person's private preparation context.
  const attendees = await read<Attendee>("attendees", `WITH bounded AS (
    SELECT *,row_number() OVER (PARTITION BY meeting_id ORDER BY ordinal) AS rn FROM crm_meeting_attendees
    WHERE owner_id=?1 AND meeting_id IN (SELECT value FROM json_each(?2))
  ) SELECT meeting_id,email,name,response_status,CASE WHEN person_id IS NOT NULL AND email IS NOT NULL
    AND (SELECT count(*) FROM crm_records r WHERE r.owner_id=?1 AND r.kind='person' AND
      (lower(trim(r.email))=lower(trim(b.email)) OR EXISTS (SELECT 1 FROM crm_identities i WHERE i.owner_id=r.owner_id AND i.record_id=r.id AND i.kind='email' AND i.normalized=lower(trim(b.email)))))=1
    AND EXISTS (SELECT 1 FROM crm_records r WHERE r.owner_id=?1 AND r.id=b.person_id AND r.kind='person' AND
      (lower(trim(r.email))=lower(trim(b.email)) OR EXISTS (SELECT 1 FROM crm_identities i WHERE i.owner_id=r.owner_id AND i.record_id=r.id AND i.kind='email' AND i.normalized=lower(trim(b.email)))))
    THEN person_id ELSE NULL END AS person_id FROM bounded b WHERE rn<=7 ORDER BY meeting_id,rn`, ownerID, meetingIDs);
  const shownAttendees = selected.flatMap(m => attendees.filter(a => a.meeting_id === m.id).slice(0, 6));
  const personIDs = JSON.stringify([...new Set(shownAttendees.flatMap(a => a.person_id ? [a.person_id] : []))]);
  const [notes, research, email, meetingNotes] = await Promise.all([
    read<Note>("notes", `SELECT id,record_id,body,source_url,updated_at FROM (
      SELECT n.*,row_number() OVER (PARTITION BY record_id ORDER BY created_at DESC,id DESC) AS rn FROM crm_notes n
      WHERE n.owner_id=?1 AND record_id IN (SELECT value FROM json_each(?2))
      AND NOT EXISTS (SELECT 1 FROM crm_email_imports i WHERE i.owner_id=n.owner_id AND i.note_id=n.id AND i.record_id=n.record_id)
    ) WHERE rn<=2`, ownerID, personIDs),
    read<Research>("research", `SELECT record_id,summary,sources,checked_at FROM crm_research WHERE owner_id=? AND record_id IN (SELECT value FROM json_each(?)) AND status='complete'`, ownerID, personIDs),
    read<Mail>("email", `SELECT * FROM (
      SELECT n.id,i.record_id,n.body,n.source_url,n.updated_at,i.connection_id,i.message_id,i.received_ms,
      row_number() OVER (PARTITION BY i.record_id ORDER BY i.received_ms DESC,i.connection_id,i.message_id) AS rn
      FROM crm_email_imports i JOIN crm_notes n ON n.owner_id=i.owner_id AND n.id=i.note_id AND n.record_id=i.record_id
      WHERE i.owner_id=? AND i.record_id IN (SELECT value FROM json_each(?))
    ) WHERE rn<=2`, ownerID, personIDs),
    read<{ id: string; meeting_id: string; body: string; updated_at: number }>("notes", `SELECT id,meeting_id,body,updated_at FROM (
      SELECT *,row_number() OVER (PARTITION BY meeting_id ORDER BY created_at DESC,id DESC) AS rn FROM crm_meeting_notes
      WHERE owner_id=? AND meeting_id IN (SELECT value FROM json_each(?))
    ) WHERE rn<=2`, ownerID, meetingIDs),
  ]);
  for (const m of selected) {
    const guests = attendees.filter(a => a.meeting_id === m.id);
    const reasons = ["Imported Calendar/CRM only; no live refresh. Invitation and RSVP do not prove attendance.",
      "At most 10 meetings, 6 invitees, 2 saved notes, 1 sourced research profile and 2 imported email metadata snippets per person; not an exhaustive history. Calendar description and research are not user meeting notes."];
    if (meetings.length > 10) reasons.push("Additional upcoming meetings omitted.");
    if (!m.attendees_complete || guests.length > 6) reasons.push("Attendee coverage is incomplete or truncated.");
    if (guests.some(a => !a.person_id)) reasons.push("Some invitees have no unambiguous exact CRM email/alias link; no context inferred by name or domain.");
    if (result.errors.length) reasons.push("Some imported sources could not be read.");
    result.briefings.push({
      id: m.id, title: compact(m.title) ?? "", start: m.start_time, end: m.end_time, all_day: Boolean(m.all_day), location: compact(m.location), status: m.status,
      source: { kind: "calendar", connection_id: m.connection_id, calendar_id: m.calendar_id, event_id: m.event_id, url: safeURL(m.html_link), source_updated: m.source_updated },
      description: m.description ? { text: compact(m.description, 480) ?? "", source: { kind: "calendar_description", reference: m.id, url: safeURL(m.html_link) } } : null,
      notes: meetingNotes.filter(n => n.meeting_id === m.id).map(n => ({ text: compact(n.body) ?? "", source: { kind: "user_meeting_note", reference: n.id, url: null, updated_at: n.updated_at } })),
      attendees: guests.slice(0, 6).map(a => {
        const context: TodoCalendarSnippet[] = [];
        if (a.person_id) {
          for (const n of notes.filter(n => n.record_id === a.person_id)) context.push({ text: compact(n.body) ?? "", source: { kind: "crm_note", reference: n.id, url: safeURL(n.source_url), updated_at: n.updated_at } });
          const r = research.find(r => r.record_id === a.person_id);
          if (r) {
            let sources: { kind: string; reference: string; detail?: string }[] = [];
            try { const parsed: unknown = JSON.parse(r.sources); if (Array.isArray(parsed)) sources = parsed.filter(s => s && ["web", "email", "calendar"].includes(s.kind) && typeof s.reference === "string" && s.reference.trim()).slice(0, 3).map(s => ({ kind: s.kind, reference: compact(s.reference, 2048)!, ...(typeof s.detail === "string" ? { detail: compact(s.detail)! } : {}) })); } catch { /* No unsourced research excerpt. */ }
            if (sources.length) context.push({ text: compact(r.summary) ?? "", source: { kind: "crm_research", reference: r.record_id, url: null, updated_at: r.checked_at, sources } });
          }
          for (const n of email.filter(n => n.record_id === a.person_id)) context.push({ text: compact(n.body) ?? "", source: { kind: "email_metadata", reference: n.id, url: safeURL(n.source_url), updated_at: n.received_ms, connection_id: n.connection_id, message_id: n.message_id } });
        }
        return { person_id: a.person_id, name: compact(a.name, 160), email: compact(a.email, 254), response_status: a.response_status, context };
      }),
      coverage: { limited: true, reasons },
    });
  }
  return result;
}
