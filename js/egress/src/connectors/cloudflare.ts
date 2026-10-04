/** Explicit API surface: never proxy token minting, live-tail URLs or secret exports. */
export function cloudflareRequestAllowed(method: string, url: URL): boolean {
  const path = url.pathname;
  if (/%|\\/.test(path)) return false;
  if (method === "GET" && path === "/client/v4/accounts") return true;
  if (method === "POST" && path === "/client/v4/graphql") return true;
  const account = "/client/v4/accounts/[a-f0-9]{32}";
  if (method === "GET") return new RegExp(`^${account}/(?:workers/scripts|d1/database(?:/[a-f0-9-]{36})?)$`).test(path);
  return method === "POST" && new RegExp(`^${account}/(?:workers/observability/telemetry/(?:query|keys|values)|d1/database/[a-f0-9-]{36}/query)$`).test(path);
}
