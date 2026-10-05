/** Fixed public read-only route to backend approval-key discovery; no enrollment authority. */
export async function routeNativeInputDiscoveryProxy(
  request: Request, env: { NANOCODEX_BACKEND?: Fetcher }, url = new URL(request.url),
): Promise<Response | undefined> {
  if (url.pathname !== "/.well-known/nanocodex-native-input") return undefined;
  const error = (name: string, status: number, headers: Record<string, string> = {}) =>
    Response.json({ error: name }, { status, headers: {
      "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers,
    } });
  if (request.method !== "GET") return error("method_not_allowed", 405, { allow: "GET" });
  if (url.href.includes("?")) return error("invalid_request", 400);
  if (!env.NANOCODEX_BACKEND) return error("native_input_unavailable", 503);
  try {
    // No caller credentials, headers, query or body are forwarded to discovery.
    return await env.NANOCODEX_BACKEND.fetch(new Request(
      "https://nanocodex.internal/.well-known/nanocodex-native-input"));
  } catch { return error("native_input_unavailable", 503); }
}
