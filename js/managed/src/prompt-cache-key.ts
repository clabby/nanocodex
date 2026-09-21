import { createHash } from "node:crypto";

/** Reuse one owner's prefix across agents without sharing cache accounting across teams or owners. */
export function managedPromptCacheKey(session: {
  organization_id: string;
  team_id: string;
  owner_id: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "nanocodex-managed-v1", session.organization_id, session.team_id, session.owner_id,
  ])).digest("hex");
}
