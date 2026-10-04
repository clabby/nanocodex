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
      const brokerStatuses = () => Object.fromEntries(connectorCapabilities.map(capability => [capability, publicConnectorStatus({ connected: true, connections: [{ id: "c".repeat(43), label: "Synthetic account", capabilities: [capability] }] })]));
      const connectors = () => ({ ...brokerStatuses(), github: { connected: true, label: "atlas-demo" }, gmail: { connected: granted.includes("gmail"), label: granted.includes("gmail") ? "alex@example.com" : undefined }, gcalendar: { connected: granted.includes("gcalendar") } });
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/v1/")) return next();
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        let status = 200;
        let result: unknown;
        const address = "0x1111111111111111111111111111111111111111";
        switch (req.url) {
          case "/v1/me": result = { user: { id: "synthetic-anonymous-user", persistent: false } }; break;
          case "/v1/auth/sms/start":
            await new Promise(resolve => setTimeout(resolve, 120));
            status = body.phone === "+12025550000" ? 503 : 200;
            result = status === 503 ? { error: "sms_delivery_failed" } : { challenge_id: "synthetic-sms-challenge", expires_in: 600 };
            break;
          case "/v1/auth/sms/verify":
            await new Promise(resolve => setTimeout(resolve, 120));
            status = body.code === "123456" ? 200 : 400;
            result = status === 200 ? { user: { id: "synthetic-user", address } } : { error: "invalid_or_expired_otp" };
            break;
          case "/v1/connect/hosted-authorization/authorize": result = { code: "s".repeat(43) }; break;
          case "/v1/connectors/google": result = { authorization_url: "http://modal.nanocodex.localhost:4198/provider.html" }; break;
          case "/v1/connectors": result = { connectors: connectors() }; break;
          case "/v1/fixture/google-complete": granted = body.capabilities; result = { ok: true }; break;
          case "/v1/hosted-authorizations": granted = []; result = {
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
