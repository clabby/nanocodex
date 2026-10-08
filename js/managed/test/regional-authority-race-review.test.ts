import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { ApiKeyRecord, createApiKey, type AccountAuthEnv } from "../src/account-auth";
import { API_KEY_AUTHORITY_LEASE_PREFIX, regionalApiKeyAuthorityName, registerApiKeyAuthorityLease, revokeApiKeyAuthorityLeases } from "../src/regional-api-key-authority";

const runtime = env as unknown as AccountAuthEnv;
afterEach(() => vi.restoreAllMocks());

it("retains a new registration made while an earlier revocation acknowledgement is pending", async () => {
  const stub = runtime.NANOCODEX_API_KEYS.get(runtime.NANOCODEX_API_KEYS.newUniqueId());
  await runInDurableObject(stub, async (_, state) => {
    const replica = regionalApiKeyAuthorityName(state.id.toString(), "wnam");
    await registerApiKeyAuthorityLease(state.storage, "", replica);
    const key = API_KEY_AUTHORITY_LEASE_PREFIX + replica;
    const original = await state.storage.get<{ token: string }>(key);
    let calls = 0;
    const replicas = { getByName: () => ({ revokeRegionalLease: async () => {
      calls++;
      // The old revocation has already taken effect at the replica. A new
      // grant then registers before that RPC's response reaches the caller.
      if (calls === 1) await registerApiKeyAuthorityLease(state.storage, "", replica);
      return true;
    } }) };
    await revokeApiKeyAuthorityLeases(state.storage, replicas);
    const renewed = await state.storage.get<{ token: string }>(key);
    expect(renewed).toBeDefined();
    expect(renewed?.token).not.toBe(original?.token);
    expect(await revokeApiKeyAuthorityLeases(state.storage, replicas)).toBe(true);
    expect(calls).toBe(2);
    expect(await state.storage.get(key)).toBeUndefined();
  });
});

it("never drops an unreachable registration because the wall clock advanced", async () => {
  const stub = runtime.NANOCODEX_API_KEYS.get(runtime.NANOCODEX_API_KEYS.newUniqueId());
  await runInDurableObject(stub, async (_, state) => {
    const replica = regionalApiKeyAuthorityName(state.id.toString(), "wnam");
    await registerApiKeyAuthorityLease(state.storage, "", replica);
    vi.spyOn(Date, "now").mockReturnValue(9_000_000_000_000);
    let calls = 0;
    expect(await revokeApiKeyAuthorityLeases(state.storage, { getByName: () => ({
      revokeRegionalLease: async () => { calls++; throw new Error("unreachable"); },
    }) })).toBe(false);
    expect(calls).toBe(1);
    expect(await state.storage.get(API_KEY_AUTHORITY_LEASE_PREFIX + replica)).toBeDefined();
  });
});

async function liveKey() {
  const userId = crypto.randomUUID();
  const account = await runtime.NANOCODEX_USERS.getByName(userId).fetch("https://user.internal/account", {
    method: "PUT", body: JSON.stringify({ id: userId, persistent: true }),
  }).then(r => r.json<{ organizationId: string }>());
  const grant = await runtime.NANOCODEX_ORGANIZATIONS.getByName(account.organizationId)
    .fetch(`https://organization.internal/resolve?userId=${userId}`).then(r => r.json<{
      teamId: string; role: "owner"; capabilities: string[]; authorizationEpoch: number }>());
  const principal = { kind: "account_session", userId, organizationId: account.organizationId, ...grant,
    subjectId: `user:${userId}`, credentialId: userId } as unknown as Parameters<typeof createApiKey>[1];
  const { token } = await createApiKey(runtime, principal, "race review fixture");
  const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const primaryId = runtime.NANOCODEX_API_KEYS.idFromName(digest).toString();
  return { primaryId, primary: runtime.NANOCODEX_API_KEYS.getByName(digest) };
}

for (const fault of ["grant delayed beyond local deadline", "revocation overtakes grant"] as const) {
  it(`does not authorize when ${fault}`, async () => {
    const { primaryId, primary } = await liveKey();
    const stub = runtime.NANOCODEX_API_KEYS.getByName(regionalApiKeyAuthorityName(primaryId, "wnam"));
    await runInDurableObject(stub, async (_, state) => {
      let now = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      let replica: ApiKeyRecord;
      let grants = 0;
      const controlled = { ...runtime, NANOCODEX_API_KEYS: {
        idFromName: (name: string) => runtime.NANOCODEX_API_KEYS.idFromName(name),
        idFromString: (id: string) => runtime.NANOCODEX_API_KEYS.idFromString(id),
        get: () => ({ grantRegionalLease: async (...args: Parameters<ApiKeyRecord["grantRegionalLease"]>) => {
          const grant = await runtime.NANOCODEX_API_KEYS.get(runtime.NANOCODEX_API_KEYS.idFromString(primaryId)).grantRegionalLease(...args);
          grants++;
          if (fault === "grant delayed beyond local deadline") now += 61_000;
          else await replica.revokeRegionalLease();
          return grant;
        } }),
      } } as unknown as AccountAuthEnv;
      replica = new ApiKeyRecord(state, controlled);
      // A superseded or delayed grant requests a fresh primary check.
      // It must never return the stale authorization record.
      const result = await replica.resolveRegionalAuthorizedKey(primaryId, "wnam").catch(error => { if (!grants) throw error; return undefined; });
      expect(grants).toBeGreaterThan(0);
      expect(result).toBeNull();
    });
  });
}

it("revokes an account registry containing more than 128 replicas", async () => {
  const stub = runtime.NANOCODEX_API_KEYS.get(runtime.NANOCODEX_API_KEYS.newUniqueId());
  await runInDurableObject(stub, async (_, state) => {
    for (let i = 0; i < 129; i++) {
      const replica = regionalApiKeyAuthorityName(i.toString(16).padStart(64, "0"), "wnam");
      await registerApiKeyAuthorityLease(state.storage, "", replica);
    }
    let calls = 0;
    expect(await revokeApiKeyAuthorityLeases(state.storage, { getByName: () => ({
      revokeRegionalLease: async () => { calls++; return true; },
    }) })).toBe(true);
    expect(calls).toBe(129);
    expect((await state.storage.list({ prefix: API_KEY_AUTHORITY_LEASE_PREFIX })).size).toBe(0);
  });
});

it("requires an explicit true acknowledgement and retains non-acknowledged entries for retry", async () => {
  const stub = runtime.NANOCODEX_API_KEYS.get(runtime.NANOCODEX_API_KEYS.newUniqueId());
  await runInDurableObject(stub, async (_, state) => {
    const replica = regionalApiKeyAuthorityName(state.id.toString(), "wnam");
    await registerApiKeyAuthorityLease(state.storage, "", replica);
    for (const acknowledgement of [undefined, false, { ok: true }]) {
      expect(await revokeApiKeyAuthorityLeases(state.storage, { getByName: () => ({
        revokeRegionalLease: async () => acknowledgement,
      }) })).toBe(false);
      expect(await state.storage.get(API_KEY_AUTHORITY_LEASE_PREFIX + replica)).toBeDefined();
    }
    expect(await revokeApiKeyAuthorityLeases(state.storage, { getByName: () => ({
      revokeRegionalLease: async () => true,
    }) })).toBe(true);
    expect(await state.storage.get(API_KEY_AUTHORITY_LEASE_PREFIX + replica)).toBeUndefined();
  });
});
