// Owned SDK-only canonical effect identity. Projected turn IDs are lookup hints,
// never durable journal keys. Keep queued/overlapping turns independently.
export function createCodeEffectIdentity(enabled) {
  const sessions = new Map();
  function sessionFor(sessionId) {
    let session = sessions.get(sessionId);
    if (!session) { session = { turns: new Map(), aliases: new Map() }; sessions.set(sessionId, session); }
    return session;
  }
  function unavailable() {
    throw Object.assign(new Error("Original operation/model-call identity unavailable; effect journal interrupted"), { code: "host_interrupted" });
  }
  return {
    observe(encoded) {
      if (!enabled) return;
      const event = typeof encoded === "string" ? JSON.parse(encoded) : encoded;
      const payload = event?.payload;
      const sessionId = payload?.session_id ?? event?.request_id;
      if (typeof sessionId !== "string" || typeof payload?.turn_id !== "string") return;
      const session = sessionFor(sessionId);
      if (event.type === "input.accepted" && payload.kind === "prompt") {
        if (!session.turns.has(payload.turn_id)) {
          if (session.turns.size >= 128) {
            const old = session.turns.keys().next().value;
            session.turns.delete(old);
            for (const [alias, projected] of session.aliases) if (projected === old) session.aliases.delete(alias);
          }
          // Rust emits an explicit null request_id for execution_operation=None
          // (including ephemeral child tasks). There is no durable operation
          // to recover in that mode; scope to its trusted accepted input item.
          // Missing metadata is still an error, never a latest-turn fallback.
          const operationId = typeof payload.request_id === "string" && payload.request_id
            ? payload.request_id
            : payload.request_id === null && payload.item_id === payload.turn_id + ":prompt"
              ? "non-durable:" + payload.item_id : undefined;
          session.turns.set(payload.turn_id, { operationId, calls: new Map() });
        }
      } else if (event.type === "tool.call") {
        const turn = session.turns.get(payload.turn_id);
        if (!turn || typeof payload.call_id !== "string"
          || !Number.isSafeInteger(payload.model_call_index) || payload.model_call_index < 1) return;
        if (turn.calls.size >= 128 && !turn.calls.has(payload.call_id)) turn.calls.delete(turn.calls.keys().next().value);
        turn.calls.set(payload.call_id, { operationId: turn.operationId, modelCallIndex: payload.model_call_index, pending: true });
      }
    },
    resolve(sessionId, parentCallId, turnId) {
      const session = sessions.get(sessionId);
      let projected = session?.turns.has(turnId) ? turnId : session?.aliases.get(turnId);
      if (!projected) {
        // The current WASM ABI supplies profile IDs `session:logicalOrdinal`,
        // while events use a UUID. Bind that ABI lookup alias only to a UNIQUE
        // just-emitted, unclaimed call; never pick the latest accepted turn.
        const prefix = sessionId + ":";
        if (typeof turnId !== "string" || !turnId.startsWith(prefix) || !/^[1-9]\d*$/.test(turnId.slice(prefix.length))) unavailable();
        const candidates = [...session?.turns ?? []].filter(([, turn]) => turn.calls.get(parentCallId)?.pending);
        if (candidates.length !== 1) unavailable();
        projected = candidates[0][0];
        session.aliases.set(turnId, projected);
      }
      const identity = session.turns.get(projected)?.calls.get(parentCallId);
      if (!identity || typeof identity.operationId !== "string" || !identity.operationId) unavailable();
      identity.pending = false;
      return { operationId: identity.operationId, modelCallIndex: identity.modelCallIndex };
    },
    release(sessionId) { sessions.delete(sessionId); },
    reset() { sessions.clear(); },
  };
}
