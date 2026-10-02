/** Account-local durable work, sharing UserAccount's existing alarm. Reads never run a model. */
import { bindPreparedTodoMailDraft, handleTodoMail, readTodoMailDraft, todoMailContextFingerprint, assertTodoMailSourceApplicable, type TodoMailDraft } from "./todo-mail";
import { prepareDecisionProposal, type PreparationEvidence, type PreparationSource } from "./todo-preparation-model";
import { researchTodoCapture, TODO_RESEARCH_SCOPE } from "./todo-readonly-research";
import { prepareTodoTextProposal, TODO_TEXT_PROPOSAL_SCOPE } from "./todo-text-proposal";
import { browserEgressSubject } from "./browser-egress";
import { bindAgentCredential } from "./credentials";
import type { TodoMailSuggestionAI } from "./todo-mail-suggest";
import { emptyTodoPeople, readTodoPeople, todoContextEmails, todoSenderEmail, todoPeopleEvidence, type TodoPeopleContext } from "./todo-crm-context";
export type PreparationKind = "capture" | "decision";
export type PreparationView = TodoPeopleContext & { kind: "capture" | "email_reply" | "action_review" | null; status: "unprepared" | "pending" | "preparing" | "ready" | "blocked" | "failed";
  context: string; recommendation: string; proposal: string; draft_id: string | null; error: string | null;
  updated_at: string | null; prepared_draft: TodoMailDraft | null; sources: PreparationSource[]; scope: string };
type Job = { kind: PreparationKind; target_id: string; generation: number; target_version: number; state: PreparationView["status"];
  instructions: string; attempt: number; due_at: number; result: string; updated_at: string };
