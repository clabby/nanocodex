// Fixture account context and transport only. Production apps handlers own all
// validation decisions and D1 writes; the HTTP peer executes the real Swift CLI.
import type { ToolContext } from "nanocodex";
import type { Principal } from "../src/account-auth";
import { AppError, type AppValidator } from "../src/prompt-apps";
import { routeAppsRequest } from "../src/prompt-apps-http";
import { appTools } from "../src/prompt-apps-tools";
import { AccountHostedTools } from "../src/account-hosted-tools";
import { nativeAppValidator } from "../src/prompt-apps-native";
export { AccountHostedTools };

interface Env {
  NANOCODEX_CRM: D1Database;
  SWIFT_VALIDATOR_URL: string;
  NANOCODEX_ACCOUNT_TOOLS: DurableObjectNamespace<AccountHostedTools>;
}
const owner = "11111111-1111-4111-8111-111111111111";
function principalFor(request: Request): Principal | undefined {
  const fixture = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!["owner", "other", "read", "write", "no-tools", "connect", "cookie"].includes(fixture ?? "")) return undefined;
  return {
    kind: fixture === "connect" ? "connect_grant" : fixture === "cookie" ? "account_session" : "api_key",
    userId: fixture === "other" ? "22222222-2222-4222-8222-222222222222" : owner,
    organizationId: owner, teamId: owner, subjectId: `user:${owner}`, credentialId: "fixture", authorizationEpoch: 1, role: "owner",
    capabilities: fixture === "read" ? ["agents:read", "tools:use"] : fixture === "write" ? ["agents:write", "tools:use"]
      : fixture === "no-tools" ? ["agents:read", "agents:write"] : ["agents:read", "agents:write", "tools:use"],
  };
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const principal = principalFor(request);
    const context: ToolContext = {
      sessionId: "native-app-validation-journey",
      callId: request.headers.get("x-fixture-call-id") ?? crypto.randomUUID(),
      parentCallId: "native-app-validation-journey", model: "fixture", signal: request.signal,
    };
    const localValidate: AppValidator = async input => {
      let response: Response;
      try {
        response = await fetch(env.SWIFT_VALIDATOR_URL, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(input), signal: request.signal,
        });
      } catch {
        throw new AppError("app_validation_unavailable", 503);
      }
      if (!response.ok) throw new AppError("app_validation_unavailable", 503);
      return response.json();
    };
    const validate = request.headers.get("x-fixture-validator") === "hand"
      ? nativeAppValidator(env.NANOCODEX_ACCOUNT_TOOLS, principal?.userId ?? owner, context,
        () => !!principal && principal.kind !== "connect_grant")
      : localValidate;
    const path = new URL(request.url).pathname;
    if (path === "/__fixture/hand" && principal?.kind === "api_key") {
      return env.NANOCODEX_ACCOUNT_TOOLS.getByName(principal.userId).fetch("https://account-tools.internal/tool-host", {
        headers: { upgrade: "websocket", "x-nanocodex-owner-id": principal.userId },
      });
    }
    if (path.startsWith("/v1/apps")) return routeAppsRequest(request, env.NANOCODEX_CRM, principal, validate);
    if (request.method !== "POST" || path !== "/tools/apps") return new Response("not_found", { status: 404 });
    const [apps] = appTools({
      db: env.NANOCODEX_CRM, ownerId: principal?.userId ?? owner,
      authorization: () => principal ? { capabilities: principal.capabilities,
        ...(principal.kind === "connect_grant" ? { connectGrant: {} } : {}) } : undefined,
      validator: () => validate,
    });
    try {
      return Response.json(await apps.handler(await request.json(), context));
    } catch (error) {
      if (error instanceof AppError) return Response.json({ error: error.code, ...(error.validation ? { validation: error.validation } : {}) }, { status: error.status });
      throw error;
    }
  },
};
