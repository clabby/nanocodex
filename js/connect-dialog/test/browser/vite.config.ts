import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { connectorCapabilities, publicConnectorStatus } from "../../../connect-api/src/connectorPolicy.mts";
import { fileURLToPath } from "node:url";

// Only external account/SMS services are synthetic. Components and fetch transport are real.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), {
    name: "synthetic-account-transport",
    configureServer(server) {
      let granted: string[] = [];
      const sessions = new Map<string, string>();
      let nextSession = 0;
      const brokerStatuses = () => Object.fromEntries(connectorCapabilities.map(capability => [capability, publicConnectorStatus({ connected: true, connections: [{ id: "c".repeat(43), label: "Synthetic account", capabilities: [capability] }] })]));
      const connectors = () => ({ ...brokerStatuses(), github: { connected: true, label: "atlas-demo" }, gmail: { connected: granted.includes("gmail"), label: granted.includes("gmail") ? "alex@example.com" : undefined }, gcalendar: { connected: granted.includes("gcalendar") } });
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/v1/")) return next();
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        let status = 200;
        let result: unknown;
        // Fixture-only HttpOnly session. Tests choose server state, never client
        // account claims; this cookie is unrelated to production credentials.
        const sessionId = /(?:^|; )fixture-session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
        const session = sessions.get(sessionId ?? "") ?? "anonymous";
        const address = session === "persistent-other" ? "0x2222222222222222222222222222222222222222" : "0x1111111111111111111111111111111111111111";
        const setSession = (state: string) => {
          const id = String(++nextSession);
          sessions.set(id, state);
          res.setHeader("set-cookie", `fixture-session=${id}; HttpOnly; SameSite=Lax; Path=/`);
        };
        switch (req.url) {
          case "/v1/fixture/session": setSession(body.state); result = { ok: true }; break;
          case "/v1/me":
            if (session === "expired") { status = 401; result = { error: "reauthentication_required" }; }
            else if (session === "unavailable") { status = 503; result = { error: "unavailable" }; }
            else result = { user: {
              id: "synthetic-user", persistent: session !== "anonymous",
              ...(session !== "anonymous" && session !== "missing-address" ? { address } : {}),
            } };
            break;
          case "/v1/auth/sms/start":
            await new Promise(resolve => setTimeout(resolve, 120));
            status = body.phone === "+12025550000" ? 503 : 200;
            result = status === 503 ? { error: "sms_delivery_failed" } : { challenge_id: "synthetic-sms-challenge", expires_in: 600 };
            break;
          case "/v1/auth/sms/verify":
            await new Promise(resolve => setTimeout(resolve, 120));
            status = body.code === "123456" ? 200 : 400;
            result = status === 200 ? { user: { id: "synthetic-user", address } } : { error: "invalid_or_expired_otp" };
            if (status === 200) setSession("persistent");
            break;
          case "/v1/connect/hosted-authorization/authorize":
            if (session === "delayed-authorization") await new Promise(resolve => setTimeout(resolve, 500));
            if (!["persistent", "persistent-other", "delayed-authorization", "delayed-exchange"].includes(session)) { status = 401; result = { error: "unauthorized" }; }
            else if (body.account_address !== address) { status = 403; result = { error: "account_address_mismatch" }; }
            else result = { code: "s".repeat(43) };
            break;
          case "/v1/connectors/google": result = { authorization_url: "http://modal.nanocodex.localhost:4198/provider.html" }; break;
          case "/v1/connectors": result = { connectors: connectors() }; break;
          case "/v1/fixture/google-complete": granted = body.capabilities; result = { ok: true }; break;
          case "/v1/hosted-authorizations":
            if (session === "delayed-exchange") await new Promise(resolve => setTimeout(resolve, 500));
            granted = []; result = {
            account_address: address, approval_id: "a".repeat(43), token: "synthetic-token",
            connectors: body.resources?.includes("urn:nanocodex:connectors:github,gmail,gcalendar") ? connectors() : brokerStatuses(), mcp_connections: [], profile: { linked: true },
          }; break;
          default: status = 404; result = { error: "unexpected_fixture_endpoint" };
        }
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      });
    },
  }],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 4198, strictPort: true, allowedHosts: ["modal.nanocodex.localhost"] },
});
