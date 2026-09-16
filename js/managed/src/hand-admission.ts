import { isHandViewerUpgrade, type HandViewerRequest, type PreparedHandViewer } from "nanocodex/cloudflare/hand-admission";
import { authenticate, forwardPrincipalAssertions, type AccountAuthEnv, type Principal } from "./account-auth";
import { REMOTE_VM_ASSERTION } from "./hand-remote";
import { beginHandTiming, finishHandTiming } from "./hand-timing";
import { managedAccessResponse } from "./managed-access";

const denied = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** Shared by the normal managed route and the private finite viewer-admission RPC. */
export async function authorizeHandRequest(request: Request, env: AccountAuthEnv,
  trustedPrincipal?: Principal): Promise<Response | Principal> {
  const url = new URL(request.url);
  const principal = trustedPrincipal ?? await authenticate(request, env, url);
  if (!principal) return denied("unauthorized", 401);
  if (principal.connectGrant || !principal.capabilities.includes("agents:read")
    || !principal.capabilities.includes("tools:use")
    || (url.pathname.endsWith("/host") && !principal.capabilities.includes("agents:write"))) {
    return denied("forbidden", 403);
  }
  if (principal.kind !== "api_key" && (request.method !== "GET" || request.headers.has("upgrade"))
    && request.headers.get("origin") !== url.origin) {
    return denied("forbidden_origin", 403);
  }
  return principal;
}

/** Caller assertions cannot override the authenticated account or VM lifetime. */
export function forwardHandRequest(request: Request, principal: Principal): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete(REMOTE_VM_ASSERTION);
  forwardPrincipalAssertions(headers, principal);
  return new Request(
    `https://account-tools.internal${url.pathname.slice("/v1/account".length)}${url.search}`,
    new Request(request, { headers }),
  );
}

/** Private binding only. No socket is admitted here, and no successful 101 token is issued. */
export async function prepareHandViewerAdmission(payload: HandViewerRequest, env: AccountAuthEnv): Promise<Response | PreparedHandViewer> {
  const request = new Request(payload.url, { method: payload.method, headers: payload.headers });
  beginHandTiming(request);
  const authorized = isHandViewerUpgrade(request)
    ? await authorizeHandRequest(request, env)
    : denied("invalid_request", 400);
  const metadata = finishHandTiming(request, await managedAccessResponse(request,
    authorized instanceof Response ? authorized : new Response(null, { status: 204, headers: { "cache-control": "no-store" } }), env, false));
  if (authorized instanceof Response) return metadata;
  const internal = forwardHandRequest(request, authorized);
  return { ownerId: authorized.userId, request: { url: internal.url, method: internal.method, headers: [...internal.headers] },
    headers: [...metadata.headers] };
}
