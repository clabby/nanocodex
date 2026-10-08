/** Content-free, bounded inspection. Never acquire runtime ownership or repair state. */
export function adminRecoverySnapshot(storage: DurableObjectStorage, requestedLimit: number) {
  const limit = Math.max(1, Math.min(100, requestedLimit));
  try {
    return storage.transactionSync(() => {
      const tables = new Set(storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('managed_turns','managed_recovery_safety','managed_code_effects','managed_code_effect_receipt_chunks','nanocodex_cloudflare_agent')",
      ).toArray().map(row => row.name));
      const safetyAvailable = tables.has("managed_recovery_safety");
      const turns = tables.has("managed_turns") ? storage.sql.exec(
        `SELECT substr(t.id,1,256) AS turn_id, t.state, t.attempt_count, t.may_have_inner_operation,
          t.dispatch_input_chunks, t.retry_at, t.created_at, t.updated_at,
          ${safetyAvailable ? "s.armed, s.abrupt_attempts, s.stopped" : "NULL AS armed, NULL AS abrupt_attempts, NULL AS stopped"}
          FROM managed_turns t
          ${safetyAvailable ? "LEFT JOIN managed_recovery_safety s ON s.turn_id = t.id" : ""}
          ORDER BY t.rowid DESC LIMIT ?`, limit + 1,
      ).toArray() : [];
      const effectsAvailable = tables.has("managed_code_effects");
      const effectColumns = `effect_key, substr(session_id,1,256) AS session_id, substr(turn_id,1,256) AS turn_id,
          substr(operation_id,1,256) AS operation_id, model_call_index,
          substr(parent_call_id,1,256) AS parent_call_id, substr(call_id,1,256) AS call_id,
          substr(name,1,128) AS name, state, scope_version, receipt_chunks, created_at, completed_at
          `;
      const effects = effectsAvailable ? storage.sql.exec(
        `SELECT ${effectColumns} FROM managed_code_effects ORDER BY rowid DESC LIMIT ?`, limit + 1,
      ).toArray() : [];
      const receiptsAvailable = tables.has("managed_code_effect_receipt_chunks");
      const withReceipt = ({ effect_key, ...effect }: Record<string, SqlStorageValue>) => {
        // Bound each receipt scan too; strings never leave SQLite. A truncated
        // count is a lower bound, not a receipt integrity assertion.
        const receipt = receiptsAvailable ? storage.sql.exec<{ chunks: number; bytes: number }>(
          `SELECT COUNT(*) AS chunks, COALESCE(SUM(bytes),0) AS bytes FROM
            (SELECT length(CAST(receipt_json AS BLOB)) AS bytes FROM managed_code_effect_receipt_chunks
             WHERE effect_key = ? ORDER BY chunk_index LIMIT 257)`, effect_key,
        ).one() : null;
        return { ...effect, receipt: receipt === null ? { available: false } : {
          available: true, observed_chunks: receipt.chunks, observed_bytes: receipt.bytes,
          truncated: receipt.chunks > 256,
        } };
      };
      // A busy child tree must not crowd older failed root operations out of
      // view. Use the authoritative root identity and the existing scope index.
      const rootSession = tables.has("nanocodex_cloudflare_agent") ? storage.sql.exec<{ session_id: string }>(
        "SELECT session_id FROM nanocodex_cloudflare_agent WHERE singleton = 1",
      ).toArray()[0]?.session_id : undefined;
      const safetyCandidates = safetyAvailable ? storage.sql.exec<{ turn_id: string; stopped: number }>(
        "SELECT turn_id, stopped FROM managed_recovery_safety ORDER BY rowid DESC LIMIT 101",
      ).toArray() : [];
      const stopped = safetyCandidates.slice(0, 100).filter(row => row.stopped === 1);
      const perOperationLimit = Math.min(limit, 10);
      const stoppedEffects = rootSession && effectsAvailable ? stopped.slice(0, 10).map(row => {
        const rows = storage.sql.exec(`SELECT ${effectColumns} FROM managed_code_effects
          WHERE session_id = ? AND operation_id = ?
          ORDER BY model_call_index DESC, parent_call_id DESC LIMIT ?`, rootSession, row.turn_id, perOperationLimit + 1).toArray();
        return { turn_id: row.turn_id.slice(0, 256), data: rows.slice(0, perOperationLimit).map(withReceipt),
          has_more: rows.length > perOperationLimit };
      }) : [];
      return { available: true, observed_at: Date.now(), limit,
        order: "newest_inserted", scope: "retained_rows_only",
        turns: { available: tables.has("managed_turns"), safety_available: safetyAvailable,
          data: turns.slice(0, limit), has_more: turns.length > limit },
        effects: { available: effectsAvailable, data: effects.slice(0, limit).map(withReceipt), has_more: effects.length > limit },
        stopped_root_effects: { available: !!rootSession && effectsAvailable && safetyAvailable,
          scope: "stopped_operations_in_newest_100_safety_rows", per_operation_limit: perOperationLimit,
          truncated: safetyCandidates.length > 100 || stopped.length > 10, data: stoppedEffects } };
    });
  } catch {
    // An unavailable snapshot must neither break ordinary diagnostics nor
    // expose SQL errors, input, receipts, or incompatible legacy schemas.
    return { available: false, reason: "recovery_snapshot_unavailable" };
  }
}
