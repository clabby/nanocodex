/** Durable account-owned Swift source. Native hosts validate and execute swift-v1. */
export const APP_DOCUMENT_BYTES = 256 * 1024;
export const APP_DATA_BYTES = 256 * 1024;
export const APP_RUNTIME = "swift-v1";
const MAX_APPS = 100;
const fields = "id,title,description,runtime,source,revision,created_at,updated_at";
const summaryFields = "id,title,description,runtime,revision,created_at,updated_at";
const encoder = new TextEncoder();
export type AppOperation = "list" | "get" | "validate" | "save" | "delete" | "restore" | "data_get" | "data_set";
export type AppValidationInput = { runtime: "swift-v1"; source: string; state: Record<string, unknown>; steps?: unknown[]; agent_response?: string };
export type AppValidationResult = { valid: boolean; runtime: "swift-v1"; source_sha256: string; stage: string; [key: string]: unknown };
export type AppValidator = (input: AppValidationInput) => Promise<AppValidationResult>;
export class AppError extends Error {
  constructor(public code: string, public status = 400, public validation?: AppValidationResult) { super(code); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_input");
  return value as Record<string, unknown>;
}
function revision(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new AppError("invalid_revision");
  return value as number;
}
function appId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new AppError("invalid_id");
  return value;
}
function text(value: unknown, bytes: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || encoder.encode(value).length > bytes)
    throw new AppError("invalid_input");
  return value;
}
function jsonData(value: unknown): string {
  // JSON serialization must not silently coerce undefined, non-finite numbers,
  // class instances or sparse arrays supplied by a tool runtime.
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 64) throw new AppError("invalid_data");
    if (item === null || typeof item === "boolean" || typeof item === "string") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || seen.has(item)) throw new AppError("invalid_data");
    seen.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) visit(item[i], depth + 1);
    } else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) throw new AppError("invalid_data");
      for (const entry of Object.values(item)) visit(entry, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
  const result = JSON.stringify(value);
  if (encoder.encode(result).length > APP_DATA_BYTES) throw new AppError("data_too_large", 413);
  return result;
}
export function appValidationInput(input: Record<string, unknown>, state: unknown = {}): AppValidationInput {
  if (input.runtime !== APP_RUNTIME) throw new AppError("unsupported_runtime");
  const source = text(input.source, APP_DOCUMENT_BYTES);
  const stored = state === null ? {} : object(state);
  jsonData(stored);
  const steps = input.steps;
  if (steps !== undefined) {
    if (!Array.isArray(steps) || steps.length > 32 || encoder.encode(jsonData(steps)).length > 32768) throw new AppError("invalid_validation_steps");
    for (const raw of steps) {
      const step = object(raw);
      const allowed: Record<string, string[]> = { tap: ["action", "title"], set: ["action", "binding", "value"], expect: ["action", "text"], reopen: ["action"] };
      if (typeof step.action !== "string" || !Object.hasOwn(allowed, step.action)
        || Object.keys(step).some(key => !allowed[step.action as string].includes(key))) throw new AppError("invalid_validation_steps");
      if (step.action === "tap") text(step.title, 2048);
      if (step.action === "set") { text(step.binding, 256); if (!Object.hasOwn(step, "value")) throw new AppError("invalid_validation_steps"); }
      if (step.action === "expect") text(step.text, 4096, true);
    }
  }
  const agentResponse = input.agent_response === undefined ? undefined : text(input.agent_response, 16384, true);
  return { runtime: APP_RUNTIME, source, state: stored, ...(steps === undefined ? {} : { steps: steps as unknown[] }),
    ...(agentResponse === undefined ? {} : { agent_response: agentResponse }) };
}
export async function runAppValidation(input: AppValidationInput, validator?: AppValidator): Promise<AppValidationResult> {
  if (!validator) throw new AppError("app_validation_unavailable", 503);
  const result = await validator(input);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input.source)))].map(x => x.toString(16).padStart(2, "0")).join("");
  if (!result || typeof result.valid !== "boolean" || result.runtime !== APP_RUNTIME || result.source_sha256 !== hash
    || typeof result.stage !== "string" || encoder.encode(JSON.stringify(result)).length > 512 * 1024) throw new AppError("invalid_app_validation_result", 503);
  return result;
}
async function requireValidApp(input: AppValidationInput, validator?: AppValidator): Promise<AppValidationResult> {
  const result = await runAppValidation(input, validator);
  if (!result.valid) throw new AppError("app_validation_failed", 422, result);
  return result;
}
export async function appRequest(db: D1Database, owner: string, operation: AppOperation, value: unknown,
  createId = crypto.randomUUID(), validator?: AppValidator): Promise<unknown> {
  const input = object(value);
  const allowed: Record<AppOperation, string[]> = {
    list: ["limit", "cursor"], get: ["id"], save: ["id", "title", "description", "runtime", "source", "revision", "steps", "agent_response"],
    validate: ["id", "runtime", "source", "state", "steps", "agent_response"],
    delete: ["id", "revision"], restore: ["id", "revision"], data_get: ["id"], data_set: ["id", "value", "revision"],
  };
  if (!Object.hasOwn(allowed, operation) || Object.keys(input).some(key => !allowed[operation].includes(key))) throw new AppError("invalid_input");
  if (operation === "save" && input.runtime !== APP_RUNTIME) throw new AppError("unsupported_runtime");
  const session = db.withSession("first-primary");
  const now = new Date().toISOString();
  if (operation === "list") {
    const limit = input.limit === undefined ? 30 : revision(input.limit);
    if (limit > 100) throw new AppError("invalid_limit");
    const cursor = input.cursor === undefined ? "" : appId(input.cursor);
    const rows = (await session.prepare(`SELECT ${summaryFields} FROM prompt_apps WHERE owner_id=? AND id>? ORDER BY id LIMIT ?`)
      .bind(owner, cursor, limit + 1).all<{ id: string }>()).results;
    return { apps: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  if (operation === "validate") {
    let state = input.state ?? {};
    if (input.id !== undefined) {
      const row = await session.prepare("SELECT source,data_json FROM prompt_apps WHERE owner_id=? AND id=?")
        .bind(owner, appId(input.id)).first<{ source: string; data_json: string }>();
      if (!row) throw new AppError("not_found", 404);
      if (input.source === undefined) input.source = row.source;
      if (input.runtime === undefined) input.runtime = APP_RUNTIME;
      if (input.state === undefined) state = JSON.parse(row.data_json);
    }
    return runAppValidation(appValidationInput(input, state), validator);
  }
  if (operation === "save" && input.id === undefined) {
    if (input.revision !== undefined) throw new AppError("invalid_revision");
    const title = text(input.title, 256), description = text(input.description ?? "", 2048, true), source = text(input.source, APP_DOCUMENT_BYTES);
    const id = appId(createId);
    const prior = await session.prepare(`SELECT ${fields},data_json FROM prompt_apps WHERE owner_id=? AND id=?`).bind(owner, id).first<{ source: string; data_json: string; [key: string]: unknown }>();
    if (prior) {
      const { data_json, ...document } = prior;
      const validation = await requireValidApp(appValidationInput({ ...input, source: prior.source }, JSON.parse(data_json)), validator);
      return { ...document, validation };
    }
    const validation = await requireValidApp(appValidationInput(input), validator);
    const result = await session.prepare(`INSERT INTO prompt_apps (owner_id,id,title,description,runtime,source,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM prompt_apps WHERE owner_id=?) < ?
      ON CONFLICT(owner_id,id) DO NOTHING RETURNING ${fields}`)
      .bind(owner, id, title, description, APP_RUNTIME, source, now, now, owner, MAX_APPS).first();
    if (result) return { ...result, validation };
    // A concurrent creation may have won while the native preflight was running.
    // Retry reads and validates that retained source rather than claiming our candidate was saved.
    const existing = await session.prepare(`SELECT ${fields} FROM prompt_apps WHERE owner_id=? AND id=?`).bind(owner, id).first();
    if (existing) throw new AppError("revision_conflict", 409);
    throw new AppError("app_limit_reached", 409);
  }
  const id = appId(input.id);
  if (operation === "get") {
    const result = await session.prepare(`SELECT ${fields} FROM prompt_apps WHERE owner_id=? AND id=?`).bind(owner, id).first();
    if (!result) throw new AppError("not_found", 404);
    return result;
  }
  if (operation === "data_get") {
    const result = await session.prepare("SELECT data_json,data_revision,data_updated_at FROM prompt_apps WHERE owner_id=? AND id=?")
      .bind(owner, id).first<{ data_json: string; data_revision: number; data_updated_at: string | null }>();
    if (!result) throw new AppError("not_found", 404);
    return { value: JSON.parse(result.data_json), revision: result.data_revision, updated_at: result.data_updated_at };
  }
  const expected = revision(input.revision, operation === "data_set" ? 0 : 1);
  let result;
  let validation: AppValidationResult | undefined;
  let checkedDataRevision: number | undefined;
  if (operation === "save" || operation === "restore") {
    // Validate exactly the data revision used by this edit; concurrent app activity
    // must not make a successful preflight apply to a different persisted state.
    const row = await session.prepare("SELECT revision,previous_source,data_json,data_revision FROM prompt_apps WHERE owner_id=? AND id=?")
      .bind(owner, id).first<{ revision: number; previous_source: string | null; data_json: string; data_revision: number }>();
    if (!row) throw new AppError("not_found", 404);
    if (row.revision !== expected) throw new AppError("revision_conflict", 409);
    if (operation === "restore" && row.previous_source === null) throw new AppError("no_previous_revision", 409);
    if (operation === "save") { text(input.title, 256); text(input.description ?? "", 2048, true); }
    const candidate = operation === "restore" ? { runtime: APP_RUNTIME, source: row.previous_source } : input;
    validation = await requireValidApp(appValidationInput(candidate, JSON.parse(row.data_json)), validator);
    checkedDataRevision = row.data_revision;
  }
  if (operation === "save") {
    const title = text(input.title, 256), description = text(input.description ?? "", 2048, true), source = text(input.source, APP_DOCUMENT_BYTES);
    result = await session.prepare(`UPDATE prompt_apps SET previous_title=title,previous_description=description,previous_source=source,title=?,description=?,source=?,revision=revision+1,updated_at=?
      WHERE owner_id=? AND id=? AND revision=? AND data_revision=? RETURNING ${fields}`)
      .bind(title, description, source, now, owner, id, expected, checkedDataRevision).first();
  } else if (operation === "restore") {
    result = await session.prepare(`UPDATE prompt_apps SET title=previous_title,description=previous_description,source=previous_source,
      previous_title=title,previous_description=description,previous_source=source,revision=revision+1,updated_at=?
      WHERE owner_id=? AND id=? AND revision=? AND data_revision=? AND previous_source IS NOT NULL RETURNING ${fields}`)
      .bind(now, owner, id, expected, checkedDataRevision).first();
    if (!result) {
      const current = await session.prepare("SELECT revision,previous_source IS NOT NULL AS has_previous FROM prompt_apps WHERE owner_id=? AND id=?")
        .bind(owner, id).first<{ revision: number; has_previous: number }>();
      if (current?.revision === expected && !current.has_previous) throw new AppError("no_previous_revision", 409);
    }
  } else if (operation === "delete") {
    result = await session.prepare("DELETE FROM prompt_apps WHERE owner_id=? AND id=? AND revision=? RETURNING id")
      .bind(owner, id, expected).first();
    if (result) return { deleted: true, id };
  } else {
    const serialized = jsonData(input.value);
    result = await session.prepare(`UPDATE prompt_apps SET data_json=?,data_revision=data_revision+1,data_updated_at=?
      WHERE owner_id=? AND id=? AND data_revision=? RETURNING data_revision AS revision,data_updated_at AS updated_at`)
      .bind(serialized, now, owner, id, expected).first();
    if (result) return { ...result, value: JSON.parse(serialized) };
  }
  if (result) return validation ? { ...result, validation } : result;
  const exists = await session.prepare("SELECT id FROM prompt_apps WHERE owner_id=? AND id=?").bind(owner, id).first();
  throw new AppError(exists ? "revision_conflict" : "not_found", exists ? 409 : 404);
}
