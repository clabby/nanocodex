// Only account authentication is a fixture. All /v1/apps routing, validation,
// authorization and D1 persistence below run in the production worker.
export * from "./memory-scope-worker";
import worker from "../src/index";
import { routeManaged } from "../../account/worker/managedProxy";
import type { Principal } from "../src/account-auth";
const owner = "11111111-1111-4111-8111-111111111111";
export default {
  async fetch(request: Request, env: Parameters<typeof worker.fetch>[1], ctx: ExecutionContext) {
    const fixture = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const known = ["owner", "other", "read", "write", "no-tools", "connect", "cookie"].includes(fixture ?? "");
    const principal: Principal | undefined = known ? {
      kind: fixture === "connect" ? "connect_grant" : fixture === "cookie" ? "account_session" : "api_key",
      userId: fixture === "other" ? "22222222-2222-4222-8222-222222222222" : owner,
      organizationId: owner, teamId: owner, subjectId: `user:${owner}`, credentialId: "fixture", authorizationEpoch: 1, role: "owner",
      capabilities: fixture === "read" ? ["agents:read", "tools:use"] : fixture === "write" ? ["agents:write", "tools:use"]
        : fixture === "no-tools" ? ["agents:read", "agents:write"] : ["agents:read", "agents:write", "tools:use"],
    } : undefined;
    return await routeManaged(request, { NANOCODEX_BACKEND: { fetch: (forwarded: Request) => worker.fetch(forwarded, env, ctx, principal) } as Fetcher }, new URL(request.url))
      ?? new Response("not_found", { status: 404 });
  },
};
