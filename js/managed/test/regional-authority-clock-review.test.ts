import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { ApiKeyRecord, createApiKey, type AccountAuthEnv } from "../src/account-auth";
import { regionalApiKeyAuthorityName } from "../src/regional-api-key-authority";

it("primary clock jump cannot acknowledge deletion while a replica still authorizes", async () => {
  const runtime = env as unknown as AccountAuthEnv;
  const userId = crypto.randomUUID();
  const account = await runtime.NANOCODEX_USERS.getByName(userId).fetch("https://user.internal/account", {
    method: "PUT", body: JSON.stringify({ id: userId, persistent: true }),
  }).then(r => r.json<{ organizationId: string }>());
  const grant = await runtime.NANOCODEX_ORGANIZATIONS.getByName(account.organizationId)
    .fetch(`https://organization.internal/resolve?userId=${userId}`).then(r => r.json<{
      teamId: string; role: "owner"; capabilities: string[]; authorizationEpoch: number }>());
  const principal = { kind: "account_session", userId, organizationId: account.organizationId, teamId: grant.teamId,
    role: grant.role, capabilities: grant.capabilities, authorizationEpoch: grant.authorizationEpoch,
    subjectId: `user:${userId}`, credentialId: userId } as unknown as Parameters<typeof createApiKey>[1];
  const { token } = await createApiKey(runtime, principal, "clock review synthetic fixture");
  const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const primary = runtime.NANOCODEX_API_KEYS.getByName(digest);
  const primaryId = runtime.NANOCODEX_API_KEYS.idFromName(digest).toString();
  const regional = runtime.NANOCODEX_API_KEYS.getByName(regionalApiKeyAuthorityName(primaryId, "wnam"));
  expect(await regional.resolveRegionalAuthorizedKey(primaryId, "wnam")).toBeDefined();
  const status = await runInDurableObject(primary, async (_, state) => {
    // Instantiate the same production class with a controlled primary clock.
    // Restore the clock before observing the separately retained replica.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 120_000);
    try {
      const unreachable = { ...runtime, NANOCODEX_API_KEYS: {
        getByName: () => ({ revokeRegionalLease: async () => { throw new Error("unreachable"); } }),
      } } as unknown as AccountAuthEnv;
      return (await new ApiKeyRecord(state, unreachable).fetch(new Request("https://key/record", { method: "DELETE" }))).status;
    } finally { vi.useRealTimers(); }
  });
  expect(status).toBe(503);
  // The independent replica still has its local lease: failure cannot be
  // reported as completed revocation merely because the primary clock jumped.
  expect(await regional.resolveRegionalAuthorizedKey(primaryId, "wnam")).toBeDefined();
  expect((await primary.fetch("https://key/record", { method: "DELETE" })).status).toBe(204);
  expect(await primary.resolveAuthorizedKey()).toBeUndefined();
  expect(await regional.resolveRegionalAuthorizedKey(primaryId, "wnam")).toBeUndefined();
});