const scope = "Bounded account evidence only; no web research or external actions.";
export const unprepared = (): PreparationView => ({ ...emptyTodoPeople(), kind: null, status: "unprepared", context: "", recommendation: "", proposal: "", draft_id: null, error: null, updated_at: null, prepared_draft: null, sources: [], scope });
export function initializeTodoPreparation(storage: DurableObjectStorage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS todo_preparations (
    kind TEXT NOT NULL, target_id TEXT NOT NULL, generation INTEGER NOT NULL, target_version INTEGER NOT NULL,
    state TEXT NOT NULL, instructions TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL, result TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
    PRIMARY KEY(kind,target_id)
  ); CREATE TABLE IF NOT EXISTS todo_preparation_requests (
    operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL, version INTEGER NOT NULL,
    instructions TEXT NOT NULL, response TEXT NOT NULL
  );`);
}
/** Bounded, idempotent upgrade recovery; never resurrect completed/answered work. */
export function backfillTodoPreparation(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    // Reconcile legacy rows after versioned completion/reopen, without resurrecting done work.
    for (const kind of ["capture", "decision"] as const) {
      const table = kind === "capture" ? "todo_captures" : "todo_decisions";
      const eligible = kind === "capture" ? "'captured'" : "'needs_you','preparing'";
      storage.sql.exec(`UPDATE todo_preparations SET state='blocked',generation=generation+1,result='{"error":"stale_preparation"}'
        WHERE kind=? AND state IN ('pending','preparing','ready') AND NOT EXISTS
        (SELECT 1 FROM ${table} t WHERE t.id=target_id AND t.status IN (${eligible}) AND t.version=target_version)`, kind);
      const stale = storage.sql.exec<{id:string;version:number}>(`SELECT t.id,t.version FROM ${table} t JOIN todo_preparations p
        ON p.target_id=t.id AND p.kind=? WHERE t.status IN (${eligible}) AND t.version!=p.target_version LIMIT 25`, kind).toArray();
      for (const target of stale) enqueueTodoPreparation(storage, kind, target.id, target.version);
    }
    const captures = storage.sql.exec<{ id: string; version: number }>(`SELECT id,version FROM todo_captures c
      WHERE status='captured' AND NOT EXISTS (SELECT 1 FROM todo_preparations p WHERE p.kind='capture' AND p.target_id=c.id)
      ORDER BY created_at LIMIT 25`).toArray();
    for (const capture of captures) enqueueTodoPreparation(storage, "capture", capture.id, capture.version);
    const decisions = storage.sql.exec<{ id: string; version: number }>(`SELECT id,version FROM todo_decisions d
      WHERE status='needs_you' AND source_key LIKE 'gmail:%' AND source_connection_id IS NOT NULL
      AND source_thread_id IS NOT NULL AND source_message_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM todo_preparations p WHERE p.kind='decision' AND p.target_id=d.id)
      ORDER BY created_at LIMIT 25`).toArray();
    for (const decision of decisions) {
      storage.sql.exec("UPDATE todo_decisions SET status='preparing' WHERE id=?", decision.id);
      enqueueTodoPreparation(storage, "decision", decision.id, decision.version);
    }
  });
}
export function preparationView(storage: DurableObjectStorage, kind: PreparationKind, targetID: string): PreparationView {
  const row = storage.sql.exec<Job>("SELECT * FROM todo_preparations WHERE kind=? AND target_id=?", kind, targetID).toArray()[0];
  if (!row) return unprepared();
  const result: PreparationView = { ...unprepared(), ...JSON.parse(row.result), status: row.state, updated_at: row.updated_at };
  if (result.draft_id) {
    try { result.prepared_draft = readTodoMailDraft(storage, result.draft_id); }
    catch { result.status = "blocked"; result.error = "prepared_draft_unavailable"; }
  }
  return result;
}
export function enqueueTodoPreparation(storage: DurableObjectStorage, kind: PreparationKind, targetID: string, version: number, instructions = ""): PreparationView {
  const now = new Date().toISOString();
  const previous = preparationView(storage, kind, targetID);
  // Re-preparing invalidates approval/proposal, not the independently resolved CRM links.
  const retained = JSON.stringify({ people: previous.people, people_status: previous.people_status, people_coverage: previous.people_coverage });
  storage.sql.exec(`INSERT INTO todo_preparations(kind,target_id,generation,target_version,state,instructions,due_at,updated_at)
    VALUES(?,?,1,?,'pending',?,?,?) ON CONFLICT(kind,target_id) DO UPDATE SET
    generation=generation+1,target_version=excluded.target_version,state='pending',instructions=excluded.instructions,
    attempt=0,due_at=excluded.due_at,result=?,updated_at=excluded.updated_at`, kind, targetID, version, instructions, Date.now(), now, retained);
  return preparationView(storage, kind, targetID);
}
export function nextTodoPreparationAlarm(storage: DurableObjectStorage): number | undefined {
  return storage.sql.exec<{ at: number | null }>("SELECT MIN(due_at) AS at FROM todo_preparations WHERE state IN ('pending','preparing')").toArray()[0]?.at ?? undefined;
}
export async function scheduleTodoPreparation(storage: DurableObjectStorage): Promise<void> {
  const next = nextTodoPreparationAlarm(storage); if (next === undefined) return;
  const current = await storage.getAlarm(); if (current === null || current > next) await storage.setAlarm(Math.max(Date.now() + 25, next));
}
export type PreparationDependencies = { ownerID: string; binding?: Fetcher; ai?: TodoMailSuggestionAI; crm?: D1Database };
async function mail(deps: PreparationDependencies, storage: DurableObjectStorage, path: string, body?: unknown): Promise<any> {
  if (!(body === undefined && /^\/mail\/threads\/[A-Za-z0-9_-]+\?connection_id=/.test(path)) && !(body !== undefined && path === "/mail/drafts")) throw new Error("preparation_action_forbidden");
  const response = await handleTodoMail(new Request(`https://user.internal/todo${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), storage, deps.binding, deps.ownerID, deps.ai);
  const result = await response.json() as any;
  if (!response.ok) throw new Error(["connection_not_found", "connector_permission_required", "not_found", "connector_unavailable"].includes(result.error) ? result.error : "source_unavailable");
  return result;
}
function singleMailbox(raw: string): string {
  // Ambiguity blocks preparation rather than silently guessing recipients. The draft validator checks syntax too.
  const value = raw.trim(), match = /^(?:[^<>\r\n]*<([^<>\r\n]+)>|([^<>\r\n]+))$/.exec(value);
  const address = (match?.[1] ?? match?.[2] ?? "").trim();
  if (!address || /[,;\s]/.test(address) || address.split("@").length !== 2) throw new Error("ambiguous_reply_recipient");
  return address;
}
function assertJobCurrent(storage: DurableObjectStorage, job: Job): void {
  const current = storage.sql.exec<Job>("SELECT * FROM todo_preparations WHERE kind=? AND target_id=?", job.kind, job.target_id).toArray()[0];
  const table = job.kind === "capture" ? "todo_captures" : "todo_decisions";
  const target = storage.sql.exec<{version:number;status:string}>(`SELECT version,status FROM ${table} WHERE id=?`, job.target_id).toArray()[0];
  if (current?.generation !== job.generation || current.attempt !== job.attempt || current.state !== "preparing"
    || target?.version !== job.target_version || !(job.kind === "capture" ? ["captured"] : ["needs_you", "preparing"]).includes(target.status)) throw new Error("stale_preparation");
}
async function prepareJob(storage: DurableObjectStorage, deps: PreparationDependencies, job: Job, retained: { context: TodoPeopleContext }): Promise<PreparationView> {
  const evidence: PreparationEvidence[] = [];
  let preparationScope = scope;
  let ownerRequest = "", thread: any, source: any, recipients: string[] = [], fingerprint = "", actionReview = false;
  if (job.kind === "capture") {
    const capture = storage.sql.exec<{body:string;status:string;version:number}>("SELECT body,status,version FROM todo_captures WHERE id=?", job.target_id).toArray()[0];
    if (!capture || capture.status !== "captured" || capture.version !== job.target_version) throw new Error("stale_preparation");
    ownerRequest = capture.body;
    retained.context = await readTodoPeople(deps.crm, deps.ownerID, todoContextEmails(ownerRequest));
    assertJobCurrent(storage, job);
    evidence.push({ kind: "user", reference: `capture:${job.target_id}`, detail: "Owner's captured request", content: ownerRequest });
    const textProposal = prepareTodoTextProposal(ownerRequest, job.instructions);
    if (textProposal !== null) {
      assertJobCurrent(storage, job);
      return { ...unprepared(), kind: "capture", status: "ready",
        context: "Owner-supplied lines, preserved verbatim and in order.",
        recommendation: "Review the formatted text; its factual content has not been verified.",
        proposal: textProposal, scope: TODO_TEXT_PROPOSAL_SCOPE,
        updated_at: new Date().toISOString(), sources: evidence.map(({ content: _, ...source }) => source) };
    }
    evidence.push(...todoPeopleEvidence(retained.context));
    // Pure transformations need no public lookup. Other captures use only the
    // fixed public search RPC; email/CRM evidence is never sent to the planner.
    if (!/^(?:rewrite|summarize|summarise|translate|rephrase|organize these notes|format this)\b/i.test(ownerRequest.trim())) {
      let subject: string | undefined;
      if (deps.binding && deps.ai) {
        subject = await browserEgressSubject(deps.ownerID, "todo-capture-research-v1");
        await bindAgentCredential(deps.binding, subject, deps.ownerID);
        assertJobCurrent(storage, job);
      }
      const research = await researchTodoCapture({ binding: deps.binding, ai: deps.ai, subject }, {
        owner_request: ownerRequest, owner_changes: job.instructions,
        request_id: [job.target_id, job.generation, job.attempt].join(":"),
      });
      assertJobCurrent(storage, job);
      preparationScope = TODO_RESEARCH_SCOPE;
      if (research.status !== "researched") return { ...unprepared(), kind: "capture", status: "blocked",
        context: "Public evidence is unavailable or the request requires private information/actions.",
        recommendation: "Supply missing evidence or narrow the request; no completed proposal is claimed.",
        error: research.error, scope: preparationScope, updated_at: new Date().toISOString(),
        sources: evidence.map(({ content: _, ...source }) => source) };
      evidence.push(...research.evidence);
    }
  } else {
    const decision = storage.sql.exec<any>("SELECT * FROM todo_decisions WHERE id=?", job.target_id).toArray()[0];
    if (!decision || decision.version !== job.target_version || !["needs_you", "preparing"].includes(decision.status)) throw new Error("stale_preparation");
    actionReview = decision.source_key.startsWith("gmail:gmail-action-review-triage-v1:");
    if (!decision.source_connection_id || !decision.source_thread_id || !decision.source_message_id) throw new Error("missing_source_context");
    const result = await mail(deps, storage, `/mail/threads/${encodeURIComponent(decision.source_thread_id)}?connection_id=${encodeURIComponent(decision.source_connection_id)}`);
    thread = result.thread;
    source = thread?.messages?.find((message: any) => message.id === decision.source_message_id && message.thread_id === decision.source_thread_id);
    if (thread?.id !== decision.source_thread_id || !source) throw new Error("incomplete_source_context");
    retained.context = await readTodoPeople(deps.crm, deps.ownerID, todoSenderEmail(source.from));
    assertJobCurrent(storage, job);
    evidence.push(...todoPeopleEvidence(retained.context));
    if (thread.messages.length > 20 || thread.messages.at(-1)?.id !== source.id) throw new Error("incomplete_source_context");
    if (thread.messages.some((message: any) => message.body_truncated || !message.body_text || message.body_text.length > 6000 || message.attachments?.length)) throw new Error("incomplete_source_context");
    assertTodoMailSourceApplicable(thread, source.id);
    fingerprint = await todoMailContextFingerprint(thread);
    if (!actionReview) recipients = [singleMailbox(source.reply_to || source.from)];
    ownerRequest = actionReview ? "Prepare a grounded action review of this automated message: explain the required owner judgment, urgency and complete proposed next action based only on supplied evidence. Do not reply, act, follow links, infer successful payment or signature, or claim source authenticity. Block if the actual required action cannot be established." : "Prepare a complete, grounded reply for review. Do not send. If the owner's answer or required facts are unknown, block rather than guess.";
    for (const message of thread.messages) evidence.push({ kind: "email", reference: `gmail:${decision.source_connection_id}:${message.id}`,
      detail: `Email from ${message.from.slice(0, 120)}`, content: JSON.stringify({ from: message.from, to: message.to, subject: message.subject, body: message.body_text }) });
  }
  const prepared = await prepareDecisionProposal(deps.ai, { kind: job.kind === "capture" ? "capture" : actionReview ? "action_review" : "email_reply", owner_request: ownerRequest, owner_changes: job.instructions, evidence });
  const result: PreparationView = { ...unprepared(), kind: job.kind === "capture" ? "capture" : actionReview ? "action_review" : "email_reply", status: prepared.status, context: prepared.context, recommendation: prepared.recommendation,
    proposal: prepared.proposal, draft_id: null, error: prepared.status === "blocked" ? prepared.missing_information : null,
    updated_at: new Date().toISOString(), scope: preparationScope, prepared_draft: null, sources: evidence.filter(source => prepared.source_references.includes(source.reference)).map(({ content: _, ...source }) => source) };
  // Search excerpts do not prove the whole captured decision is complete.
  // Fail closed pending a structured, independently verifiable completion gate;
  // keep useful sourced analysis visible, never mark research as ready.
  if (job.kind === "capture" && result.status === "ready") {
    result.status = "blocked";
    result.error = "complete_capture_proposal_unverified";
    result.recommendation = "Review the sourced analysis; the full requested decision remains unverified.";
  }
  // Recheck content after inference. Read/label changes alone are not content changes,
  // but archive/spam/trash/source replacement removes applicability.
  if (job.kind === "decision") {
    const latest = await mail(deps, storage, `/mail/threads/${encodeURIComponent(thread.id)}?connection_id=${encodeURIComponent(thread.connection_id)}`);
    assertTodoMailSourceApplicable(latest.thread, source.id);
    if (await todoMailContextFingerprint(latest.thread) !== fingerprint) throw new Error("stale_source_context");
  }
  assertJobCurrent(storage, job);
  if (prepared.status === "ready" && job.kind === "decision" && !actionReview) {
    // Reserve the binding BEFORE any awaited draft save. Even an orphan is fenced
    // and cannot accidentally fall back to the manually composed draft send gate.
    const draftID = crypto.randomUUID();
    bindPreparedTodoMailDraft(storage, draftID, job.target_id, job.generation, job.target_version, fingerprint);
    const saved = await mail(deps, storage, "/mail/drafts", { id: draftID, version: 0, mode: "reply", connection_id: thread.connection_id,
      to: recipients, cc: [], bcc: [], subject: /^re:/i.test(source.subject) ? source.subject : `Re: ${source.subject}`,
      body_text: prepared.body_text, thread_id: thread.id, reply_message_id: source.id });
    assertJobCurrent(storage, job);
    result.draft_id = saved.draft.id;
  }
  return result;
}
const safeErrors = new Set(["preparation_unavailable", "invalid_preparation", "source_unavailable", "connector_unavailable", "connector_permission_required",
  "connection_not_found", "not_found", "ambiguous_reply_recipient", "missing_source_context", "incomplete_source_context", "stale_preparation", "stale_source_context"]);
