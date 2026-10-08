import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { createApiKey, type AccountAuthEnv } from "../src/account-auth";
import { regionalApiKeyAuthorityName } from "../src/regional-api-key-authority";

for (const source of ["membership", "team", "organization", "account"] as const) {
it(`operator ${source} removal plus explicit revoke RPC invalidates a warmed replica`, async () => {
  const runtime = env as unknown as AccountAuthEnv;
  const userId = crypto.randomUUID();
  const account = await runtime.NANOCODEX_USERS.getByName(userId).fetch("https://user.internal/account", {
    method: "PUT", body: JSON.stringify({ id: userId, persistent: true }),
  }).then(r => r.json<{ organizationId: string }>());
  const org = runtime.NANOCODEX_ORGANIZATIONS.getByName(account.organizationId);
  const grant = await org.fetch(`https://organization.internal/resolve?userId=${userId}`).then(r => r.json<{
    teamId: string; role: "owner"; capabilities: string[]; authorizationEpoch: number }>());
  const principal = { kind: "account_session", userId, organizationId: account.organizationId, teamId: grant.teamId,
    role: grant.role, capabilities: grant.capabilities, authorizationEpoch: grant.authorizationEpoch,
    subjectId: `user:${userId}`, credentialId: userId } as unknown as Parameters<typeof createApiKey>[1];
  const { token } = await createApiKey(runtime, principal, "security review synthetic fixture");
  const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const primary = runtime.NANOCODEX_API_KEYS.getByName(digest);
  const primaryId = runtime.NANOCODEX_API_KEYS.idFromName(digest).toString();
  const regional = runtime.NANOCODEX_API_KEYS.getByName(regionalApiKeyAuthorityName(primaryId, "wnam"));
  expect(await regional.resolveRegionalAuthorizedKey(primaryId, "wnam")).toBeDefined();
  // These sources have no public removal API. Operator edits must commit
  // storage first, then call the corresponding revoke RPC and await true.
  if (source === "account") {
    const user = runtime.NANOCODEX_USERS.getByName(userId);
    await runInDurableObject(user, async (_, state) => { await state.storage.delete("account"); });
    expect(await user.revokeApiKeyAuthorityLeases()).toBe(true);
  } else {
    await runInDurableObject(org, async (_, state) => {
      const key = source === "membership" ? `membership:user:${userId}`
        : source === "team" ? `team:${grant.teamId}` : "metadata";
      expect(await state.storage.get(key)).toBeDefined();
      await state.storage.delete(key);
    });
    expect(await org.revokeApiKeyAuthorityLeases(source === "membership" ? userId : undefined)).toBe(true);
  }
  expect(await primary.resolveAuthorizedKey()).toBeUndefined();
  expect(await regional.resolveRegionalAuthorizedKey(primaryId, "wnam")).toBeUndefined();
});
}
