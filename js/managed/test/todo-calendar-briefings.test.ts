import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { crmRequest } from "../src/crm";
import { crmIdentityRequest } from "../src/crm-identities";
import { crmMeetingRequest, importCalendarEvents } from "../src/crm-meetings";
import { crmResearchRequest } from "../src/crm-research";
import { readTodoCalendarBriefings } from "../src/todo-calendar-briefings";

// Real workerd D1 + production migrations, synthetic sources only. No external
// account data, model, network, sync, writes or inferred attendance on reads.
const bindings = env as unknown as { NANOCODEX_CRM: D1Database; CRM_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.NANOCODEX_CRM;
const NOW = Date.parse("2026-09-30T12:00:00Z"), DAY = 86_400_000;
beforeAll(async () => { await applyD1Migrations(db, bindings.CRM_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());
const owner = () => `briefing-${crypto.randomUUID()}`;
const clock = () => vi.spyOn(Date, "now").mockReturnValue(NOW);
const event = (id = "meeting", patch: Record<string, unknown> = {}) => ({
  id, summary: "Synthetic planning", description: "Invitation agenda, NOT user meeting notes", status: "confirmed",
  updated: "2026-09-30T10:00:00Z", htmlLink: "https://calendar.google.com/calendar/event?eid=synthetic",
  start: { dateTime: new Date(NOW + DAY).toISOString() }, end: { dateTime: new Date(NOW + DAY + 3600_000).toISOString() },
  attendees: [{ email: "guest@example.test", displayName: "Calendar guest", responseStatus: "accepted" }], ...patch,
});
const sync = (account: string, events: unknown[]) => importCalendarEvents(db, account, { connection_id: "synthetic-google", calendar_id: "primary", events });
const person = (account: string, id: string, email: string) => crmRequest(db, account, "save", { kind: "person", name: `Manual ${id}`, email }, id);
const note = (account: string, id: string, personID: string, body: string, when = 1, url: string | null = null) =>
  db.prepare("INSERT INTO crm_notes(owner_id,id,record_id,body,source_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .bind(account, id, personID, body, url, when, when).run();
const list = async (account: string): Promise<any[]> => (await crmMeetingRequest(db, account, "list", {}, "unused") as any).meetings;

describe("grounded compact calendar briefings", () => {
  it("returns an optional empty DB and sanitized read failures", async () => {
    expect(await readTodoCalendarBriefings(undefined, "synthetic")).toEqual({ briefings: [], partial: false, errors: [] });
    const broken = { withSession() { throw new Error("secret provider traceback"); } } as unknown as D1Database;
    expect(await readTodoCalendarBriefings(broken, "synthetic")).toEqual({ briefings: [], partial: true, errors: [{ source: "calendar", code: "read_failed" }] });
  });
  it("grounds distinct description, saved notes, sourced research and email metadata without reads causing actions", async () => {
    clock(); const account = owner(); await person(account, "guest", "guest@example.test"); await sync(account, [event()]);
    await note(account, "manual-note", "guest", "User-saved context", 20, "https://synthetic.example/context");
    await note(account, "email-note", "guest", "Received email (untrusted source metadata) Subject: Synthetic proposal", 30, "https://mail.google.com/mail/u/0/#all/synthetic-mail");
    await db.prepare("INSERT INTO crm_email_imports(owner_id,connection_id,message_id,record_id,note_id,imported_at,received_ms) VALUES(?,?,?,?,?,?,?)")
      .bind(account, "synthetic-google", "synthetic-mail", "guest", "email-note", 30, 10).run();
    await crmResearchRequest(db, account, "save", { record_id: "guest", status: "complete", summary: "Sourced synthetic biography", sources: [{ kind: "web", reference: "https://synthetic.example/bio" }] });
    const before = (await list(account))[0];
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external calls allowed"));
    const queries: string[] = [];
    const audited = { withSession: () => ({ prepare(sql: string) { queries.push(sql); return db.prepare(sql); } }) } as unknown as D1Database;
    const result = await readTodoCalendarBriefings(audited, account), brief = result.briefings[0];
    expect(result.errors).toEqual([]); expect(result.partial).toBe(true);
    expect(brief.source).toMatchObject({ kind: "calendar", event_id: "meeting", connection_id: "synthetic-google" });
    expect(brief.description).toMatchObject({ text: "Invitation agenda, NOT user meeting notes", source: { kind: "calendar_description", reference: before.id } });
    expect(brief.notes).toEqual([]);
    expect(brief.attendees[0]).toMatchObject({ person_id: "guest", name: "Calendar guest", response_status: "accepted" });
    expect(brief.attendees[0].context.map(s => s.source.kind)).toEqual(["crm_note", "crm_research", "email_metadata"]);
    expect(brief.attendees[0].context[1].source.sources).toEqual([{ kind: "web", reference: "https://synthetic.example/bio" }]);
    expect(brief.attendees[0].context[2].source).toMatchObject({ connection_id: "synthetic-google", message_id: "synthetic-mail", updated_at: 10 });
    expect(brief.coverage.reasons.join(" ")).toContain("do not prove attendance");
    expect(fetch).not.toHaveBeenCalled();
    expect(queries.every(sql => /^(SELECT|WITH)\b/.test(sql.trim()))).toBe(true);
    expect((await crmMeetingRequest(db, account, "get", { id: before.id }, "unused") as any).notes).toEqual([]);
  });
  it("scopes meetings and context to owner, even with identical record IDs and emails", async () => {
    clock(); const account = owner(), foreign = owner();
    await person(account, "guest", "guest@example.test"); await person(foreign, "guest", "guest@example.test");
    await sync(account, [event("own")]); await sync(foreign, [event("foreign")]);
    await note(account, "own-note", "guest", "Own context"); await note(foreign, "foreign-note", "guest", "PRIVATE OTHER ACCOUNT");
    const result = await readTodoCalendarBriefings(db, account);
    expect(result.errors).toEqual([]); expect(result.briefings.map(b => b.source.event_id)).toEqual(["own"]);
    expect(result.briefings[0].attendees[0].context.map(s => s.text)).toEqual(["Own context"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE OTHER ACCOUNT"); expect(JSON.stringify(result)).not.toContain("owner_id");
  });
  it("restricts next 14-day non-cancelled, non-self-declined starts and preserves all-day metadata", async () => {
    clock(); const account = owner();
    const at = (ms: number) => ({ start: { dateTime: new Date(ms).toISOString() }, end: { dateTime: new Date(ms + 3600_000).toISOString() } });
    await sync(account, [event("now", at(NOW)), event("past", at(NOW - 1)), event("edge", at(NOW + 14 * DAY)), event("inside", at(NOW + 14 * DAY - 1)),
      event("cancelled", { status: "cancelled" }), event("declined", { attendees: [{ self: true, email: "self@example.test", responseStatus: "declined" }, { email: "guest@example.test" }] }),
      event("all-day", { start: { date: "2026-10-02" }, end: { date: "2026-10-03" } })]);
    const result = await readTodoCalendarBriefings(db, account);
    expect(result.errors).toEqual([]); expect(result.briefings.map(b => b.source.event_id)).toEqual(["now", "all-day", "inside"]);
    expect(result.briefings[1]).toMatchObject({ all_day: true, start: "2026-10-02", end: "2026-10-03" });
  });
  it("revalidates stored links after changed or ambiguous emails without name/domain guesses", async () => {
    clock(); const account = owner(); await person(account, "guest", "guest@example.test"); await sync(account, [event()]);
    await note(account, "sensitive", "guest", "Sensitive exact-person context");
    await crmRequest(db, account, "save", { id: "guest", email: "changed@example.test" }, "unused");
    expect((await readTodoCalendarBriefings(db, account)).briefings[0].attendees[0]).toMatchObject({ person_id: null, context: [] });
    await crmIdentityRequest(db, account, "save", { record_id: "guest", kind: "email", value: "guest@example.test", origin: "user" }, "alias");
    const alias = await readTodoCalendarBriefings(db, account);
    expect(alias.errors).toEqual([]); expect(alias.briefings[0].attendees[0].person_id).toBe("guest");
    await person(account, "duplicate", "guest@example.test");
    const ambiguous = await readTodoCalendarBriefings(db, account);
    expect(ambiguous.briefings[0].attendees[0]).toMatchObject({ person_id: null, context: [] });
    expect(ambiguous.briefings[0].coverage.reasons.join(" ")).toContain("no unambiguous exact CRM");
  });
  it("bounds output, sanitizes links, separates real user meeting notes and discloses truncation", async () => {
    clock(); const account = owner(); await person(account, "guest-zero", "guest0@example.test");
    const attendees = Array.from({ length: 9 }, (_, i) => ({ email: `guest${i}@example.test`, displayName: `Guest ${i}` }));
    await sync(account, Array.from({ length: 12 }, (_, i) => event(`event-${i}`, { summary: "t".repeat(700), description: "d".repeat(2000), attendees,
      start: { dateTime: new Date(NOW + (i + 1) * 3600_000).toISOString() }, end: { dateTime: new Date(NOW + (i + 2) * 3600_000).toISOString() } })));
    for (let i = 0; i < 5; i++) await note(account, `note-${i}`, "guest-zero", "n".repeat(800), i, "javascript:alert(1)");
    const meetingID = (await list(account))[0].id;
    await crmMeetingRequest(db, account, "note", { meeting_id: meetingID, body: "User explicitly supplied observations" }, "real-meeting-note");
    const result = await readTodoCalendarBriefings(db, account);
    expect(result.errors).toEqual([]); expect(result.briefings).toHaveLength(10);
    for (const b of result.briefings) {
      expect(b.title.length).toBeLessThanOrEqual(320); expect(b.description!.text.length).toBeLessThanOrEqual(480);
      expect(b.attendees).toHaveLength(6); expect(b.attendees[0].context).toHaveLength(2);
      expect(b.attendees[0].context.every(n => n.text.length <= 320 && n.source.url === null)).toBe(true);
      expect(b.coverage.reasons.join(" ")).toContain("Additional upcoming meetings omitted");
      expect(b.coverage.reasons.join(" ")).toContain("incomplete or truncated");
    }
    expect(result.briefings[0].notes).toEqual([{ text: "User explicitly supplied observations", source: { kind: "user_meeting_note", reference: "real-meeting-note", url: null, updated_at: NOW } }]);
  });
  it("omits needs-review research; preserves Calendar evidence on context-read failure", async () => {
    clock(); const account = owner(); await person(account, "guest", "guest@example.test"); await sync(account, [event()]);
    await crmResearchRequest(db, account, "save", { record_id: "guest", status: "needs_review", summary: "Identity ambiguous", sources: [] });
    expect((await readTodoCalendarBriefings(db, account)).briefings[0].attendees[0].context).toEqual([]);
    const broken = { withSession: () => ({ prepare(sql: string) { if (sql.includes("FROM crm_research")) throw new Error("PRIVATE SQL internals"); return db.prepare(sql); } }) } as unknown as D1Database;
    const result = await readTodoCalendarBriefings(broken, account);
    expect(result.briefings).toHaveLength(1); expect(result.briefings[0].description!.source.kind).toBe("calendar_description");
    expect(result.errors).toEqual([{ source: "research", code: "read_failed" }]);
    expect(result.briefings[0].coverage.reasons.join(" ")).toContain("could not be read"); expect(JSON.stringify(result)).not.toContain("PRIVATE SQL");
  });
});
