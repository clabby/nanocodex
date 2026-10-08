import { DurableObject } from "cloudflare:workers";

/**
 * Retired: regional Hand relays are gone; every Hand publishes to its account
 * object. Hibernated sockets from relay publishers survive code updates, so a
 * wake closes them with a reconnectable code and the Hand republishes to its
 * account object. Kept only until its deleted_classes migration ships.
 */
export class RegionalHandRelay extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    for (const socket of ctx.getWebSockets()) RegionalHandRelay.#retire(socket);
  }
  static #retire(socket: WebSocket): void {
    try { socket.close(1012, "Hand relay retired; reconnect"); } catch { /* already closed */ }
  }
  fetch(): Response { return Response.json({ error: "not_found" }, { status: 404 }); }
  webSocketMessage(socket: WebSocket): void { RegionalHandRelay.#retire(socket); }
  webSocketClose(): void { /* nothing retained */ }
  webSocketError(socket: WebSocket): void { RegionalHandRelay.#retire(socket); }
  alarm(): void { /* nothing scheduled */ }
}
