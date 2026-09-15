import { Container } from "@cloudflare/containers";

export class ChatGptEgress extends Container {
  defaultPort = 8080;
  enableInternet = true;
  sleepAfter = "1h";

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/backend-api/codex/realtime/calls") {
      return super.fetch(request);
    }
    const began = performance.now();
    const wasRunning = this.ctx.container?.running;
    const response = await super.fetch(request);
    let timing: Record<string, unknown> = {};
    try { timing = JSON.parse(response.headers.get("x-nanocodex-relay-timing") ?? "{}"); } catch { /* Older relay image. */ }
    const sessionId = request.headers.get("x-session-id");
    console.info({
      type: "voice.relay",
      ...(sessionId && /^[0-9a-f-]{36}$/.test(sessionId) ? { voice_session_id: sessionId } : {}),
      was_running: wasRunning,
      duration_ms: performance.now() - began,
      status: response.status,
      ...Object.fromEntries(["process_age_ms", "fetch_ms", "socket_wait_ms", "upload_ms", "response_wait_ms"]
        .flatMap((key) => typeof timing?.[key] === "number" && Number.isFinite(timing[key]) && timing[key] >= 0
          ? [[key, timing[key]]] : [])),
      ...(typeof timing?.socket_reused === "boolean" ? { socket_reused: timing.socket_reused } : {}),
    });
    const headers = new Headers(response.headers);
    headers.delete("x-nanocodex-relay-timing");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
