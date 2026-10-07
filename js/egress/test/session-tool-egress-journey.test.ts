import { exports } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Real workerd entrypoint journey: the test runtime's MANAGED_AGENT_OWNERSHIP
// binding always answers 503, so any Session callback fails closed. The private
// Session tool entrypoint must complete without it.
const toolEgress = (exports as unknown as { SessionToolEgress: Fetcher }).SessionToolEgress;
const user = "session-tool-journey-owner";
const subject = `managed-session-v1_${"d".repeat(64)}`;

async function createLogin(): Promise<string> {
  const response = await SELF.fetch(`https://broker.internal/users/${user}/credentials/vault/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Journey login", username: "person@example.com", password: "journey-secret" }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ id: string }>()).id;
}
function vaultRequest(id: string, headers: Record<string, string>): Request {
  return new Request("https://vault-egress.internal/v1/request", { method: "POST", headers: {
    "content-type": "application/json", "x-nanocodex-subject": subject, ...headers,
  }, body: JSON.stringify({ vault_id: id, url: "https://merchant.example.com/login?u={{NANOCODEX_VAULT_USERNAME}}", method: "GET", headers: { authorization: "Basic {{NANOCODEX_VAULT_BASIC}}" } }) });
}

describe("SessionToolEgress real entrypoint journey", () => {
  it("completes repeated Vault requests through the real broker without the Session ownership callback", async () => {
    const id = await createLogin();
    // Generic broker path: resolves the Session subject through the callback, which fails here.
    const generic = await SELF.fetch(vaultRequest(id, {}));
    expect(generic.status).toBe(503);
    expect(await generic.json()).toMatchObject({ error: "agent_subject_unavailable" });
    // Spoofed assertion on the generic broker is rejected outright.
    expect((await SELF.fetch(vaultRequest(id, { "x-nanocodex-session-tool-owner": user }))).status).toBe(403);
    for (let i = 0; i < 5; i++) {
      const response = await toolEgress.fetch(vaultRequest(id, { "x-nanocodex-session-tool-owner": user }));
      const text = await response.text();
      expect(text).not.toContain("journey-secret");
      expect(text).not.toContain("agent_subject_unavailable");
      expect(response.status, text).toBe(200);
      const body = JSON.parse(text) as { status: number; ok: boolean };
      expect(Number.isInteger(body.status)).toBe(true);
    }
    // Another owner's assertion cannot read this user's Vault item.
    const foreign = await toolEgress.fetch(vaultRequest(id, { "x-nanocodex-session-tool-owner": "session-tool-journey-other" }));
    expect(foreign.status).toBeGreaterThanOrEqual(400);
  });
});
