import { namespaceMountRoot } from "nanocodex-tools";

type Machine = Readonly<{ id: string; name: string }>;

/**
 * Every identity the authoritative registry still knows, including offline
 * and unknown-presence Hands. Only an owner deletion removes an identity.
 * `observedAt` is the registry's read time; rows assigned here from a newer
 * view are never reclaimed by an older one.
 */
export type HandRegistry = Readonly<{ ids: ReadonlySet<string>; observedAt: number }>;

export type HandRootOptions = Readonly<{
  /** Canonical roots chosen by the account; agents follow them when free. */
  preferred?: ReadonlyMap<string, string>;
  /** Account-retained historical roots, offered only when unambiguous here. */
  inheritedAliases?: ReadonlyMap<string, readonly string[]>;
  registry?: HandRegistry;
}>;

export type HandRootAssignment = Readonly<{
  roots: ReadonlyMap<string, string>;
  /** Historical roots of the same identity, never another device's. */
  aliases: ReadonlyMap<string, readonly string[]>;
}>;

/**
 * Labels choose a path once; durable machine identities continue to own it.
 * A suffixed path moves to its canonical root only after that root is released
 * by an authoritative registry deletion, and its previous path stays reserved
 * as an alias of the same identity.
 */
export class HandPaths {
  /** Registry time of rows written by this instance; durable rows predate every new view. */
  readonly #assignedAt = new Map<string, number>();

  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS managed_hand_paths (
      machine_id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE
    ); CREATE TABLE IF NOT EXISTS managed_hand_path_aliases (
      root TEXT PRIMARY KEY, machine_id TEXT NOT NULL
    )`);
  }

  /** Every namespace root held by a Hand identity, including historical aliases. */
  roots(): readonly string[] {
    return this.storage.sql.exec<{ root: string }>(
      "SELECT root FROM managed_hand_paths UNION SELECT root FROM managed_hand_path_aliases").toArray().map(row => row.root);
  }

  /** Owner-confirmed deletion of one identity releases all of its roots. */
  forget(machineId: string): void {
    this.storage.sql.exec("DELETE FROM managed_hand_paths WHERE machine_id=?", machineId);
    this.storage.sql.exec("DELETE FROM managed_hand_path_aliases WHERE machine_id=?", machineId);
    this.#assignedAt.delete(machineId);
  }

  assign(machines: readonly Machine[], reserved: readonly string[] = [], preferred?: ReadonlyMap<string, string>,
    registry?: HandRegistry): ReadonlyMap<string, string> {
    return this.resolve(machines, reserved, { preferred, registry }).roots;
  }

  resolve(machines: readonly Machine[], reserved: readonly string[] = [], options: HandRootOptions = {}): HandRootAssignment {
    return this.storage.transactionSync(() => this.#resolve(machines, reserved, options));
  }

  #resolve(machines: readonly Machine[], reserved: readonly string[], options: HandRootOptions): HandRootAssignment {
    if (options.registry) this.#reclaim(options.registry);
    // Rows assigned without a complete view are never reclaimed by this instance.
    const at = options.registry?.observedAt ?? Number.POSITIVE_INFINITY;
    const primary = new Map(this.storage.sql.exec<{ machine_id: string; root: string }>(
      "SELECT machine_id, root FROM managed_hand_paths").toArray().map(row => [row.machine_id, row.root]));
    const aliasOwners = new Map(this.storage.sql.exec<{ machine_id: string; root: string }>(
      "SELECT machine_id, root FROM managed_hand_path_aliases").toArray().map(row => [row.root, row.machine_id]));
    const owners = new Map([...primary].map(([id, root]) => [root, id]));
    const blocked = new Set([...reserved, "/brain"]);
    const valid = (root: string) => root.startsWith("/") && namespaceMountRoot(root.slice(1)) === root && root !== "/brain";
    const preferredRoots = new Map([...options.preferred ?? []].filter(([, root]) => valid(root)));
    const preferredOwners = new Map([...preferredRoots].map(([id, root]) => [root, id]));
    const inheritedOwners = new Map<string, string>();
    for (const [id, roots] of options.inheritedAliases ?? []) for (const root of roots) {
      // Two identities claiming one alias leave it unusable for both.
      if (valid(root)) inheritedOwners.set(root, inheritedOwners.has(root) && inheritedOwners.get(root) !== id ? "" : id);
    }
    const legacy = new Map(machines.map(machine => [namespaceMountRoot(machine.id), machine.id]));
    const ownedBy = (root: string, id: string) => !blocked.has(root)
      && (owners.get(root) ?? id) === id && (aliasOwners.get(root) ?? id) === id
      && (legacy.get(root) ?? id) === id && (preferredOwners.get(root) ?? id) === id && (inheritedOwners.get(root) ?? id) === id;
    for (const machine of [...machines].sort((a, b) => a.id.localeCompare(b.id))) {
      const current = primary.get(machine.id);
      if (current !== undefined) {
        const stem = readableHandRoot(machine.name);
        const target = preferredRoots.get(machine.id) ?? (collisionOf(stem, current) ? stem : undefined);
        if (target === undefined || target === current || !ownedBy(target, machine.id)) continue;
        // The previous path stays with this identity; captured cells keep their own bindings.
        this.storage.sql.exec("DELETE FROM managed_hand_path_aliases WHERE root=?", target);
        this.storage.sql.exec("INSERT INTO managed_hand_path_aliases(root, machine_id) VALUES (?, ?) ON CONFLICT(root) DO NOTHING",
          current, machine.id);
        this.storage.sql.exec("UPDATE managed_hand_paths SET root=? WHERE machine_id=?", target, machine.id);
        aliasOwners.delete(target);
        aliasOwners.set(current, machine.id);
        owners.delete(current);
        owners.set(target, machine.id);
        primary.set(machine.id, target);
        this.#assignedAt.set(machine.id, Math.max(this.#assignedAt.get(machine.id) ?? at, at));
        continue;
      }
      const canonical = preferredRoots.get(machine.id);
      const stem = canonical && ownedBy(canonical, machine.id) ? canonical : readableHandRoot(machine.name);
      let root = stem;
      let suffix = 2;
      while (!ownedBy(root, machine.id)) root = collisionRoot(stem, suffix++);
      this.storage.sql.exec("INSERT INTO managed_hand_paths(machine_id, root) VALUES (?, ?)", machine.id, root);
      primary.set(machine.id, root);
      owners.set(root, machine.id);
      this.#assignedAt.set(machine.id, at);
    }
    const aliases = new Map<string, string[]>();
    for (const [root, id] of aliasOwners) if (primary.has(id) && !blocked.has(root)) aliases.set(id, [...aliases.get(id) ?? [], root]);
    for (const [root, id] of inheritedOwners) {
      if (!id || !primary.has(id) || primary.get(id) === root || !ownedBy(root, id) || aliases.get(id)?.includes(root)) continue;
      aliases.set(id, [...aliases.get(id) ?? [], root]);
    }
    return { roots: primary, aliases };
  }

  #reclaim(registry: HandRegistry): void {
    const ids = new Set([
      ...this.storage.sql.exec<{ machine_id: string }>("SELECT machine_id FROM managed_hand_paths").toArray(),
      ...this.storage.sql.exec<{ machine_id: string }>("SELECT machine_id FROM managed_hand_path_aliases").toArray(),
    ].map(row => row.machine_id));
    for (const id of ids) {
      if (registry.ids.has(id) || (this.#assignedAt.get(id) ?? Number.NEGATIVE_INFINITY) > registry.observedAt) continue;
      this.forget(id);
    }
  }
}

function collisionRoot(stem: string, suffix: number): string {
  const tail = `-${suffix}`;
  return `${stem.slice(0, 64 - tail.length).replace(/[._-]+$/, "")}${tail}`;
}

/** Whether `root` is a numbered fallback chosen because `stem` was taken. */
function collisionOf(stem: string, root: string): boolean {
  const suffix = /-([1-9][0-9]*)$/.exec(root)?.[1];
  return suffix !== undefined && Number(suffix) >= 2 && collisionRoot(stem, Number(suffix)) === root;
}

export function readableHandRoot(name: string): string {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 58).replace(/[._-]+$/, "") || "hand";
  // Existing namespace validation owns reserved and Windows device names.
  return namespaceMountRoot(slug) === `/${slug}` ? `/${slug}` : `/hand-${slug}`;
}
