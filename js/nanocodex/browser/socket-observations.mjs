// Passive, content-free observations. Timers report silence; they never cancel
// inference. Each socket retains only one active request and 32 response links.
export function createSocketObservations(observe) {
  if (observe === undefined) return;
  if (typeof observe !== "function") throw new TypeError("host socket event hook must be a function");
  const turns = new Map();
  const calls = new Map();
  const sockets = new Set();
  const emit = (value) => {
    try {
      const result = observe(value);
      if (result?.then) void Promise.resolve(result).catch(() => {});
    } catch { /* Observation cannot change transport behavior. */ }
  };
  const retain = (map, key, value, limit = 128) => {
    if (!map.has(key) && map.size >= limit) map.delete(map.keys().next().value);
    map.set(key, value);
  };
  return {
    runtime(encoded) {
      if (typeof encoded === "string" && !/"(?:input\.accepted|model\.(?:call|compaction|warmup)\.|run\.)/.test(encoded.slice(0, 512))) return;
      let event;
      try { event = typeof encoded === "string" ? JSON.parse(encoded) : encoded; } catch { return; }
      const p = event?.payload;
      if (!p) return;
      if (event.type === "input.accepted" && typeof p.turn_id === "string" && typeof p.session_id === "string") {
        retain(turns, p.turn_id, p.session_id);
      }
      const sessionId = turns.get(p.turn_id) ?? event.request_id;
      if (event.type === "model.call.started" || event.type === "model.compaction.started" || event.type === "model.warmup.started") {
        retain(calls, sessionId, { ...(Number.isSafeInteger(p.call_index ?? p.after_model_call_index)
          ? { model_call_index: p.call_index ?? p.after_model_call_index } : {}),
          phase: event.type.startsWith("model.compaction.") ? "compaction" : event.type.startsWith("model.warmup.") ? "warmup" : "generation" });
      } else if (/^model\.(call|compaction|warmup)\.(completed|failed)$/.test(event.type)) {
        for (const socket of sockets) {
          if (socket.sessionId === sessionId) socket.finished(p.call_index ?? p.after_model_call_index, p.response_id, event.type.endsWith(".failed") ? "failed" : "completed");
        }
        calls.delete(sessionId);
      }
    },
    release(sessionId) {
      calls.delete(sessionId);
      for (const [turn, session] of turns) if (session === sessionId) turns.delete(turn);
    },
    connect(sessionId, snapshot) {
      const measure = () => { try { return snapshot(); } catch { return {}; } };
      const socketId = crypto.randomUUID();
      const began = performance.now();
      const responses = new Map();
      let handshake = {};
      let active, last, timer, ordinal = 0, closed = false;
      const record = (event, fields = {}, request = active ?? last) => emit({
        event, socket_id: socketId, request_id: sessionId,
        ...(uuid(handshake.egressRequestId) ? { egress_request_id: handshake.egressRequestId } : {}),
        ...(identifier(handshake.requestId, "req_") || uuid(handshake.requestId) ? { provider_request_id: handshake.requestId } : {}),
        ...(request ? { socket_request_index: request.index, ...request.context,
          ...(request.responseId ? { response_id: request.responseId } : {}) } : {}),
        ...fields,
      });
      const watch = (event, started) => {
        clearTimeout(timer);
        let after = 1_000;
        const waiting = () => {
          if (closed) return;
          const now = performance.now();
          record(event, { elapsed_ms: now - started,
            ...(active ? { received_message_count: active.messages,
              ...(active.firstMessage === undefined ? {} : { first_message_ms: active.firstMessage - active.started }),
              ...(active.firstOutput === undefined ? {} : { first_output_ms: active.firstOutput - active.started }),
              last_message_age_ms: now - (active.lastMessage ?? active.started), ...measure() } : {}) });
          after = Math.min(after * 2, 5_000);
          timer = setTimeout(waiting, after);
        };
        timer = setTimeout(waiting, after);
      };
      const responseLink = (request, id) => {
        if (!request || !identifier(id, "resp_")) return;
        request.responseId = id;
        retain(responses, id, request, 32);
      };
      const finish = (outcome) => {
        if (!active) return;
        clearTimeout(timer);
        record("request.finished", { outcome, elapsed_ms: performance.now() - active.started,
          received_message_count: active.messages, ...measure() });
        last = active;
        active = undefined;
      };
      const socket = {
        sessionId,
        connected(value) {
          handshake = value;
          clearTimeout(timer);
          record("socket.opened", { elapsed_ms: performance.now() - began });
        },
        sendStarted() {
          finish("superseded");
          active = { index: ++ordinal, context: calls.get(sessionId) ?? {}, started: performance.now(), messages: 0 };
          record("request.send_started", measure());
          watch("request.send_waiting", active.started);
        },
        sent() {
          if (!active) return;
          const now = performance.now();
          record("request.sent", { send_wait_ms: now - active.started, ...measure() });
          if (active.firstMessage === undefined) active.started = now;
          active.sentAt = now;
          watch("request.waiting", active.started);
        },
        sendFailed() { finish("send_failed"); },
        message(text) {
          const now = performance.now();
          if (active) {
            active.messages++;
            active.lastMessage = now;
            // A new frame ends the current silence interval. Streaming calls
            // produce no waiting records while frames keep arriving.
            if (active.sentAt !== undefined) watch("request.waiting", active.started);
            if (active.firstMessage === undefined) {
              active.firstMessage = now;
              record("request.first_message", { elapsed_ms: now - active.started, ...measure() });
            }
          }
          // Parse only small protocol envelopes before the first output. Never
          // retain their contents, and never parse large output or tool bodies.
          if (active && active.firstOutput === undefined && typeof text === "string" && text.length <= 16_384) {
            let frame;
            try { frame = JSON.parse(text); } catch { return; }
            responseLink(active, frame?.response?.id);
            if (OUTPUT_EVENTS.has(frame?.type)) {
              active.firstOutput = now;
              record("request.first_output", { elapsed_ms: now - active.started, ...measure() });
            }
          }
        },
        provider(timing) {
          const request = timing.response_id ? responses.get(timing.response_id) : active ?? last;
          if (request?.timingReported) return;
          if (request) request.timingReported = true;
          record("provider.timing", timing, request ?? null);
        },
        finished(index, responseId, outcome) {
          if (active?.context.model_call_index !== index) return;
          responseLink(active, responseId);
          finish(outcome);
        },
        close(event, intentional = false) {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          record("socket.closed", { elapsed_ms: performance.now() - began, intentional,
            ...(Number.isInteger(event?.code) ? { close_code: event.code } : {}),
            ...(typeof event?.wasClean === "boolean" ? { close_clean: event.wasClean } : {}),
            ...(active ? { received_message_count: active.messages,
              last_message_age_ms: performance.now() - (active.lastMessage ?? active.started) } : {}), ...measure() });
          active = undefined;
          sockets.delete(socket);
        },
        error() { record("socket.error", { elapsed_ms: performance.now() - began, ...measure() }); },
      };
      sockets.add(socket);
      record("socket.connecting", {}, undefined);
      watch("socket.connect_waiting", began);
      return socket;
    },
  };
}

function uuid(value) { return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value); }
function identifier(value, prefix) { return typeof value === "string" && value.startsWith(prefix) && /^[A-Za-z0-9_-]{1,160}$/.test(value); }
const OUTPUT_EVENTS = new Set(["response.output_text.delta", "response.reasoning_summary_text.delta",
  "response.reasoning_summary.delta", "response.reasoning_content.delta", "response.output_item.added", "response.output_item.done"]);
