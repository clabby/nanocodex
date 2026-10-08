import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { routeManaged, type ManagedProxyEnv } from "../../account/worker/managedProxy";
import { ApiKeyRecord, createApiKey, resolvePermissionKey, revokeApiKey, type AccountAuthEnv } from "../src/account-auth";
import { API_KEY_AUTHORITY_LEASE_PREFIX, regionalApiKeyAuthorityName } from "../src/regional-api-key-authority";

const runtime = env as unknown as AccountAuthEnv;
afterEach(() => { vi.restoreAllMocks(); });

// Real UserAccount, Organization and ApiKeyRecord objects: the key's primary
// checks live account and grant state exactly as production does.
async function liveKey() {
  const userId = crypto.randomUUID();
  const account = await runtime.NANOCODEX_USERS.getByName(userId).fetch("https://user.internal/account", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: userId, persistent: true }),
  }).then(r => r.json<{ organizationId: string }>());
  const grant = await runtime.NANOCODEX_ORGANIZATIONS.getByName(account.organizationId)
    .fetch(`https://organization.internal/resolve?userId=${userId}`).then(r => r.json<{
      teamId: string; role: "owner"; capabilities: string[]; authorizationEpoch: number }>());
  const principal = { kind: "account_session", userId, organizationId: account.organizationId, teamId: grant.teamId,
    role: grant.role, capabilities: grant.capabilities, authorizationEpoch: grant.authorizationEpoch,
    subjectId: `user:${userId}`, credentialId: userId } as unknown as Parameters<typeof createApiKey>[1];
  const { token, metadata } = await createApiKey(runtime, principal, "regional fixture");
  const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const primaryId = runtime.NANOCODEX_API_KEYS.idFromName(digest).toString();
  const identity = { userId, organizationId: account.organizationId, teamId: grant.teamId,
    authorizationEpoch: grant.authorizationEpoch, keyId: metadata.id };
  return { token, digest, primaryId, userId, keyId: metadata.id, identity };
}

// Each primary grant writes a fresh registration token before reading authority.
const registration = (stub: DurableObjectStub, replica: string) => runInDurableObject(stub, async (_, state) =>
  (await state.storage.get<{ token: string }>(API_KEY_AUTHORITY_LEASE_PREFIX + replica))?.token);

it("LAX ingress authorizes from a wnam lease registered at every authority and deletion revokes it first", async () => {
  const key = await liveKey();
  const addressed: [string, unknown][] = [];
  let creates = 0, fallback = 0;
  const front: ManagedProxyEnv = {
    NANOCODEX_REGIONAL_API_KEY_AUTHORITY: "true",
    NANOCODEX_BACKEND: { fetch: async () => { fallback++; throw Error("unexpected managed fallback"); } } as unknown as Fetcher,
    NANOCODEX_LIVE_API_KEYS: {
      idFromName: name => runtime.NANOCODEX_API_KEYS.idFromName(name),
      getByName: (name, options) => { addressed.push([name, options]); return runtime.NANOCODEX_API_KEYS.getByName(name, options); },
    } as ManagedProxyEnv["NANOCODEX_LIVE_API_KEYS"],
    NANOCODEX_LIVE_SESSIONS: { getByName: () => ({ fetch: async internal => {
      creates++;
      expect(internal.headers.get("x-nanocodex-owner-id")).toBe(key.userId);
      expect(internal.headers.get("x-nanocodex-api-key-object-id")).toBe(key.primaryId);
      return new Response(null, { status: 200 });
    } }) },
  };
  const create = () => {
    const request = new Request("https://test.example/v1/agents/live", {
      headers: { authorization: `Bearer ${key.token}`, upgrade: "websocket" }, cf: { colo: "LAX" } } as RequestInit);
    return routeManaged(request, front, new URL(request.url));
  };
  const replica = regionalApiKeyAuthorityName(key.primaryId, "wnam");
  const primary = runtime.NANOCODEX_API_KEYS.getByName(key.digest);
  const user = runtime.NANOCODEX_USERS.getByName(key.userId);
  const org = runtime.NANOCODEX_ORGANIZATIONS.getByName(key.identity.organizationId);

  expect((await create())?.status).toBe(200);
  // The edge never addresses the far primary; the replica obtained one lease
  // after registering itself with the key, the account and the organization.
  expect(addressed).toEqual([[replica, { locationHint: "wnam" }]]);
  const first = await registration(primary, replica);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(await registration(user, replica)).toBeDefined();
  expect(await registration(org, `user:${key.userId}:${replica}`)).toBeDefined();

  expect((await create())?.status).toBe(200);
  // The Session's running-turn refresh uses the same regional lease.
  expect(await resolvePermissionKey(runtime, key.identity, key.primaryId, "wnam"))
    .toMatchObject({ capabilities: expect.arrayContaining(["agents:write"]) });
  expect(await registration(primary, replica)).toBe(first);

  // The replica's own monotonic deadline forces a full primary re-check.
  const now = performance.now();
  vi.spyOn(performance, "now").mockReturnValue(now + 61_000);
  expect((await create())?.status).toBe(200);
  vi.restoreAllMocks();
  const renewed = await registration(primary, replica);
  expect(renewed).toBeDefined();
  expect(renewed).not.toBe(first);

  expect(await revokeApiKey(runtime, key.userId, key.keyId)).toBe(true);
  expect(await runInDurableObject(primary, (_, state) => state.storage.list().then(entries => entries.size))).toBe(0);
  expect((await create())?.status).toBe(401);
  expect(await resolvePermissionKey(runtime, key.identity, key.primaryId, "wnam")).toBeUndefined();
  // A deleted key registers nothing new.
  expect(await registration(primary, replica)).toBeUndefined();
  expect(creates).toBe(3);
  expect(fallback).toBe(0);
});

