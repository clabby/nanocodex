import { describe, expect, it } from "vitest";
import { managedPromptCacheKey } from "../src/prompt-cache-key";

describe("managed prompt cache accounting", () => {
  it("reuses an owner's key across agents and isolates organizations, teams, and owners", () => {
    const owner = { organization_id: "org-a", team_id: "team-a", owner_id: "owner-a" };
    const first = { ...owner, session_id: "agent-a" };
    const second = { ...owner, session_id: "agent-b" };
    const key = managedPromptCacheKey(first);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(managedPromptCacheKey(second)).toBe(key);
    for (const field of ["organization_id", "team_id", "owner_id"] as const) {
      expect(managedPromptCacheKey({ ...owner, [field]: "different" })).not.toBe(key);
    }
  });
});