/** One bounded job per alarm; an interrupted read/model job resumes after its lease, never a send. */
export async function runTodoPreparation(storage: DurableObjectStorage, deps: PreparationDependencies): Promise<void> {
  backfillTodoPreparation(storage);
  const now = Date.now();
  const job = storage.sql.exec<Job>("SELECT * FROM todo_preparations WHERE state IN ('pending','preparing') AND due_at<=? ORDER BY due_at LIMIT 1", now).toArray()[0];
  if (!job) return;
  if (job.attempt >= 3) {
    storage.sql.exec("UPDATE todo_preparations SET state='failed',result=?,updated_at=? WHERE kind=? AND target_id=? AND generation=?",
      JSON.stringify({ ...preparationView(storage, job.kind, job.target_id), error: "preparation_interrupted" }), new Date().toISOString(), job.kind, job.target_id, job.generation);
    if (job.kind === "decision") storage.sql.exec("UPDATE todo_decisions SET status='needs_you' WHERE id=? AND version=? AND status='preparing'", job.target_id, job.target_version);
    return;
  }
  storage.sql.exec("UPDATE todo_preparations SET state='preparing',attempt=attempt+1,due_at=?,updated_at=? WHERE kind=? AND target_id=? AND generation=?", now + 120_000, new Date().toISOString(), job.kind, job.target_id, job.generation);
  job.attempt += 1;
  // Lease is durable before awaiting I/O; eviction cannot strand an in-progress capture.
  await scheduleTodoPreparation(storage);
  let result: PreparationView;
  const previous = preparationView(storage, job.kind, job.target_id);
  const retained = { context: { people: previous.people, people_status: previous.people_status, people_coverage: previous.people_coverage } };
  try { result = { ...await prepareJob(storage, deps, job, retained), ...retained.context }; }
  catch (error) {
    const code = error instanceof Error && safeErrors.has(error.message) ? error.message : "preparation_unavailable";
    result = { ...unprepared(), ...retained.context, status: ["ambiguous_reply_recipient", "missing_source_context", "incomplete_source_context", "stale_preparation", "stale_source_context", "connector_permission_required", "connection_not_found", "not_found"].includes(code) ? "blocked" : "failed", error: code, updated_at: new Date().toISOString() };
  }
  storage.transactionSync(() => {
    const current = storage.sql.exec<Job>("SELECT * FROM todo_preparations WHERE kind=? AND target_id=?", job.kind, job.target_id).toArray()[0];
    if (current?.generation !== job.generation || current.attempt !== job.attempt || current.state !== "preparing") return;
    const table = job.kind === "capture" ? "todo_captures" : "todo_decisions";
    const target = storage.sql.exec<{version:number;status:string}>(`SELECT version,status FROM ${table} WHERE id=?`, job.target_id).toArray()[0];
    if (target?.version !== job.target_version || !(job.kind === "capture" ? ["captured"] : ["preparing", "needs_you"]).includes(target.status)) {
      result = { ...unprepared(), status: "blocked", error: "stale_preparation", updated_at: new Date().toISOString() };
    }
    if (result.status === "failed" && result.error !== "invalid_preparation" && job.attempt < 3) {
      storage.sql.exec("UPDATE todo_preparations SET state='pending',due_at=?,result=?,updated_at=? WHERE kind=? AND target_id=? AND generation=? AND attempt=?",
        Date.now() + 1000 * 5 ** (job.attempt - 1), JSON.stringify(result), new Date().toISOString(), job.kind, job.target_id, job.generation, job.attempt);
      return;
    }
    storage.sql.exec("UPDATE todo_preparations SET state=?,result=?,updated_at=? WHERE kind=? AND target_id=? AND generation=?", result.status, JSON.stringify(result), new Date().toISOString(), job.kind, job.target_id, job.generation);
    if (job.kind === "decision" && ["ready", "blocked", "failed"].includes(result.status)) storage.sql.exec("UPDATE todo_decisions SET status='needs_you' WHERE id=? AND version=? AND status='preparing'", job.target_id, job.target_version);
  });
}
