/** Durable account-owned documents. HTML is untrusted; native hosts must sandbox it. */
export const APP_DOCUMENT_BYTES = 256 * 1024;
export const APP_DATA_BYTES = 256 * 1024;
const MAX_APPS = 100;
const fields = "id,title,description,html,revision,created_at,updated_at";
const summaryFields = "id,title,description,revision,created_at,updated_at";
const encoder = new TextEncoder();
export type AppOperation = "list" | "get" | "save" | "delete" | "restore" | "data_get" | "data_set";
export class AppError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
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
export async function appRequest(db: D1Database, owner: string, operation: AppOperation, value: unknown,
  createId = crypto.randomUUID()): Promise<unknown> {
  const input = object(value);
  const allowed: Record<AppOperation, string[]> = {
    list: ["limit", "cursor"], get: ["id"], save: ["id", "title", "description", "html", "revision"],
    delete: ["id", "revision"], restore: ["id", "revision"], data_get: ["id"], data_set: ["id", "value", "revision"],
  };
  if (!Object.hasOwn(allowed, operation) || Object.keys(input).some(key => !allowed[operation].includes(key))) throw new AppError("invalid_input");
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
  if (operation === "save" && input.id === undefined) {
    if (input.revision !== undefined) throw new AppError("invalid_revision");
    const title = text(input.title, 256), description = text(input.description ?? "", 2048, true), html = text(input.html, APP_DOCUMENT_BYTES);
    const id = appId(createId);
    const result = await session.prepare(`INSERT INTO prompt_apps (owner_id,id,title,description,html,created_at,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM prompt_apps WHERE owner_id=?) < ?
      ON CONFLICT(owner_id,id) DO NOTHING RETURNING ${fields}`)
      .bind(owner, id, title, description, html, now, now, owner, MAX_APPS).first();
    if (result) return result;
    // Stable tool call IDs allow a retried creation to return its first result.
    const existing = await session.prepare(`SELECT ${fields} FROM prompt_apps WHERE owner_id=? AND id=?`).bind(owner, id).first();
    if (existing) return existing;
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
  if (operation === "save") {
    const title = text(input.title, 256), description = text(input.description ?? "", 2048, true), html = text(input.html, APP_DOCUMENT_BYTES);
    result = await session.prepare(`UPDATE prompt_apps SET previous_title=title,previous_description=description,previous_html=html,title=?,description=?,html=?,revision=revision+1,updated_at=?
      WHERE owner_id=? AND id=? AND revision=? RETURNING ${fields}`)
      .bind(title, description, html, now, owner, id, expected).first();
  } else if (operation === "restore") {
    result = await session.prepare(`UPDATE prompt_apps SET title=previous_title,description=previous_description,html=previous_html,
      previous_title=title,previous_description=description,previous_html=html,revision=revision+1,updated_at=?
      WHERE owner_id=? AND id=? AND revision=? AND previous_html IS NOT NULL RETURNING ${fields}`)
      .bind(now, owner, id, expected).first();
    if (!result) {
      const current = await session.prepare("SELECT revision,previous_html IS NOT NULL AS has_previous FROM prompt_apps WHERE owner_id=? AND id=?")
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
  if (result) return result;
  const exists = await session.prepare("SELECT id FROM prompt_apps WHERE owner_id=? AND id=?").bind(owner, id).first();
  throw new AppError(exists ? "revision_conflict" : "not_found", exists ? 409 : 404);
}
