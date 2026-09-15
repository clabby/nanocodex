import { describe, expect, it, vi } from "vitest";
import { accountCatalog } from "../src/account-catalog";
import { accountInfo } from "../src/account-info";
import { connectedManagedAccountMcps } from "../src/default-mcp";

describe("admission account catalog", () => {
  it("shares one live read and observes changes on the next admission", async () => {
    const id = "a".repeat(43);
    let connected = true;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/credentials/vault")) return Response.json({ vault: [] });
      expect(url.pathname).toBe("/users/owner/catalog");
      return Response.json({
        connectors: { github: { connected, account: "work" }, slack: { connected: true } },
        mcp_connections: [{ id, name: "Workspace", status: connected ? "connected" : "revoked" }],
      });
    });
    const broker = { fetch } as unknown as Fetcher;
    for (const active of [true, false]) {
      connected = active;
      const catalog = accountCatalog(broker, "owner");
      const [mcps, info] = await Promise.all([
        connectedManagedAccountMcps(broker, "owner", catalog),
        accountInfo(broker, "owner", { enabled: true, allowedConnectors: ["github"], catalog }),
      ]);
      expect(mcps).toEqual(active ? [{ id, name: "Workspace" }] : []);
      expect(info.authenticated).toEqual(active ? ["github"] : []);
    }
    // One catalog + one vault read for each admission; no second metadata lookup.
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("shares failures without projecting a successful empty catalog", async () => {
    const broker = { fetch: vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/credentials/vault") ? Response.json({ vault: [] })
        : new Response(null, { status: 503 })
    )) } as unknown as Fetcher;
    const catalog = accountCatalog(broker, "owner");
    const [mcp, info] = await Promise.allSettled([
      connectedManagedAccountMcps(broker, "owner", catalog),
      accountInfo(broker, "owner", { enabled: true, catalog }),
    ]);
    expect(mcp.status).toBe("rejected");
    expect(info).toMatchObject({ status: "fulfilled", value: { status: "unavailable" } });
  });
});
