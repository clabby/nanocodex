import type { HostedMachine } from "nanocodex-tools/hosted";

export type HandInventoryEntry = Readonly<{
  id: string;
  name: string;
  kind: "hand" | "vm";
  online: boolean | null;
  health: "connected" | "offline" | "unknown";
}>;
export type HandInventory = Readonly<{
  data: HandInventoryEntry[];
  // Preserve the released wire token; inventory now covers account Hands only.
  coverage: "known_account_and_workspace";
  complete: boolean;
}>;

export function inventoryEntry(machine: Pick<HostedMachine, "id" | "name" | "capabilities">,
  online: boolean | null): HandInventoryEntry {
  const vm = machine.capabilities.some(capability => capability === "vm" || capability === "virtual_machine")
    || machine.id.startsWith("vm:");
  return { id: machine.id, name: machine.name, kind: vm ? "vm" : "hand",
    online, health: online === true ? "connected" : online === false ? "offline" : "unknown" };
}

/** Prefer verified live presence, then uncertainty over a stale offline assertion. */
export function mergeInventory(sources: readonly (readonly HandInventoryEntry[])[], complete: boolean): HandInventory {
  const entries = new Map<string, HandInventoryEntry>();
  const rank = (entry: HandInventoryEntry) => entry.online === true ? 2 : entry.online === null ? 1 : 0;
  for (const source of sources) for (const entry of source) {
    const previous = entries.get(entry.id);
    if (!previous || rank(entry) > rank(previous)) entries.set(entry.id, entry);
  }
  return { data: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    coverage: "known_account_and_workspace", complete };
}

export const HAND_INVENTORY_DEADLINE_MS = 4_000;
