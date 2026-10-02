import { connectorConnectionId, connectorStatuses } from "./connector-status";

export type TodoDispositionContext = { ownerID: string; binding?: Fetcher };
type Disposition = { row_key: string; until: number | null; version: number };
type Receipt = { row_key: string; until: number | null; version: number; response: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier = /^[A-Za-z0-9_-]{1,512}$/;
const limit = 1000;
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export function initializeTodoDispositions(storage: DurableObjectStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS todo_dispositions (
    row_key TEXT PRIMARY KEY, until INTEGER, version INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS todo_disposition_receipts (
    operation_id TEXT PRIMARY KEY, row_key TEXT NOT NULL, until INTEGER,
    version INTEGER NOT NULL, response TEXT NOT NULL
  );`);
}

/** Complete within a hard account bound. Never drop expired/null versions: a
 * second device must not mistake a brought-back row for an unwritten v0 row. */
export function todoDispositionSnapshot(storage: DurableObjectStorage) {
  const dispositions = storage.sql.exec<Disposition>("SELECT row_key,until,version FROM todo_dispositions ORDER BY row_key LIMIT ?", limit).toArray();
  const total = storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM todo_dispositions").toArray()[0]!.total;
  return { dispositions, disposition_coverage: {
    limit, total, returned: dispositions.length, complete: total === dispositions.length,
    scope: "Account-private presentation state only; includes expired snoozes and brought-back versions, not provider coverage.",
    new_key_at_capacity: "rejected", timestamps: "unix_milliseconds",
  } };
}

type Target = { table: string; id: string } | { capability: "gmail" | "gcalendar"; connectionID: string };
/** All components are bounded and canonical. Calendar IDs use encodeURIComponent,
 * so a colon in an upstream ID cannot alias a different source-qualified key. */
function target(rowKey: unknown): Target | undefined {
  if (typeof rowKey !== "string" || rowKey.length > 1536 || !rowKey.isWellFormed()) return;
  const parts = rowKey.split(":"), kind = parts[0], id = parts[1];
  const tables: Record<string, string> = { capture: "todo_captures", decision: "todo_decisions", agent: "agent_registry", draft: "todo_mail_drafts" };
  if (parts.length === 2 && kind && tables[kind] && id && uuid.test(id)) return { table: tables[kind]!, id };
  const connectionID = connectorConnectionId(id);
  if (!connectionID) return;
  if (kind === "mail" && parts.length === 3 && identifier.test(parts[2]!)) return { capability: "gmail", connectionID };
  if (kind === "event" && parts.length === 4 && identifier.test(parts[3]!)) {
    try {
      const calendar = decodeURIComponent(parts[2]!);
      if (!calendar || calendar.length > 512 || /[\u0000-\u001f\u007f]/.test(calendar) || encodeURIComponent(calendar) !== parts[2]) return;
      return { capability: "gcalendar", connectionID };
    } catch { return; }
  }
}

async function owned(target: Target, storage: DurableObjectStorage, context?: TodoDispositionContext): Promise<Response | undefined> {
  if ("table" in target) {
    const suffix = target.table === "agent_registry" ? " AND deleted_at IS NULL" : "";
    return storage.sql.exec(`SELECT id FROM ${target.table} WHERE id=?${suffix}`, target.id).toArray().length
      ? undefined : reply({ error: "not_found" }, 404);
  }
  if (!context?.binding) return reply({ error: "connector_unavailable" }, 503);
  try {
    // This is owner-bound inventory, not a provider action/read or an approval.
    const response = await context.binding.fetch(`https://broker.internal/users/${encodeURIComponent(context.ownerID)}/connectors`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body) return reply({ error: "connector_unavailable" }, 503);
    const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
        if (size > 256_000) return reply({ error: "connector_unavailable" }, 503); chunks.push(next.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    const statuses = connectorStatuses(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data)));
    return statuses[target.capability].connections?.some(connection => connection.id === target.connectionID)
      ? undefined : reply({ error: "connection_not_found" }, 404);
  } catch { return reply({ error: "connector_unavailable" }, 503); }
}

export async function writeTodoDisposition(input: Record<string, unknown>, storage: DurableObjectStorage, context?: TodoDispositionContext): Promise<Response> {
  const { row_key, until, version, operation_id } = input;
  const selected = target(row_key);
  if (Object.keys(input).some(key => !["row_key", "until", "version", "operation_id"].includes(key))
    || !selected || !Number.isSafeInteger(version) || (version as number) < 0 || (version as number) >= Number.MAX_SAFE_INTEGER
    || typeof operation_id !== "string" || !uuid.test(operation_id.toLowerCase())
    || !(until === null || Number.isSafeInteger(until) && (until as number) >= 1_000_000_000_000 && (until as number) <= 8_640_000_000_000_000))
    return reply({ error: "invalid_disposition" }, 400);
  const operation = operation_id.toLowerCase();
  const replay = () => {
    const previous = storage.sql.exec<Receipt>("SELECT * FROM todo_disposition_receipts WHERE operation_id=?", operation).toArray()[0];
    if (previous) return previous.row_key === row_key && previous.until === until && previous.version === version
      ? reply(JSON.parse(previous.response)) : reply({ error: "operation_conflict" }, 409);
  };
  // Replays survive target deletion, disconnect and time passing; return the
  // original durable receipt, never mutate the current disposition backwards.
  const previous = replay(); if (previous) return previous;
  const now = Date.now();
  if (until !== null && ((until as number) <= now || (until as number) > now + 366 * 86400_000))
    return reply({ error: "invalid_disposition_time" }, 400);
  // A stored external-key disposition was already validated in this account.
  // Clearing presentation state must still work after a disconnect/outage; it
  // cannot authorize a provider action or create an unverified source key.
  const clearingKnownSource = until === null && "capability" in selected
    && storage.sql.exec("SELECT row_key FROM todo_dispositions WHERE row_key=?", row_key as string).toArray().length > 0;
  const denied = clearingKnownSource ? undefined : await owned(selected, storage, context); if (denied) return denied;
  return storage.transactionSync(() => {
    const previous = replay(); if (previous) return previous;
    // The asynchronous inventory read can interleave with another client's
    // write. Check the version and any local deletion again inside the txn.
    if ("table" in selected && !storage.sql.exec(`SELECT id FROM ${selected.table} WHERE id=?${selected.table === "agent_registry" ? " AND deleted_at IS NULL" : ""}`, selected.id).toArray().length)
      return reply({ error: "not_found" }, 404);
    const current = storage.sql.exec<Disposition>("SELECT * FROM todo_dispositions WHERE row_key=?", row_key as string).toArray()[0];
    if ((current?.version ?? 0) !== version) return reply({ error: "stale_disposition", disposition: current ?? { row_key, until: null, version: 0 } }, 409);
    if (!current && storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM todo_dispositions").toArray()[0]!.count >= limit)
      return reply({ error: "disposition_capacity", limit }, 409);
    const disposition = { row_key: row_key as string, until: until as number | null, version: (version as number) + 1 };
    const response = { disposition };
    storage.sql.exec("INSERT INTO todo_dispositions(row_key,until,version) VALUES(?,?,?) ON CONFLICT(row_key) DO UPDATE SET until=excluded.until,version=excluded.version", disposition.row_key, disposition.until, disposition.version);
    storage.sql.exec("INSERT INTO todo_disposition_receipts(operation_id,row_key,until,version,response) VALUES(?,?,?,?,?)", operation, disposition.row_key, disposition.until, version as number, JSON.stringify(response));
    return reply(response);
  });
}
