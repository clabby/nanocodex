import type { AgentEvent } from "nanocodex";

export type ToolObservation = Readonly<{
  message_type: "tool.call" | "tool.result" | "tool.waiting";
  stage: "started" | "finished" | "waiting";
  outcome: "running" | "success" | "failure" | "cancelled" | "unknown";
  tool: string;
  thread_id?: string;
  session_id?: string;
  request_id?: string;
  /** Managed admission turn when supplied; otherwise the runtime turn. */
  turn_id?: string;
  managed_turn_id?: string;
  runtime_turn_id?: string;
  started_runtime_turn_id?: string;
  agent_id?: number;
  tool_call_id?: string;
  parent_call_id?: string;
  model_call_index?: number;
  event_seq?: number;
  duration_ms?: number;
  started_after_ms?: number;
  elapsed_ms?: number;
  /** Nonadvancing event sequence, not a replayed durable effect receipt. */
  replayed?: boolean;
  /** Whether this finish can be matched to a retained runtime start. */
  start_observed?: boolean;
}>;

type Correlation = Pick<ToolObservation, "tool" | "thread_id" | "session_id" | "request_id" | "turn_id"
  | "managed_turn_id" | "runtime_turn_id" | "agent_id" | "tool_call_id" | "parent_call_id" | "model_call_index">;
type Call = {
  correlation: Correlation;
  lastSeq: number;
  startSeq?: number;
  startTurn?: string;
  completed: boolean;
  receivedAt: number;
  nextWaitingAt: number;
  waitingInterval: number;
};

const MAX_RETAINED_CALLS = 1_024;
const FIRST_WAITING_MS = 1_000;
const MAX_WAITING_INTERVAL_MS = 5_000;

/** Passive runtime boundaries, including child sessions and Code Mode calls.
 * Rust owns finish duration/offset; waiting elapsed time starts at local receipt.
 * Retains only this fixed projection, never input, output, metadata or errors.
 * Dispose with the family watcher. Waiting neither expires nor cancels a tool.
 */
