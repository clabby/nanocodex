import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { consumeRpcData } from "nanocodex/cloudflare/rpc";
import { CredentialVault, type CredentialVaultEnv } from "./credential-vault";
import type { ModelCredentialLeaseGrant, ModelCredentialValue, UserCredentialBroker } from "./broker";

/** Regions a trusted caller may place a replica in. */
export const SNAPSHOT_REGIONS: ReadonlySet<string> = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "oc"]);
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SNAPSHOT_KEY = "snapshot-v1";
const FLOOR_KEY = "floor-v1";
/** One extra canonical attempt after a fenced (late) grant; then fail closed. */
const MAX_FILL_ATTEMPTS = 2;

export interface CredentialSnapshotEnv extends CredentialVaultEnv {
  USER_CREDENTIALS: DurableObjectNamespace<UserCredentialBroker>;
  USER_CREDENTIAL_SNAPSHOTS?: DurableObjectNamespace<UserCredentialSnapshot>;
}

export type SnapshotResolve = Readonly<{
  status: number;
  credential: ModelCredentialValue | null;
  /** "snapshot" served locally; "filled" paid one canonical round trip. */
  source: "snapshot" | "filled" | "none";
  canonical_ms?: number;
}>;
export type PrewarmOutcome = "warm" | "filled" | "unavailable" | "invalid" | "unsupported";

type Entry = { credential: ModelCredentialValue; epoch: number; expiresAt: number };
type StoredSnapshot = { envelope: unknown };

export function snapshotName(region: string, owner: string): string {
  return `${region}:${owner}`;
}

export function snapshotStub(
  env: Pick<CredentialSnapshotEnv, "USER_CREDENTIAL_SNAPSHOTS">,
  owner: string,
  region: string,
): DurableObjectStub<UserCredentialSnapshot> | undefined {
  if (!env.USER_CREDENTIAL_SNAPSHOTS || !OWNER.test(owner) || !SNAPSHOT_REGIONS.has(region)) return undefined;
  return env.USER_CREDENTIAL_SNAPSHOTS.getByName(snapshotName(region, owner),
    { locationHint: region as DurableObjectLocationHint });
}

/**
 * Regional, sealed, leased copy of ONE plain model-credential read
 * (recover=false, no revision, no pinned account). It never refreshes,
 * selects accounts, or reports limits: every such operation stays on the
 * canonical UserCredentialBroker, which grants leases and invalidates every
 * holder (raising its epoch floor) before a credential mutation is
 * acknowledged. A grant whose epoch is below the floor is discarded.
 */
export class UserCredentialSnapshot extends DurableObject<CredentialSnapshotEnv> {
  readonly #vault: CredentialVault;
  #loaded: Promise<void> | undefined;
  #floor = 0;
  #entry: Entry | undefined;
  #fill: Promise<SnapshotResolve> | undefined;

  constructor(state: DurableObjectState, env: CredentialSnapshotEnv) {
    super(state, env);
    this.#vault = new CredentialVault(env, `snapshot/${state.id.toString()}`);
  }

