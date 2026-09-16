/** Only initial account viewer upgrades; publishing and renewal keep their existing paths. */
export function isHandViewerUpgrade(request) {
  return request.method === "GET" && new URL(request.url).pathname === "/v1/account/hands/view"
    && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** A finite authorization RPC avoids forwarding a WebSocket through a second Worker. */
export async function forwardHandViewerUpgrade(request, admission, brokers) {
  if (!isHandViewerUpgrade(request)) throw new TypeError("invalid_hand_viewer_upgrade");
  const began = performance.now();
  const prepared = await admission.prepare({ url: request.url, method: request.method, headers: [...request.headers] });
  if (prepared instanceof Response) return prepared;
  const admitted = performance.now();
  // The service owns the account and internal request. Never derive either from client assertions.
  const response = await brokers.getByName(prepared.ownerId).fetch(new Request(prepared.request.url, { method: prepared.request.method, headers: prepared.request.headers }));
  const headers = new Headers(response.headers);
  for (const [name, value] of prepared.headers) {
    if (name === "server-timing") headers.append(name, value);
    else headers.set(name, value);
  }
  headers.append("server-timing", `screen_admission;dur=${(admitted - began).toFixed(1)}, screen_route;dur=${(performance.now() - admitted).toFixed(1)}, screen_total;dur=${(performance.now() - began).toFixed(1)}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers,
    ...(response.status === 101 ? { webSocket: response.webSocket } : {}) });
}