export function createToolLifecycleObserver(
  emit: (detail: ToolObservation) => void,
  threadId?: string,
): Readonly<{
  observe(event: AgentEvent, turnId?: string, agentId?: number): boolean;
  dispose(): void;
}> {
  const calls = new Map<string, Call>();
  const thread = opaqueId(threadId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const publish = (detail: ToolObservation) => {
    try { emit(detail); }
    catch { /* Logging must not change a tool's outcome. */ }
  };

  function scheduleWaiting(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    let next = Infinity;
    for (const call of calls.values()) {
      if (!call.completed) next = Math.min(next, call.nextWaitingAt);
    }
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => {
      timer = undefined;
      const now = performance.now();
      for (const call of calls.values()) {
        if (disposed) return;
        if (call.completed || call.nextWaitingAt > now) continue;
        call.waitingInterval = Math.min(call.waitingInterval * 2, MAX_WAITING_INTERVAL_MS);
        call.nextWaitingAt = now + call.waitingInterval;
        publish({ ...call.correlation, message_type: "tool.waiting", stage: "waiting", outcome: "running",
          ...(call.startSeq === undefined ? {} : { event_seq: call.startSeq }),
          elapsed_ms: Math.max(0, now - call.receivedAt) });
      }
      scheduleWaiting();
    }, Math.max(1, next - performance.now()));
    // Node consumers should not be kept alive solely by passive diagnostics.
    (timer as unknown as { unref?(): void }).unref?.();
  }

  function remember(key: string, call: Call): void {
    calls.delete(key);
    if (calls.size >= MAX_RETAINED_CALLS) {
      // Prefer removing completed correlation; an evicted active call still
      // produces its actual finish, without claiming an observed start.
      let oldest = calls.keys().next().value;
      for (const [candidate, entry] of calls) {
        if (entry.completed) { oldest = candidate; break; }
      }
      if (oldest !== undefined) calls.delete(oldest);
    }
    calls.set(key, call);
  }

  function findCall(session: string, turn: string | undefined, callId: string, acrossTurns: boolean): [string, Call] | undefined {
    const key = JSON.stringify([session, turn ?? null, callId]);
    const exact = calls.get(key);
    if (exact) return [key, exact];
    if (!acrossTurns) return;
    let latest: [string, Call] | undefined;
    for (const entry of calls) {
      const call = entry[1];
      if (call.correlation.session_id === session && call.correlation.tool_call_id === callId
        && (!latest || call.lastSeq > latest[1].lastSeq)) latest = entry;
    }
    return latest;
  }

  return {
    observe(event, turnId, agentId) {
      if (event.type !== "tool.call" && event.type !== "tool.result") return false;
      if (disposed) return true;
      try {
        const p = event.payload;
        // Root thread identity comes only from the factory's trusted context.
        // Keep the runtime request ID and any explicit child-session identity.
        const request = opaqueId(event.request_id);
        const session = opaqueId(p.session_id) ?? request;
        const runtimeTurn = opaqueId(p.turn_id);
        const suppliedManagedTurn = opaqueId(turnId);
        const correlationTurn = runtimeTurn ?? suppliedManagedTurn;
        const callId = opaqueId(p.call_id);
        const parent = callId?.match(/^(.*)\/code-[0-9]+$/)?.[1];
        const started = event.type === "tool.call";
        const key = session && callId ? JSON.stringify([session, correlationTurn ?? null, callId]) : undefined;
        // Yielded Code Mode work can finish in a later wait or even a later
        // turn. Its parent ID and original model index still belong to exec.
        const previousEntry = session && callId
          ? findCall(session, correlationTurn, callId, !started && parent !== undefined) : undefined;
        const previous = previousEntry?.[1];
        const parentCall = session && parent
          ? findCall(session, correlationTurn, parent, true)?.[1] : undefined;
        const seq = nonnegativeInteger(event.seq);
        const replayed = previous !== undefined && seq !== undefined && seq <= previous.lastSeq;
        const index = nonnegativeInteger(p.model_call_index)
          ?? (!started || replayed ? previous?.correlation.model_call_index : undefined)
          ?? parentCall?.correlation.model_call_index;
        const child = nonnegativeInteger(agentId) ?? previous?.correlation.agent_id;
        // Keep a late nested finish attached to its original managed admission,
        // even when a later wait is executing under another managed turn.
        const managedTurn = (!started || replayed ? previous?.correlation.managed_turn_id : undefined)
          ?? suppliedManagedTurn;
        const turn = managedTurn ?? runtimeTurn;
        const correlation: Correlation = {
          tool: opaqueId(p.tool) ?? "unknown",
          ...(thread === undefined ? {} : { thread_id: thread }),
          ...(session === undefined ? {} : { session_id: session }),
          ...(request === undefined ? {} : { request_id: request }),
          ...(turn === undefined ? {} : { turn_id: turn }),
          ...(managedTurn === undefined ? {} : { managed_turn_id: managedTurn }),
          ...(runtimeTurn === undefined ? {} : { runtime_turn_id: runtimeTurn }),
          ...(callId === undefined ? {} : { tool_call_id: callId }),
          ...(parent === undefined ? {} : { parent_call_id: parent }),
          ...(index === undefined ? {} : { model_call_index: index }),
          ...(child === undefined ? {} : { agent_id: child }),
        };

        const detail: ToolObservation = {
          ...correlation, message_type: event.type,
          stage: started ? "started" : "finished",
          outcome: started ? "running" : toolOutcome(p.status),
          ...(seq === undefined ? {} : { event_seq: seq }),
          ...(replayed ? { replayed: true } : {}),
          ...(started ? {} : { start_observed: previous?.startSeq !== undefined }),
          ...(!started && previous?.startTurn !== undefined && previous.startTurn !== runtimeTurn
            ? { started_runtime_turn_id: previous.startTurn } : {}),
          ...(started ? {} : milliseconds(p.duration_ns, "duration_ms")),
          ...(started ? {} : milliseconds(p.started_after_ns, "started_after_ms")),
        };
        if (key !== undefined && !replayed) {
          const now = performance.now();
          remember(!started ? previousEntry?.[0] ?? key : key, {
            correlation, lastSeq: seq ?? -1,
            startSeq: started ? seq : previous?.startSeq,
            startTurn: started ? runtimeTurn : previous?.startTurn,
            completed: !started,
            receivedAt: started ? now : previous?.receivedAt ?? now,
            nextWaitingAt: now + FIRST_WAITING_MS,
            waitingInterval: FIRST_WAITING_MS,
          });
        }
        // Emit every actual call/result, including re-delivered event records.
        // Replayed starts never reopen a completed call or reset its wait clock.
        publish(detail);
        scheduleWaiting();
      } catch { /* Observation cannot affect runtime delivery or execution. */ }
      return true;
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      calls.clear();
    },
  };
}

function opaqueId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_./:-]{1,160}$/.test(value) ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function milliseconds(value: unknown, field: "duration_ms" | "started_after_ms"): Record<string, number> {
  const ns = nonnegativeInteger(value);
  return ns === undefined ? {} : { [field]: ns / 1_000_000 };
}

function toolOutcome(status: unknown): ToolObservation["outcome"] {
  switch (status) {
    case "completed": return "success";
    case "failed": return "failure";
    case "cancelled": return "cancelled";
    default: return "unknown";
  }
}
