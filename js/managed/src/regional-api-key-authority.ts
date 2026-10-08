import { isRegionalApiKeyAuthorityName, isRegionalApiKeyAuthorityRegion, regionalApiKeyAuthorityName, regionalApiKeyAuthorityRegion, REGIONAL_API_KEY_AUTHORITY_REGIONS } from "nanocodex/cloudflare/durable-placement";

/**
 * A regional authority is a separate ApiKeyRecord object near the ingress. It
 * may answer only while it holds a volatile lease that the key's primary object
 * granted after registering that replica with every authority source (key
 * primary, UserAccount, Organization) and then reading their live state.
 *
 * Revocation contract: every authority-reducing mutation of a key record, an
 * account, an organization, a team or a membership must commit, then call
 * revokeApiKeyAuthorityLeases on the mutated object's storage, and acknowledge
 * only after it returns true. Each authority object registers a replica and
 * reads its own state in one uninterrupted step, so a mutation either
 * enumerates the registration or the grant reads the mutation.
 *
 * Revocation never relies on wall-clock expiry: every registered replica must
 * acknowledge, however old its registration. A replica acknowledges only after
 * dropping its lease and discarding every in-flight grant. Expiry is a
 * replica-local refresh interval on a monotonic clock; it is defense in depth,
 * not part of the revocation guarantee.
 */
export const REGIONAL_API_KEY_AUTHORITY_LEASE_MS = 60_000;
export const API_KEY_AUTHORITY_LEASE_PREFIX = "apiKeyAuthorityLease:";
// Naming and region routing are public placement helpers shared with ingress.
export { isRegionalApiKeyAuthorityName, isRegionalApiKeyAuthorityRegion, regionalApiKeyAuthorityName, regionalApiKeyAuthorityRegion, REGIONAL_API_KEY_AUTHORITY_REGIONS };

export type RegionalApiKeyAuthorization<Record> = Readonly<{ record: Record; apiKeyObjectId: string }>;
type LeaseEntry = Readonly<{ replica: string; token: string }>;
type LeaseStorage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
export type ApiKeyAuthorityReplicas = { getByName(name: string): { revokeRegionalLease(): Promise<unknown> } };

/** Scopes must not prefix one another; user scopes end in ":". "" means every scope. */
export const apiKeyAuthorityUserScope = (userId: string) => `user:${userId}:`;

/**
 * Register one replica under scope before the caller reads live authority.
 * Every registration gets a fresh token, so revocation never prunes a
 * registration made after it enumerated the registry.
 */
export async function registerApiKeyAuthorityLease(storage: LeaseStorage, scope: string, replica: string): Promise<boolean> {
  if (!isRegionalApiKeyAuthorityName(replica)) return false;
  await storage.put(`${API_KEY_AUTHORITY_LEASE_PREFIX}${scope}${replica}`, { replica, token: crypto.randomUUID() } satisfies LeaseEntry);
  return true;
}

const REPLICA_SUFFIX = /api-key-authority:v1:(?:wnam|enam|sam|weur|eeur|apac|oc):[0-9a-f]{64}$/;
// Durable Object storage get/delete accept at most 128 keys per call.
const STORAGE_BATCH = 128;
const batches = <T>(values: readonly T[]) => Array.from({ length: Math.ceil(values.length / STORAGE_BATCH) },
  (_, index) => values.slice(index * STORAGE_BATCH, (index + 1) * STORAGE_BATCH));

/**
 * Revoke every registered replica under scope (all scopes by default),
 * regardless of age. Returns true only when each one acknowledged; the caller
 * must not acknowledge its mutation otherwise. The replica is named by the
 * storage key this module wrote, never by the stored value; an unparsable key
 * fails closed. Acknowledged entries are pruned only if no newer registration
 * replaced them; a retry resumes from the rest.
 */
export async function revokeApiKeyAuthorityLeases(storage: LeaseStorage, replicas: ApiKeyAuthorityReplicas, scope = ""): Promise<boolean> {
  const entries = [...await storage.list<LeaseEntry>({ prefix: `${API_KEY_AUTHORITY_LEASE_PREFIX}${scope}` })];
  if (!entries.length) return true;
  const outcomes = await Promise.all(entries.map(async ([key, lease]) => {
    const replica = key.match(REPLICA_SUFFIX)?.[0];
    if (!replica) return undefined;
    try { return await replicas.getByName(replica).revokeRegionalLease() === true ? [key, lease?.token] as const : undefined; }
    catch { return undefined; }
  }));
  const acknowledged = outcomes.filter((outcome) => outcome !== undefined);
  for (const batch of batches(acknowledged)) {
    // Compare and delete with no intervening non-storage I/O: the object's
    // input gate keeps a concurrent registration from interleaving.
    const current = await storage.get<LeaseEntry>(batch.map(([key]) => key));
    const removable = batch.filter(([key, token]) => token !== undefined && current.get(key)?.token === token).map(([key]) => key);
    if (removable.length) await storage.delete(removable);
  }
  return acknowledged.length === entries.length;
}
