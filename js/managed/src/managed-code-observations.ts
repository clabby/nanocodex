import { createHash } from "node:crypto";
import type { CodeEffectContext } from "nanocodex";
import { inputChunks } from "./managed-turn-input";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_OBSERVATIONS = 128;
function unknown(message: string): never {
  throw Object.assign(new Error(message + "; execution outcome unknown"), { code: "CODE_EFFECT_UNKNOWN" });
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Cell = { session_id: string; operation_id: string; model_call_index: number; parent_call_id: string;
  source_hash: string; generation: string; sequence: number };
/** Host-only ledger. Recovery reads evidence; it never executes guest source or
 * admits effects. A recorded observation is durable, not proof of client delivery. */
export function createManagedCodeObservationJournal(storage: DurableObjectStorage, generation: string, assertOwner: () => void) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS managed_code_public_cells (
    cell_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    model_call_index INTEGER NOT NULL, parent_call_id TEXT NOT NULL,
    source_hash TEXT NOT NULL, generation TEXT NOT NULL, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS managed_code_observations (
    cell_id TEXT NOT NULL, sequence INTEGER NOT NULL, chunks INTEGER NOT NULL,
    bytes INTEGER NOT NULL, digest TEXT NOT NULL, summary_json TEXT NOT NULL, summary_digest TEXT NOT NULL, PRIMARY KEY(cell_id, sequence));
    CREATE TABLE IF NOT EXISTS managed_code_observation_chunks (
    cell_id TEXT NOT NULL, sequence INTEGER NOT NULL, chunk_index INTEGER NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(cell_id, sequence, chunk_index));`);
  const cell = (session: string, id: string) => storage.sql.exec<Cell>(
    "SELECT * FROM managed_code_public_cells WHERE cell_id = ? AND session_id = ?", id, session).toArray()[0];
  function readChunks(table: string, column: string, where: string, bindings: (string | number)[], expected: number): string {
    const bounds = storage.sql.exec<{ count: number; bytes: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(${column} AS BLOB))), 0) AS bytes FROM ${table} WHERE ${where}`, ...bindings).one();
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > 256
      || bounds.count !== expected || bounds.bytes > MAX_BYTES) unknown("Code observation receipt is incomplete or exceeds bounds");
    const rows = storage.sql.exec<{ chunk_index: number; payload: string }>(
      `SELECT chunk_index, ${column} AS payload FROM ${table} WHERE ${where} ORDER BY chunk_index`, ...bindings).toArray();
    if (rows.some((row, i) => row.chunk_index !== i)) unknown("Code observation receipt chunks are incomplete");
    return rows.map(row => row.payload).join("");
  }
  function decodeObservation(encoded: string): { output: unknown; success: boolean; cell?: { running: boolean; origin_call_id: string }; nested_calls: unknown[] } {
    let value;
    try { value = JSON.parse(encoded); } catch { unknown("Code observation is corrupt"); }
    if (!value || typeof value.success !== "boolean" || !Array.isArray(value.nested_calls)
      || !value.cell || typeof value.cell.running !== "boolean" || typeof value.cell.origin_call_id !== "string"
      || !(typeof value.output === "string" || Array.isArray(value.output))) unknown("Code observation envelope is invalid");
    return value;
  }
  return {
    async register(context: CodeEffectContext, id: string) {
      // This protocol requires an authoritative operation and model scope.
      if (!context.sessionId || !context.parentCallId || !context.source || !context.operationId
        || !Number.isSafeInteger(context.modelCallIndex) || context.modelCallIndex! < 1
        || !/^[0-9a-f-]{36}:[1-9][0-9]*$/i.test(id)) unknown("Code observation identity is unavailable");
      const fingerprint = hash(JSON.stringify([context.source, context.name, context.input]));
      storage.transactionSync(() => {
        assertOwner();
        const old = storage.sql.exec<Cell>("SELECT * FROM managed_code_public_cells WHERE cell_id = ?", id).toArray()[0];
        if (old) {
          if (old.session_id !== context.sessionId || old.operation_id !== context.operationId
            || old.model_call_index !== context.modelCallIndex || old.parent_call_id !== context.parentCallId
            || old.source_hash !== fingerprint || old.generation !== generation) unknown("Code public cell identity conflict");
          return;
        }
        storage.sql.exec("INSERT INTO managed_code_public_cells VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
          id, context.sessionId, context.operationId!, context.modelCallIndex!, context.parentCallId, fingerprint, generation);
      });
      await storage.sync();
      assertOwner();
    },
    async record(session: string, id: string, encoded: string) {
      const bytes = new TextEncoder().encode(encoded).byteLength;
      const value = decodeObservation(encoded);
      // A valid observation can aggregate many individually bounded effects.
      // Keep a bounded recovery envelope without imposing a live-result cap.
      // Retain a bounded summary for recovery without hydrating an arbitrarily
      // large aggregate. Full receipts remain in their original journals.
      const outputJson = JSON.stringify(value.output);
      const summary = JSON.stringify({
        output: (value.cell?.running ? "Previous running observation; current execution unavailable" : value.success ? "Script completed" : "Script failed") + "\nOutput:\nDurable observation summary: full envelope exceeds recovery retention; nested event records omitted from this bounded recovery view.\n"
          + (new TextEncoder().encode(outputJson).byteLength <= 131072 ? outputJson : "[Output exceeds the bounded recovery view.]"),
        success: value.success, cell: value.cell, nested_calls: [], notifications: [],
      });
      storage.transactionSync(() => {
        assertOwner();
        const row = cell(session, id);
        if (!row || row.generation !== generation || row.parent_call_id !== value.cell?.origin_call_id)
          unknown("Code observation lost its original owner");
        const sequence = row.sequence + 1;
        // Only the latest observation is needed: acknowledged tool-call replay
        // belongs to the outer durable tool ledger, never to this recovery view.
        storage.sql.exec("DELETE FROM managed_code_observation_chunks WHERE cell_id = ?", id);
        storage.sql.exec("DELETE FROM managed_code_observations WHERE cell_id = ?", id);
        const retained = bytes > MAX_BYTES ? summary : encoded;
        let count = 0;
        for (const chunk of inputChunks(retained)) storage.sql.exec(
          "INSERT INTO managed_code_observation_chunks VALUES (?, ?, ?, ?)", id, sequence, count++, chunk);
        storage.sql.exec("INSERT INTO managed_code_observations VALUES (?, ?, ?, ?, ?, ?, ?)", id, sequence, count, new TextEncoder().encode(retained).byteLength, hash(retained), summary, hash(summary));
        storage.sql.exec("UPDATE managed_code_public_cells SET sequence = ? WHERE cell_id = ?", sequence, id);
        // Bound retained payload across the owner, including old sessions. Keep
        // identity tombstones so eviction cannot authorize replay or alias IDs.
        const retainedRows = storage.sql.exec<{ cell_id: string; bytes: number }>(
          "SELECT cell_id, bytes FROM managed_code_observations ORDER BY rowid DESC").toArray();
        let retainedBytes = 0;
        for (const [index, entry] of retainedRows.entries()) {
          retainedBytes += entry.bytes;
          if (index >= MAX_OBSERVATIONS || retainedBytes > MAX_LEDGER_BYTES) {
            storage.sql.exec("DELETE FROM managed_code_observation_chunks WHERE cell_id = ?", entry.cell_id);
            storage.sql.exec("DELETE FROM managed_code_observations WHERE cell_id = ?", entry.cell_id);
          }
        }
      });
      await storage.sync();
      assertOwner();
    },
    async recover(session: string, id: string): Promise<string | null> {
      // No insert/update, effect admission, evaluator, or provider calls here.
      assertOwner();
      const row = cell(session, id);
      if (!row) return null; // Includes legacy IDs and foreign sessions.
      let previous: ReturnType<typeof decodeObservation> | undefined;
      if (row.sequence > 0) {
        const meta = storage.sql.exec<{ chunks: number; bytes: number; digest: string; summary_json: string; summary_digest: string }>(
          "SELECT * FROM managed_code_observations WHERE cell_id = ? AND sequence = ?", id, row.sequence).toArray()[0];
        if (!meta) unknown("Code observation metadata is missing");
        let encoded;
        if (meta.bytes > MAX_BYTES) {
          if (new TextEncoder().encode(meta.summary_json).byteLength > 262144 || hash(meta.summary_json) !== meta.summary_digest)
            unknown("Code observation summary checksum mismatch");
          encoded = meta.summary_json;
        } else {
          encoded = readChunks("managed_code_observation_chunks", "payload", "cell_id = ? AND sequence = ?", [id, row.sequence], meta.chunks);
          if (new TextEncoder().encode(encoded).byteLength !== meta.bytes || hash(encoded) !== meta.digest) unknown("Code observation checksum mismatch");
        }
        previous = decodeObservation(encoded);
        if (previous.cell?.origin_call_id !== row.parent_call_id) unknown("Code observation parent mismatch");
        // A wait after owner loss is a reconciliation read, even if its call ID
        // matches an earlier observer. Exact acknowledged call replay is owned
        // by the outer tool ledger. Never re-emit historical nested events here.
        if (previous.cell?.running === false) return JSON.stringify({
          output: "Durable terminal observation recovered; no source or effects replayed. Historical receipts follow.\nOutput:\n"
            + JSON.stringify({ output: previous.output, completed_effect_receipts: previous.nested_calls }),
          success: previous.success, cell: previous.cell, nested_calls: [], notifications: [],
        });
      }
      const counts = storage.sql.exec<{ completed: number; pending: number }>(
        `SELECT COALESCE(SUM(state = 'completed'), 0) AS completed, COALESCE(SUM(state <> 'completed'), 0) AS pending
         FROM managed_code_effects WHERE session_id = ? AND operation_id = ? AND model_call_index = ? AND parent_call_id = ?`,
        session, row.operation_id, row.model_call_index, row.parent_call_id).one();
      const pending = storage.sql.exec<{ call_id: string }>(
        `SELECT call_id FROM managed_code_effects WHERE session_id = ? AND operation_id = ? AND model_call_index = ?
         AND parent_call_id = ? AND state <> 'completed' ORDER BY call_id LIMIT 256`,
        session, row.operation_id, row.model_call_index, row.parent_call_id).toArray().map(effect => effect.call_id);
      const effects = storage.sql.exec<{ effect_key: string; call_id: string; name: string; state: string; receipt_chunks: number; scope_version: number }>(
        `SELECT effect_key, call_id, name, state, receipt_chunks, scope_version FROM managed_code_effects
         WHERE session_id = ? AND operation_id = ? AND model_call_index = ? AND parent_call_id = ?
         AND state = 'completed' ORDER BY call_id LIMIT 256`, session, row.operation_id, row.model_call_index, row.parent_call_id).toArray();
      const receipts: unknown[] = [];
      let remaining = MAX_BYTES;
      for (const effect of effects) {
        if (effect.scope_version !== 2 || !effect.call_id.startsWith(row.parent_call_id + "/code-")) unknown("Code reconciliation identity mismatch");
        const encoded = readChunks("managed_code_effect_receipt_chunks", "receipt_json", "effect_key = ?", [effect.effect_key], effect.receipt_chunks);
        remaining -= new TextEncoder().encode(encoded).byteLength;
        if (remaining < 0) break; // Counts/IDs below disclose the bounded view.
        let receipt;
        try { receipt = JSON.parse(encoded); } catch { unknown("Code reconciliation receipt is corrupt"); }
        if (!receipt || typeof receipt.success !== "boolean" || typeof receipt.thrown !== "boolean"
          || !Object.hasOwn(receipt, "output") || !Object.hasOwn(receipt, "structured_result")
          || (receipt.outputJsonRef !== undefined && receipt.outputJsonRef !== "structured_result")
          || (receipt.structuredResultRef !== undefined && receipt.structuredResultRef !== "output")
          || (receipt.outputJsonRef !== undefined && receipt.structuredResultRef !== undefined)) unknown("Code reconciliation receipt is invalid");
        if (receipt.outputJsonRef === "structured_result") receipt.output = JSON.stringify(receipt.structured_result);
        if (receipt.structuredResultRef === "output") receipt.structured_result = receipt.output;
        receipts.push({ call_id: effect.call_id, name: effect.name, success: receipt.success,
          output: receipt.output, structured_result: receipt.structured_result });
      }
      assertOwner();
      return JSON.stringify({
        output: `CODE_CELL_RECOVERED_EVIDENCE: ${counts.pending} pending effects have unknown outcomes; ${counts.completed} completed receipts retained. Live execution is unavailable; whole-script outcome unknown.\nOutput:\n`
          + "These are retained historical receipts, not new tool executions. No source or effects were replayed. "
          + "A previous running observation does not mean the cell is still running. Termination is not confirmed. "
          + "Do not retry uncertain effects; reconcile using original operation identities.\n"
          + JSON.stringify({ origin_call_id: row.parent_call_id, operation_id: row.operation_id,
            model_call_index: row.model_call_index, pending_effect_call_ids: pending,
            pending_effect_count: counts.pending, completed_effect_count: counts.completed,
            receipt_view_truncated: receipts.length < counts.completed || pending.length < counts.pending,
            completed_effect_call_ids: effects.map(effect => effect.call_id),
            completed_effect_receipts: receipts, previous_observation: previous ?? null }),
        success: false, nested_calls: [],
      });
    },
  };
}

