/** Authenticated account -> managed preview transport. No configuration means production. */
export interface PreviewBridgeEnv {
  NANOCODEX_PREVIEW_MANAGED_URL?: string;
  NANOCODEX_PREVIEW_ACCOUNT_ORIGIN?: string;
  NANOCODEX_PREVIEW_BRIDGE_SECRET?: string;
}
const PREFIX = "x-nanocodex-preview-";
const ORIGINAL = PREFIX + "url";
const TIME = PREFIX + "time";
const SIGNATURE = PREFIX + "signature";
const INTERNAL = new Set([
  "x-nanocodex-placement-colo", "x-nanocodex-client-ingress-colo", "x-nanocodex-worker-colo",
  "x-nanocodex-connect-output-checkpoints", "x-nanocodex-connect-sandbox-execution",
  "x-nanocodex-owner-id", "x-nanocodex-session-organization-id", "x-nanocodex-session-team-id",
  "x-nanocodex-authorization-epoch", "x-nanocodex-capabilities", "x-nanocodex-create-session-id",
  "x-nanocodex-connect-user", "x-nanocodex-connect-capabilities", "x-nanocodex-connect-grant-id", "x-nanocodex-connect-connectors",
  "x-nanocodex-connect-connector-connections", "x-nanocodex-connect-mcp-ids",
  "x-nanocodex-connect-app-tool-catalog-digest",
]);
export function previewBridgeEnabled(env: PreviewBridgeEnv): boolean {
  return [env.NANOCODEX_PREVIEW_MANAGED_URL, env.NANOCODEX_PREVIEW_ACCOUNT_ORIGIN,
    env.NANOCODEX_PREVIEW_BRIDGE_SECRET].some(value => value !== undefined);
}
function origin(value: string | undefined): URL {
  const url = new URL(value ?? "");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== value || url.username || url.password ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) throw new Error("invalid preview origin");
  return url;
}
function config(env: PreviewBridgeEnv) {
  const managed = origin(env.NANOCODEX_PREVIEW_MANAGED_URL);
  const account = origin(env.NANOCODEX_PREVIEW_ACCOUNT_ORIGIN);
  const secret = env.NANOCODEX_PREVIEW_BRIDGE_SECRET;
  if (!secret || secret.length < 32 || managed.origin === account.origin) throw new Error("invalid preview config");
  return { managed, account, secret };
}
function cleanHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith(PREFIX) || INTERNAL.has(name) || name === "host") headers.delete(name);
  }
  return headers;
}
function failure(status: number): Response {
  return Response.json({ error: status === 503 ? "preview_bridge_unavailable" : "preview_bridge_forbidden" },
    { status, headers: { "cache-control": "no-store" } });
}
async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function message(method: string, url: string, time: string) {
  return new TextEncoder().encode(`nanocodex-preview-v1\n${method}\n${url}\n${time}`);
}
/** Returns the actual upstream response, including its stream or upgraded socket. */
export async function forwardManagedPreview(request: Request, env: PreviewBridgeEnv): Promise<Response> {
  try {
    const selected = config(env);
    const original = new URL(request.url);
    if (original.origin !== selected.account.origin) return failure(403);
    const headers = cleanHeaders(request);
    const time = String(Date.now());
    const signature = await crypto.subtle.sign("HMAC", await key(selected.secret), message(request.method, original.href, time));
    headers.set(ORIGINAL, original.href);
    headers.set(TIME, time);
    headers.set(SIGNATURE, Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join(""));
    const target = new URL(selected.managed);
    target.pathname = original.pathname;
    target.search = original.search;
    return await fetch(new Request(target, new Request(request, { headers, redirect: "manual" })));
  } catch { return failure(503); }
}
/** Call only at external managed ingress, before URL/auth/placement processing. */
export async function receiveManagedPreview(request: Request, env: PreviewBridgeEnv): Promise<Request | Response> {
  if (!previewBridgeEnabled(env)) return request;
  let selected: ReturnType<typeof config>;
  try { selected = config(env); } catch { return failure(503); }
  try {
    const original = new URL(request.headers.get(ORIGINAL) ?? "");
    const incoming = new URL(request.url);
    const time = request.headers.get(TIME) ?? "";
    const signature = request.headers.get(SIGNATURE) ?? "";
    if (incoming.origin !== selected.managed.origin || original.origin !== selected.account.origin ||
      original.username || original.password || original.hash || incoming.pathname !== original.pathname ||
      incoming.search !== original.search || !/^\d{13}$/.test(time) || Math.abs(Date.now() - Number(time)) > 60_000 ||
      !/^[a-f0-9]{64}$/.test(signature)) return failure(403);
    const bytes = Uint8Array.from(signature.match(/../g)!, byte => parseInt(byte, 16));
    if (!await crypto.subtle.verify("HMAC", await key(selected.secret), bytes, message(request.method, original.href, time))) return failure(403);
    return new Request(original, new Request(request, { headers: cleanHeaders(request) }));
  } catch { return failure(403); }
}
