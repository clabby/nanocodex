import { describe, expect, it } from "vitest";
import { configuredProbeTargets, probeDailyLimit, PROBE_INTERVAL_MS, PROBE_SCHEDULE } from "../src/provider-probe-schedule";
import { automaticRoutingConfiguration } from "../src/automatic-routing";
import { parseConfiguration } from "../src/agent-configuration";

describe("deployment probe schedule", () => {
  it("covers every configured API model and effort without a global subscription identity", () => {
    const targets = configuredProbeTargets({ AI: { run: async () => ({}) }, OPENROUTER_API_KEY: "fixture-openrouter", AI_GATEWAY_API_KEY: "fixture-vercel" });
    expect(targets).toHaveLength(33);
    expect(new Set(targets.map(t => JSON.stringify([t.backend, t.model, t.effort]))).size).toBe(33);
    expect(targets.filter(t => t.backend === "workers_ai")).toHaveLength(3);
    expect(targets.filter(t => t.backend === "openrouter")).toHaveLength(15);
    expect(targets.filter(t => t.backend === "vercel")).toHaveLength(15);
    expect(configuredProbeTargets({})).toEqual([]);
    expect(configuredProbeTargets({ OPENROUTER_API_KEY: " " })).toEqual([]);
    expect(PROBE_SCHEDULE).toBe("*/30 * * * *");
    expect(24 * 60 * 60_000 / PROBE_INTERVAL_MS * targets.length).toBeLessThanOrEqual(probeDailyLimit({}));
  });
  it.each(["0", "-1", "4097", "NaN", "1.2", ""])("invalid request budget %s disables spend", limit => {
    expect(probeDailyLimit({ NANOCODEX_PROVIDER_PROBE_DAILY_LIMIT: limit })).toBe(0);
  });
});

describe("automatic routing admission", () => {
  const admitted = { enabled: true, fullAccountAuthority: true, settingsProvided: false, importing: false };
  it("defaults new full-account agents to all configured candidates and preserves tool policy", () => {
    const configured = automaticRoutingConfiguration(parseConfiguration({ tools: ["exec_command"] }), admitted);
    expect(configured.model_routing?.strategy).toBe("direct");
    expect(configured.model_routing?.candidates).toBeUndefined();
    expect(configured.tools).toEqual(["exec_command"]);
  });
  it.each([{ enabled: false }, { fullAccountAuthority: false }, { settingsProvided: true }, { importing: true }])("preserves intentional non-routed admission %j", override => {
    const config = parseConfiguration({});
    expect(automaticRoutingConfiguration(config, { ...admitted, ...override })).toBe(config);
  });
  it("preserves explicit settings and existing policies", () => {
    for (const config of [parseConfiguration({ settings: { model: "gpt-5.6-sol", thinking: "low", reasoning_mode: "standard", fast_mode: false } }), parseConfiguration({ model_routing: { candidates: ["@cf/zai-org/glm-5.3:low"] } })]) {
      expect(automaticRoutingConfiguration(config, admitted)).toBe(config);
    }
  });
});
