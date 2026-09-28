import { Challenge, Credential, Mcp } from "mppx";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error exercising the internal JS MCP runtime in an integration test
import { createMcpRuntime } from "../../nanocodex/runtime/mcp-runtime.mjs";
import { mercatorMcpPayment } from "../src/mercator-mcp-payment";
const plan = { nodes: [{ id: "one", serviceId: "synthetic", method: "GET", path: "/lookup" }] };
const args = { idempotency_key: "synthetic-key-123", plan, approved_total: "0.05" };
const challenge = Challenge.from({ id: "synthetic-mcp-challenge", method: "tempo", intent: "charge", realm: "mercator.sh",
  expires: new Date(Date.now() + 60_000).toISOString(), request: { amount: "50000", currency: "0x20c000000000000000000000b9537d11c60e8b50",
    recipient: "0x0000000000000000000000000000000000000002", methodDetails: { chainId: 4217, feePayer: true, supportedModes: ["pull"], machineTokenEnabled: true } },
});
describe("default Mercator MCP wallet payment", () => {
  it("keeps free tools on the normal MCP and retries only create_job with broker-signed metadata", async () => {
    const calls: any[] = [];
    const client = { async listTools() { return { tools: [
      { name: "quote_plan", inputSchema: { type: "object" } }, { name: "create_job", inputSchema: { type: "object" } },
    ] }; }, async callTool(params: any) { calls.push(params);
      if (params.name === "quote_plan") return { content: [{ type: "text", text: JSON.stringify({ totalAmount: "0.05", validUntil: new Date(Date.now() + 60_000).toISOString() }) }] };
      if (!params._meta?.[Mcp.credentialMetaKey]) return { content: [], _meta: { [Mcp.paymentRequiredMetaKey]: { challenges: [challenge] } } };
      expect(params._meta[Mcp.credentialMetaKey]).toMatchObject({ payload: { type: "transaction" } });
      return { content: [{ type: "text", text: "job created" }] };
    } };
    const broker = { fetch: vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ ...args, challenge: { id: challenge.id } });
      return Response.json({ credential: Credential.serialize({ challenge, payload: { type: "transaction", signature: "0xsynthetic" } }) });
    }) };
    const payment = mercatorMcpPayment(broker as never, "owner", () => {});
    const runtime = await createMcpRuntime({ mercator: { client, payment } });
    try {
      await runtime.settled();
      expect((await runtime.resolve("mcp__mercator__quote_plan").handler({ plan })).value.content[0].text).toContain("totalAmount");
      expect(broker.fetch).not.toHaveBeenCalled();
      const result = await runtime.resolve("mcp__mercator__create_job").handler(args, { signal: new AbortController().signal, callId: "call-1" });
      expect(result.value.content[0].text).toBe("job created");
      expect(calls.map(c => c.name)).toEqual(["quote_plan", "quote_plan", "create_job", "create_job"]);
      expect(broker.fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.close(); }
  });
  it("rejects a stale or mismatched quote before a paid MCP call", async () => {
    const callTool = vi.fn(async (_params: any) => ({ content: [{ type: "text", text: JSON.stringify({ totalAmount: "0.04",
      validUntil: new Date(Date.now() + 60_000).toISOString() }) }] }));
    const broker = { fetch: vi.fn(async () => Response.json({})) };
    const runtime = await createMcpRuntime({ mercator: { client: {
      async listTools() { return { tools: [{ name: "create_job", inputSchema: { type: "object" } }] }; }, callTool,
    }, payment: mercatorMcpPayment(broker as never, "owner", () => {}) } });
    try { await runtime.settled();
      await expect(runtime.resolve("mcp__mercator__create_job").handler(args)).rejects.toThrow(/quote/);
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(callTool.mock.calls[0][0].name).toBe("quote_plan");
      expect(broker.fetch).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });
  it("denies restricted grant execution before contacting the MCP or broker", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const broker = { fetch: vi.fn(async () => Response.json({})) };
    const runtime = await createMcpRuntime({ mercator: { client: {
      async listTools() { return { tools: [{ name: "create_job", inputSchema: { type: "object" } }] }; }, callTool,
    }, payment: mercatorMcpPayment(broker as never, "owner", () => { throw Error("forbidden"); }) } });
    try { await runtime.settled();
      await expect(runtime.resolve("mcp__mercator__create_job").handler(args)).rejects.toThrow("forbidden");
      expect(callTool).not.toHaveBeenCalled(); expect(broker.fetch).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });
  it("cannot pay a challenged read-only tool or a missing wallet", async () => {
    const client = { async listTools() { return { tools: [{ name: "get_job", inputSchema: { type: "object" } }, { name: "create_job", inputSchema: { type: "object" } }] }; },
      async callTool(params: any) {
        if (params.name === "quote_plan") return { content: [{ type: "text", text: JSON.stringify({ totalAmount: "0.05", validUntil: new Date(Date.now() + 60_000).toISOString() }) }] };
        return { content: [], _meta: { [Mcp.paymentRequiredMetaKey]: { challenges: [challenge] } } };
      } };
    const broker = { fetch: vi.fn(async () => new Response(null, { status: 404 })) };
    const runtime = await createMcpRuntime({ mercator: { client, payment: mercatorMcpPayment(broker as never, "owner", () => {}) } });
    try { await runtime.settled();
      await expect(runtime.resolve("mcp__mercator__get_job").handler({ job_id: "test" })).rejects.toThrow();
      expect(broker.fetch).not.toHaveBeenCalled();
      await expect(runtime.resolve("mcp__mercator__create_job").handler(args)).rejects.toThrow(/wallet is not configured/);
      expect(broker.fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.close(); }
  });
});
