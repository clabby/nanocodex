import { parseConfiguration, type AgentConfiguration } from "./agent-configuration";

/** Defaults apply at new admission only. Explicit models, imports, constrained
 * Connect grants and retained sessions keep their existing semantics. */
export function automaticRoutingConfiguration(configuration: AgentConfiguration, context: {
  enabled: boolean; fullAccountAuthority: boolean; settingsProvided: boolean; importing: boolean;
}): AgentConfiguration {
  if (!context.enabled || !context.fullAccountAuthority || context.settingsProvided || context.importing
    || configuration.settings || configuration.model_routing) return configuration;
  return parseConfiguration({ ...configuration, model_routing: {} });
}
