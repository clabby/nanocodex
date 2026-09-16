import { describe, expect, it, vi } from "vitest";
import { authorizeHandRequest, forwardHandRequest, prepareHandViewerAdmission } from "../src/hand-admission";
import { managedAccessResponse, observeManagedAccess } from "../src/managed-access";
import { forwardHandViewerUpgrade } from "../../nanocodex/cloudflare/hand-admission.mjs";
import type { AccountAuthEnv, Principal } from "../src/account-auth";

const env = { NANOCODEX_ACCESS_SECRET: "a-test-key-with-at-least-32-bytes-of-entropy" } as AccountAuthEnv;
const principal: Principal = {
  kind: "api_key", userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222", teamId: "33333333-3333-4333-8333-333333333333",
  role: "writer", subjectId: "api_key:fixture", credentialId: "fixture", authorizationEpoch: 1,
  capabilities: ["agents:read", "tools:use"],
};
function viewer(extra: Record<string, string> = {}) {
  return new Request("https://managed.test/v1/account/hands/view?machine_id=m&surface_id=s&generation=g", {
    headers: { upgrade: "websocket", authorization: "Bearer account-key", ...extra },
  });
}
async function token(request: Request, identity = principal) {
  await observeManagedAccess(request, env, identity, "live", 190);
  return (await managedAccessResponse(request, Response.json({ ok: true }), env)).headers.get("x-nanocodex-access")!;
}

describe("finite Hand viewer authorization", () => {
  it("keeps ownership and surface selection while stripping forged authority", async () => {
    const source = viewer({ "x-nanocodex-owner-id": "forged", "x-nanocodex-remote-vm": "forged" });
    source.headers.set("x-nanocodex-access", await token(source));
    const prepared = await prepareHandViewerAdmission(source, env);
    expect(prepared).not.toBeInstanceOf(Response);
    if (prepared instanceof Response) throw new Error("unexpected rejection");
    expect(prepared.ownerId).toBe(principal.userId);
    expect(prepared.request.url).toBe("https://account-tools.internal/hands/view?machine_id=m&surface_id=s&generation=g");
    expect(prepared.request.headers.get("x-nanocodex-owner-id")).toBe(principal.userId);
    expect(prepared.request.headers.has("x-nanocodex-remote-vm")).toBe(false);
    expect(new Headers(prepared.headers).has("x-nanocodex-access")).toBe(false);
    expect(new Headers(prepared.headers).get("cache-control")).toBe("no-store");
  });

  it("preserves rejected-snapshot retry metadata and does not authorize it", async () => {
    const response = await prepareHandViewerAdmission(viewer({ "x-nanocodex-access": "invalid" }), env);
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("unexpected admission");
    expect(response.status).toBe(401);
    expect(response.headers.get("x-nanocodex-access-rejected")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects missing credentials, expired snapshots and changed credential binding", async () => {
    const anonymous = viewer(); anonymous.headers.delete("authorization");
    const rejected = await prepareHandViewerAdmission(anonymous, env) as Response;
    expect(rejected.status).toBe(401);
    expect(rejected.headers.has("x-nanocodex-access-rejected")).toBe(false);
    const source = viewer(); const snapshot = await token(source);
    const changed = viewer({ authorization: "Bearer different-key", "x-nanocodex-access": snapshot });
    expect((await prepareHandViewerAdmission(changed, env) as Response).status).toBe(401);
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 120_001);
    try {
      expect((await prepareHandViewerAdmission(viewer({ "x-nanocodex-access": snapshot }), env) as Response).status).toBe(401);
    } finally { clock.mockRestore(); }
  });

  it("enforces current account capabilities, Connect restrictions and session origin", async () => {
    for (const identity of [
      { ...principal, capabilities: ["agents:read"] },
      { ...principal, capabilities: ["tools:use"] },
      { ...principal, connectGrant: {} },
    ] as Principal[]) {
      const response = await authorizeHandRequest(viewer(), env, identity);
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(403);
    }
    const session = { ...principal, kind: "account_session" } as Principal;
    expect((await authorizeHandRequest(viewer(), env, session) as Response).status).toBe(403);
    expect((await authorizeHandRequest(viewer({ origin: "https://evil.test" }), env, session) as Response).status).toBe(403);
    expect(await authorizeHandRequest(viewer({ origin: "https://managed.test" }), env, session)).toEqual(session);
  });

  it("does not admit publisher, renewal, finite GET, or alternate paths through the RPC", async () => {
    for (const request of [
      new Request("https://managed.test/v1/account/hands/host", { headers: { upgrade: "websocket" } }),
      new Request("https://managed.test/v1/account/hands/renew", { method: "POST" }),
      new Request("https://managed.test/v1/account/hands/view"),
      new Request("https://managed.test/v1/account/hands/view/extra", { headers: { upgrade: "websocket" } }),
    ]) expect((await prepareHandViewerAdmission(request, env) as Response).status).toBe(400);
    const host = new Request("https://managed.test/v1/account/hands/host", { headers: { upgrade: "websocket" } });
    expect((await authorizeHandRequest(host, env, principal) as Response).status).toBe(403);
  });

  it("never issues a new snapshot for the synthetic finite admission response", async () => {
    const request = viewer();
    await observeManagedAccess(request, env, principal, "live", 190);
    const response = await managedAccessResponse(request, new Response(null, { status: 204 }), env, false);
    expect(response.headers.has("x-nanocodex-access")).toBe(false);
  });

  it("preserves the broker's sole upgraded socket and authenticated metadata", async () => {
    const [client] = Object.values(new WebSocketPair());
    const source = viewer();
    const admission = { prepare: async () => ({ ownerId: principal.userId, request: forwardHandRequest(source, principal),
      headers: [["x-nanocodex-request-id", "fixture-id"], ["server-timing", 'managed_auth;dur=0;desc="access"']] as [string, string][] }) };
    const fetch = vi.fn(async () => new Response(null, { status: 101, webSocket: client }));
    const getByName = vi.fn(() => ({ fetch }));
    const response = await forwardHandViewerUpgrade(source, admission, { getByName });
    expect(getByName).toHaveBeenCalledExactlyOnceWith(principal.userId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(client);
    expect(response.headers.get("x-nanocodex-request-id")).toBe("fixture-id");
    expect(response.headers.get("server-timing")).toContain("screen_route");
  });
});
