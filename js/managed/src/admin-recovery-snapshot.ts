/** Content-free, bounded inspection. Never acquire runtime ownership or repair state. */
export function adminRecoverySnapshot(storage: DurableObjectStorage, requestedLimit: number) {
  const limit = Math.max(1, Math.min(100, requestedLimit));
  let stage = "schema";
  const failure = () => ({ available: false as const, reason: "recovery_snapshot_unavailable", stage });
  try {
    return storage.transactionSync(() => {
      const tables = new Set(storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('managed_turns','managed_recovery_safety','managed_code_effects','managed_code_effect_receipt_chunks','nanocodex_cloudflare_agent')",
      ).toArray().map(row => row.name));
      stage = "turns";
      const safetyAvailable = tables.has("managed_recovery_safety");
      const turns = tables.has("managed_turns") ? storage.sql.exec(
        `SELECT substr(t.id,1,256) AS turn_id, t.state, t.attempt_count, t.may_have_inner_operation,
          t.dispatch_input_chunks, t.retry_at, t.created_at, t.updated_at,
          ${safetyAvailable ? "s.armed, s.abrupt_attempts, s.stopped" : "NULL AS armed, NULL AS abrupt_attempts, NULL AS stopped"}
          FROM managed_turns t
          ${safetyAvailable ? "LEFT JOIN managed_recovery_safety s ON s.turn_id = t.id" : ""}
          ORDER BY t.rowid DESC LIMIT ?`, limit + 1,
      ).toArray() : [];
      stage = "effects";
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
      const receipts = new Map<SqlStorageValue, { available: boolean; observed_chunks?: number; truncated?: boolean; reason?: string }>();
      const withReceipt = ({ effect_key, ...effect }: Record<string, SqlStorageValue>) => {
        let receipt = receipts.get(effect_key);
        if (!receipt) {
          try {
            // The primary-key covering index contains all needed metadata.
            // Do not read/cast receipt_json: a large snapshot must not scan
            // hundreds of potentially multi-megabyte receipt bodies.
            const chunks = receiptsAvailable ? storage.sql.exec<{ chunks: number }>(
              `SELECT COUNT(*) AS chunks FROM (SELECT chunk_index FROM managed_code_effect_receipt_chunks
               WHERE effect_key = ? ORDER BY chunk_index LIMIT 257)`, effect_key,
            ).one().chunks : undefined;
            receipt = chunks === undefined ? { available: false } : {
              available: true, observed_chunks: chunks, truncated: chunks > 256,
            };
          } catch { receipt = { available: false, reason: "receipt_metadata_unavailable" }; }
          receipts.set(effect_key, receipt);
        }
        return { ...effect, receipt };
      };
      // A busy child tree must not crowd older failed root operations out of
      // view. Use the authoritative root identity and the existing scope index.
      stage = "root_identity";
      const rootSession = tables.has("nanocodex_cloudflare_agent") ? storage.sql.exec<{ session_id: string }>(
        "SELECT session_id FROM nanocodex_cloudflare_agent WHERE singleton = 1",
      ).toArray()[0]?.session_id : undefined;
      stage = "stopped_safety";
      const safetyCandidates = safetyAvailable ? storage.sql.exec<{ turn_id: string; stopped: number }>(
        "SELECT turn_id, stopped FROM managed_recovery_safety ORDER BY rowid DESC LIMIT 101",
      ).toArray() : [];
      const stopped = safetyCandidates.slice(0, 100).filter(row => row.stopped === 1);
      const perOperationLimit = Math.min(limit, 10);
      stage = "stopped_effects";
      const stoppedEffects = rootSession && effectsAvailable ? stopped.slice(0, 10).map(row => {
        try {
          const rows = storage.sql.exec(`SELECT ${effectColumns} FROM managed_code_effects
          WHERE session_id = ? AND operation_id = ?
          ORDER BY model_call_index DESC, parent_call_id DESC LIMIT ?`, rootSession, row.turn_id, perOperationLimit + 1).toArray();
          return { turn_id: row.turn_id.slice(0, 256), data: rows.slice(0, perOperationLimit).map(withReceipt),
          has_more: rows.length > perOperationLimit };
        } catch { return { turn_id: row.turn_id.slice(0, 256), available: false, reason: "effect_metadata_unavailable" }; }
      }) : [];
      stage = "effect_receipts";
      const recentEffects = effects.slice(0, limit).map(withReceipt);
      stage = "snapshot";
      return { available: true, observed_at: Date.now(), limit,
        order: "newest_inserted", scope: "retained_rows_only",
        turns: { available: tables.has("managed_turns"), safety_available: safetyAvailable,
          data: turns.slice(0, limit), has_more: turns.length > limit },
        effects: { available: effectsAvailable, data: recentEffects, has_more: effects.length > limit },
        stopped_root_effects: { available: !!rootSession && effectsAvailable && safetyAvailable,
          scope: "stopped_operations_in_newest_100_safety_rows", per_operation_limit: perOperationLimit,
          truncated: safetyCandidates.length > 100 || stopped.length > 10, data: stoppedEffects } };
    });
  } catch {
    // An unavailable snapshot must neither break ordinary diagnostics nor
    // expose SQL errors, input, receipts, or incompatible legacy schemas.
    return failure();
  }
}
