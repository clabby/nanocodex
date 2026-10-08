// The agent chat workspace is the heaviest route module. Load it on demand and
// warm it on navigation intent so the homepage entry never pays for it.
let agentExperienceModule: Promise<typeof import("./AgentExperience")> | undefined;
export function loadAgentExperience(): Promise<typeof import("./AgentExperience")> {
  agentExperienceModule ??= import("./AgentExperience").catch((error: unknown) => {
    agentExperienceModule = undefined;
    throw error;
  });
  return agentExperienceModule;
}

export function preloadAgentExperience(): void {
  void loadAgentExperience().catch(() => undefined);
}
