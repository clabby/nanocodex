import { routeUserDataRequest, type UserDataRouteEnv } from "../src/user-data-route";
import type { Principal } from "../src/account-auth";
export { UserDataScope } from "../src/user-data-scope";
// Only the external account identity provider is substituted. HTTP routing,
// Durable Object transport, SQLite, R2 and authorization policy are real.
export default {
  async fetch(request: Request, env: UserDataRouteEnv) {
    const response = await routeUserDataRequest(request, env, new URL(request.url), async incoming => {
      const token = incoming.headers.get("authorization")?.replace(/^Bearer /u, "");
      const fixture = /^fixture-(alice|bob)-(read|write|both|session)$/u.exec(token ?? "");
      if (!fixture) return undefined;
      return {
        kind: fixture[2] === "session" ? "account_session" : "api_key",
        userId: `user-data-fixture-${fixture[1]}`,
        organizationId: "fixture-org", teamId: "fixture-team", role: "owner",
        subjectId: "api_key:fixture", credentialId: "fixture", authorizationEpoch: 1,
        capabilities: fixture[2] === "read" ? ["data:read"]
          : fixture[2] === "write" ? ["data:write"] : ["data:read", "data:write"],
      } satisfies Principal;
    });
    return response ?? new Response(null, { status: 404 });
  },
};
