import type { Principal } from "./account-auth";

export const MANAGED_ACCESS_HEADER = "x-nanocodex-access";
export const MANAGED_ACCESS_TTL_MS = 120_000;
export type ManagedAccessEnv = { NANOCODEX_ACCESS_SECRET?: string; DEPLOYMENT_SHA?: string };
type Claims = { version: 1; audience: string; binding: string; issuedAt: number; expiresAt: number; principal: Principal };
const encoder = new TextEncoder();
const observations = new WeakMap<Request, { requestId: string; mode: "live" | "access"; authenticated: boolean; duration: number; claims?: Claims }>();
let cachedKey: { secret: string; promise: Promise<CryptoKey> } | undefined;

/** Finite agent operations and screen viewer admission. Publishers, renewal and
 * agent streams retain live authentication; a viewer renews live every 10 s. */
export function managedAccessRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (path === "/v1/account/hands/view") {
    return request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
  }
  if (path === "/v1/account/hands/screens" || path === "/v1/account/hands/ice") {
    return request.method === (path.endsWith("/screens") ? "GET" : "POST")
      && !request.headers.has("upgrade");
  }
  return /^\/v1\/agents(?:\/|$)/.test(path)
    && !request.headers.has("upgrade")
    && !request.headers.get("accept")?.includes("text/event-stream")
    && !/\/(?:ws|events|tool-host|device-host|sideband)$/.test(path);
}

function key(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("managed_access_not_configured");
  if (cachedKey?.secret !== secret) cachedKey = { secret, promise: crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  ) };
  return cachedKey.promise;
}
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_managed_access");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
}

/** Bind reuse to the original login/key/grant, including all Connect restrictions. */
async function credentialBinding(request: Request, kind: Principal["kind"]): Promise<string> {
  const url = new URL(request.url);
  const connect = kind === "connect_grant" && url.origin === "https://nanocodex.internal" && request.headers.has("x-nanocodex-connect-user");
  // Match the live authenticator's first-cookie and whitespace semantics.
  let cookie: string | undefined;
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === "nanocodex_account") {
      cookie = part.slice(separator + 1).trim();
      break;
    }
  }
  const authorization = request.headers.get("authorization");
  if (!(connect || (kind === "account_session" && cookie) || (kind === "api_key" && authorization))) throw new Error("managed_access_requires_session");
  // Include every authority input so adding a cookie/Connect restriction cannot
  // make a cached API-key principal override the live authenticator's precedence.
  const identity = JSON.stringify({ kind, authorization, cookie: cookie ?? null,
    connect: [...request.headers].filter(([name]) => name.startsWith("x-nanocodex-connect-")).sort() });
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(identity))));
}

export async function readManagedAccess(request: Request, env: ManagedAccessEnv, now = Date.now()): Promise<Principal | undefined> {
  try {
    if (!managedAccessRequest(request)) return;
    const token = request.headers.get(MANAGED_ACCESS_HEADER);
    if (!token || token.length > 16_384) return;
    const [prefix, payload, signature, extra] = token.split(".");
    if (prefix !== "ncx_access_v1" || !payload || !signature || extra !== undefined) return;
    if (!await crypto.subtle.verify("HMAC", await key(env.NANOCODEX_ACCESS_SECRET ?? ""), decode(signature), encoder.encode(`${prefix}.${payload}`))) return;
    const value = JSON.parse(new TextDecoder().decode(decode(payload))) as Claims;
    if (value.version !== 1 || value.audience !== new URL(request.url).origin
      || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
      || value.issuedAt > now || value.expiresAt <= now || value.expiresAt <= value.issuedAt
      || value.expiresAt - value.issuedAt > MANAGED_ACCESS_TTL_MS
      || !value.principal || !["account_session", "api_key", "connect_grant"].includes(value.principal.kind)
      || value.binding !== await credentialBinding(request, value.principal.kind)) return;
    return value.principal;
  } catch { return; }
}

export async function observeManagedAccess(request: Request, env: ManagedAccessEnv, principal: Principal | undefined,
  mode: "live" | "access", duration: number): Promise<void> {
  if (!managedAccessRequest(request)) return;
  let claims: Claims | undefined;
  if (principal && mode === "live" && (env.NANOCODEX_ACCESS_SECRET?.length ?? 0) >= 32
    && principal.kind !== "service") {
    const issuedAt = Date.now();
    claims = { version: 1, audience: new URL(request.url).origin, binding: await credentialBinding(request, principal.kind),
      issuedAt, expiresAt: issuedAt + MANAGED_ACCESS_TTL_MS, principal };
  }
  observations.set(request, { requestId: crypto.randomUUID(), mode, authenticated: principal !== undefined, duration, claims });
}

/** Piggyback issuance on live-authenticated responses: no extra cold-path round trip. */
export async function managedAccessResponse(request: Request, response: Response, env: ManagedAccessEnv): Promise<Response> {
  const observed = observations.get(request);
  if (!observed) return response;
  observations.delete(request);
  const headers = new Headers(response.headers);
  headers.set("x-nanocodex-request-id", observed.requestId);
  if (response.status === 401 && observed.mode === "access" && !observed.authenticated) {
    headers.set("x-nanocodex-access-rejected", "1");
  }
  headers.append("server-timing", `managed_auth;dur=${observed.duration.toFixed(1)};desc="${observed.mode}"`);
  console.info({ type: "managed.auth", request_id: observed.requestId, mode: observed.mode, auth_ms: observed.duration,
    method: request.method, path: new URL(request.url).pathname, status: response.status, deployment_sha: env.DEPLOYMENT_SHA });
  if (observed.claims && response.ok && !/max-age|public/.test(headers.get("cache-control") ?? "")) {
    const payload = `ncx_access_v1.${encode(encoder.encode(JSON.stringify(observed.claims)))}`;
    const signature = await crypto.subtle.sign("HMAC", await key(env.NANOCODEX_ACCESS_SECRET!), encoder.encode(payload));
    headers.set(MANAGED_ACCESS_HEADER, `${payload}.${encode(new Uint8Array(signature))}`);
    headers.set("x-nanocodex-access-ttl-ms", String(Math.max(0, observed.claims.expiresAt - Date.now())));
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers,
    ...(response.status === 101 ? { webSocket: response.webSocket } : {}),
  });
}