it("does not acknowledge deletion while a registered replica has not acknowledged revocation", async () => {
  const key = await liveKey();
  const replicaName = regionalApiKeyAuthorityName(key.primaryId, "wnam");
  const replica = runtime.NANOCODEX_API_KEYS.getByName(replicaName);
  expect(await replica.resolveRegionalAuthorizedKey(key.primaryId, "wnam")).toMatchObject({ apiKeyObjectId: key.primaryId });
  const primary = runtime.NANOCODEX_API_KEYS.getByName(key.digest);
  await runInDurableObject(primary, async (_, state) => {
    for (const acknowledgement of [() => { throw new Error("replica unreachable"); }, () => false]) {
      const unreachable = { ...runtime, NANOCODEX_API_KEYS: { ...runtime.NANOCODEX_API_KEYS,
        getByName: () => ({ revokeRegionalLease: async () => acknowledgement() }) } } as unknown as AccountAuthEnv;
      const pending = await new ApiKeyRecord(state, unreachable).fetch(new Request("https://key/record", { method: "DELETE" }));
      expect(pending.status).toBe(503);
      expect(await pending.json()).toEqual({ error: "revocation_pending" });
      // Fenced: the primary denies at once and grants no new lease.
      expect(await new ApiKeyRecord(state, runtime).resolveAuthorizedKey()).toBeUndefined();
      expect(await new ApiKeyRecord(state, runtime).grantRegionalLease("wnam")).toBeUndefined();
      expect(await state.storage.get(API_KEY_AUTHORITY_LEASE_PREFIX + replicaName)).toBeDefined();
    }
  });
  // The failed acknowledgement leaves the deletion unacknowledged: the public
  // revoke reports failure instead of success.
  await expect(runInDurableObject(primary, async (_, state) => {
    const unreachable = { ...runtime, NANOCODEX_API_KEYS: { ...runtime.NANOCODEX_API_KEYS,
      getByName: () => ({ revokeRegionalLease: async () => { throw new Error("replica unreachable"); } }) } } as unknown as AccountAuthEnv;
    return (await new ApiKeyRecord(state, unreachable).fetch(new Request("https://key/record", { method: "DELETE" }))).status;
  })).resolves.toBe(503);
  // The identical retry completes once the replica is reachable, and the
  // replica then denies.
  expect(await revokeApiKey(runtime, key.userId, key.keyId)).toBe(true);
  expect(await runInDurableObject(primary, (_, state) => state.storage.list().then(entries => entries.size))).toBe(0);
  expect(await replica.resolveRegionalAuthorizedKey(key.primaryId, "wnam")).toBeUndefined();
});

it("a key change while the primary reads remote authority voids the grant without a final denial", async () => {
  const key = await liveKey();
  const primary = runtime.NANOCODEX_API_KEYS.getByName(key.digest);
  await runInDurableObject(primary, async (_, state) => {
    const organizations = runtime.NANOCODEX_ORGANIZATIONS;
    const racing = { ...runtime, NANOCODEX_ORGANIZATIONS: { getByName: (name: string) => ({
      registerApiKeyAuthorityLease: async (userId: string, replica: string) => {
        const grant = await organizations.getByName(name).registerApiKeyAuthorityLease(userId, replica);
        // A permission approval commits while this grant awaits remote reads.
        const record = await state.storage.get<{ label: string }>("record");
        await state.storage.put("record", { ...record, label: "approved meanwhile" });
        return grant;
      } }) } } as unknown as AccountAuthEnv;
    expect(await new ApiKeyRecord(state, racing).grantRegionalLease("wnam")).toBeNull();
  });
  // A null replica answer falls back to the authoritative primary.
  expect(await resolvePermissionKey(runtime, { ...key.identity }, key.primaryId, "wnam"))
    .toMatchObject({ capabilities: expect.arrayContaining(["agents:write"]) });
});

it("a replica answers only for its exact primary and region binding", async () => {
  const key = await liveKey();
  const replica = runtime.NANOCODEX_API_KEYS.getByName(regionalApiKeyAuthorityName(key.primaryId, "wnam"));
  expect(await replica.resolveRegionalAuthorizedKey(key.primaryId, "enam")).toBeUndefined();
  expect(await runtime.NANOCODEX_API_KEYS.getByName(key.digest).resolveRegionalAuthorizedKey(key.primaryId, "wnam")).toBeUndefined();
  expect(await replica.resolveRegionalAuthorizedKey(key.primaryId, "wnam")).toMatchObject({ apiKeyObjectId: key.primaryId });
});
