import { SELF } from "cloudflare:test";
import { Challenge, Credential } from "mppx";
import { describe, expect, it } from "vitest";
const base = "https://broker.internal/users/mercator-synthetic-broker/wallet";
const input = { idempotency_key: "synthetic-mcp-lookup-1", approved_total: "0.05", plan: { nodes: [{ id: "one", serviceId: "synthetic", method: "GET", path: "/lookup", input: {} }] } };
function challenge() { return Challenge.from({ id: "broker-mcp-challenge", realm: "mercator.sh", method: "tempo", intent: "charge",
  expires: new Date(Date.now() + 60_000).toISOString(), request: { amount: "50000", currency: "0x20c000000000000000000000b9537d11c60e8b50",
    recipient: "0x0000000000000000000000000000000000000002", methodDetails: { chainId: 4217, feePayer: true, supportedModes: ["pull"], machineTokenEnabled: true } },
}); }
describe("broker Mercator MCP challenge", () => {
  it("signs the quoted in-band credential and replays the exact operation", async () => {
    const wallet = await SELF.fetch(base, { method: "PUT" });
    expect(wallet.ok).toBe(true);
    const payload = { ...input, challenge: challenge() };
    const send = (body: unknown) => SELF.fetch(`${base}/mercator/credential`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const [first, replay] = await Promise.all([send(payload), send(payload)]);
    expect(first.status).toBe(200);
    const result = await first.json<{ credential: string }>();
    expect(Credential.deserialize(result.credential)).toMatchObject({ payload: { type: "transaction" } });
    expect(await replay.json()).toEqual(result);
    expect((await send({ ...payload, plan: { nodes: [{ id: "changed" }] } })).status).toBe(409);
    expect((await send({ ...payload, idempotency_key: "other-operation", approved_total: "0.06" })).status).toBe(400);
    const malformed = await SELF.fetch(`${base}/mercator/credential`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
  });
});