  /** Plain model read. Owner/region must name this exact object. */
  async resolve(owner: string, region: string): Promise<SnapshotResolve> {
    if (!this.#boundTo(owner, region)) return { status: 403, credential: null, source: "none" };
    await this.#load();
    const cached = this.#usable();
    if (cached) return { status: 200, credential: cached.credential, source: "snapshot" };
    const fill = this.#fill ??= this.#fillFromCanonical(owner, region)
      .finally(() => { this.#fill = undefined; });
    return fill;
  }

  /** Outcome only; never returns credential material. */
  async prewarm(owner: string, region: string): Promise<PrewarmOutcome> {
    const result = await this.resolve(owner, region);
    if (result.status === 403) return "invalid";
    if (result.status !== 200) return "unavailable";
    return result.source === "snapshot" ? "warm" : "filled";
  }

  /**
   * Called only by the canonical broker. Durably raises the floor and drops
   * the snapshot before acknowledging; it never calls back into the broker,
   * so the broker may await it while holding its own queue.
   */
  async invalidate(owner: string, region: string, epoch: number): Promise<boolean> {
    if (!this.#boundTo(owner, region) || !Number.isSafeInteger(epoch) || epoch < 0) return false;
    await this.#load();
    if (epoch > this.#floor) this.#floor = epoch;
    this.#entry = undefined;
    // One implicit transaction; the output gate holds the ACK until durable.
    await this.ctx.storage.put(FLOOR_KEY, this.#floor);
    await this.ctx.storage.delete(SNAPSHOT_KEY);
    return true;
  }

  #boundTo(owner: unknown, region: unknown): boolean {
    if (typeof owner !== "string" || typeof region !== "string" || !OWNER.test(owner)
      || !SNAPSHOT_REGIONS.has(region) || !this.env.USER_CREDENTIAL_SNAPSHOTS) return false;
    return this.env.USER_CREDENTIAL_SNAPSHOTS.idFromName(snapshotName(region, owner)).equals(this.ctx.id);
  }

  #usable(): Entry | undefined {
    const entry = this.#entry;
    return entry && this.#servable(entry) ? entry : undefined;
  }

  /** Single fence for cache hits and filled responses: floor, lease expiry
   * and credential expiry, evaluated at the moment of use. */
  #servable(entry: Entry): boolean {
    const now = Date.now();
    if (entry.epoch < this.#floor || entry.expiresAt <= now) return false;
    return entry.credential.expiresAt === undefined || entry.credential.expiresAt > now;
  }

  #load(): Promise<void> {
    return this.#loaded ??= (async () => {
      const stored = await this.ctx.storage.get<unknown>([FLOOR_KEY, SNAPSHOT_KEY]);
      const floor = stored.get(FLOOR_KEY);
      if (typeof floor === "number" && Number.isSafeInteger(floor) && floor > this.#floor) this.#floor = floor;
      const row = stored.get(SNAPSHOT_KEY) as StoredSnapshot | undefined;
      if (!row) return;
      try {
        const opened = await this.#vault.open<Entry>(row.envelope);
        if (validEntry(opened.value) && opened.value.epoch >= this.#floor && !this.#entry) this.#entry = opened.value;
      } catch {
        // An unreadable snapshot is only a cache miss.
      }
    })().catch((error) => { this.#loaded = undefined; throw error; });
  }

  async #fillFromCanonical(owner: string, region: string): Promise<SnapshotResolve> {
    const canonicalStartedAt = Date.now();
    for (let attempt = 0; attempt < MAX_FILL_ATTEMPTS; attempt += 1) {
      // Local expiry is measured from before the request, so clock skew and
      // transit can only shorten the lease relative to the canonical record.
      const requestedAt = Date.now();
      const grant = consumeRpcData(await this.env.USER_CREDENTIALS.getByName(owner)
        .grantModelCredentialLease(owner, region)) as ModelCredentialLeaseGrant;
      const canonical_ms = Date.now() - canonicalStartedAt;
      if (grant.status < 200 || grant.status >= 300 || !grant.credential) {
        return { status: grant.status >= 200 && grant.status < 300 ? 503 : grant.status, credential: null, source: "none", canonical_ms };
      }
      // A revocation raced this grant: it was issued before the mutation and
      // must never reach the caller that started before the invalidation.
      if (!Number.isSafeInteger(grant.epoch) || grant.epoch < this.#floor) continue;
      // A grant without a registered lease is never served: the canonical
      // broker would not invalidate this holder for it.
      if (!Number.isSafeInteger(grant.lease_ms) || grant.lease_ms <= 0) {
        return { status: 503, credential: null, source: "none", canonical_ms };
      }
      const credential = grant.credential;
      const entry: Entry = { credential, epoch: grant.epoch, expiresAt: requestedAt + grant.lease_ms };
      if (!this.#servable(entry)) continue;
      const envelope = await this.#vault.seal(entry);
      // Sealing yields; recheck the full fence before the durable write.
      if (!this.#servable(entry)) continue;
      this.#entry = entry;
      await this.ctx.storage.put(SNAPSHOT_KEY, { envelope } satisfies StoredSnapshot);
      // Recheck after the put instead of relying on gate semantics: identity
      // (an invalidation clears #entry), floor, lease and credential expiry.
      if (this.#entry !== entry || !this.#servable(entry)) {
        if (this.#entry === entry) this.#entry = undefined;
        continue;
      }
      return { status: 200, credential, source: "filled", canonical_ms };
    }
    return { status: 503, credential: null, source: "none", canonical_ms: Date.now() - canonicalStartedAt };
  }
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Entry>;
  const credential = entry.credential as Partial<ModelCredentialValue> | undefined;
  return Number.isSafeInteger(entry.epoch) && typeof entry.expiresAt === "number"
    && !!credential && (credential.kind === "openai" || credential.kind === "chatgpt")
    && typeof credential.secret === "string" && credential.secret.length > 0
    && Number.isSafeInteger(credential.revision);
}

/**
 * Bound only to the managed Worker. It overlaps a region's cold canonical
 * fill with Session activation and reports an outcome only.
 */
export class SessionCredentialPrewarm extends WorkerEntrypoint<CredentialSnapshotEnv> {
  async prewarm(input: unknown): Promise<{ outcome: PrewarmOutcome }> {
    const owner = input && typeof input === "object" ? (input as { owner?: unknown }).owner : undefined;
    const region = input && typeof input === "object" ? (input as { region?: unknown }).region : undefined;
    if (typeof owner !== "string" || typeof region !== "string") return { outcome: "invalid" };
    const stub = snapshotStub(this.env, owner, region);
    if (!stub) return { outcome: this.env.USER_CREDENTIAL_SNAPSHOTS ? "invalid" : "unsupported" };
    try {
      return { outcome: await stub.prewarm(owner, region) };
    } catch {
      return { outcome: "unavailable" };
    }
  }
}
