import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolveThreadRoute, routingPolicySchema, ThreadRoutePin, OSS_MODEL, FRONTIER_MODEL } from "../src/thread-model-routing";
import { initializeManagedAgentSettingsSchema } from "../src/agent-settings-schema";
import { parseAgentCreateBody, validateAgentSettings } from "../src/agent-settings";
import { parseConfiguration } from "../src/agent-configuration";

const policy = (patch = {}) => routingPolicySchema.parse(patch);
const jev = (family = "terminal", confidence = .98) => ({ run: vi.fn(async (_model: string, _input: unknown) => ({ answers: { family: { choice: family, confidence } }, usage: { input_tokens: 70 } })) });

describe("eval-informed thread routing", () => {
  it("uses Jev's typed classifier and pins actual OSS identity/effort", async () => {
    const ai = jev(); const route = await resolveThreadRoute(ai, "Fix my build", policy({ oss_thinking: "high" }));
    expect(ai.run.mock.calls[0][0]).toBe("typesafe/jev");
    expect(route).toMatchObject({ backend: "workers_ai", model: OSS_MODEL, thinking: "high", selection: "prior", estimate: null });
    expect(route.evidence.eval).toBe("Terminal-Bench 2.1");
  });
  it("does not claim published scores are local completion probabilities", async () => {
    const route = await resolveThreadRoute(jev("long_engineering"), "Add feature", policy());
    expect(route.evidence).toHaveProperty("oss_score", 66.9);
    expect(route.estimate).toBeNull();
    expect(route.selection).toBe("prior");
  });
  it.each(["other", "desktop", "science", "research", "mathematics"])("uses frontier for %s without comparable local measurements", async family => {
    expect((await resolveThreadRoute(jev(family), "task", policy())).model).toBe(FRONTIER_MODEL);
  });
  it("keeps low-confidence or invalid classifier output on explicit fallback", async () => {
    expect((await resolveThreadRoute(jev("terminal", .4), "task", policy())).selection).toBe("fallback");
    expect((await resolveThreadRoute(jev("made_up_eval"), "task", policy())).selection).toBe("fallback");
  });
  it("pins fallback on Jev error without exposing provider errors", async () => {
    const route = await resolveThreadRoute({ run: async () => { throw new Error("secret provider text"); } }, "task", policy());
    expect(route.model).toBe(FRONTIER_MODEL);
    expect(JSON.stringify(route)).not.toContain("secret provider text");
  });
  it("does not send binary modalities or oversized state to Jev", async () => {
    const ai = jev();
    const image = await resolveThreadRoute(ai, [{ type: "image", image_url: "data:image/png;base64,abc" }], policy());
    expect(image.backend).toBe("chatgpt");
    expect((await resolveThreadRoute(ai, "x".repeat(24001), policy())).selection).toBe("fallback");
    expect(ai.run).not.toHaveBeenCalled();
  });
  const estimates = [
    { family: "terminal", backend: "workers_ai", model: OSS_MODEL, thinking: "medium", success_rate: .5, expected_cost_usd: .1, expected_duration_ms: 5000, sample_size: 100, source: "heldout-v1" },
    { family: "terminal", backend: "chatgpt", model: FRONTIER_MODEL, thinking: "high", success_rate: .9, expected_cost_usd: .3, expected_duration_ms: 6000, sample_size: 100, source: "heldout-v1" },
  ];
  it("chooses amortized cost/success and duration/success using matched measurements", async () => {
    const cost = await resolveThreadRoute(jev(), "task", policy({ objective: "cost", estimates }));
    const time = await resolveThreadRoute(jev(), "task", policy({ objective: "time", estimates }));
    expect(cost.backend).toBe("workers_ai"); // .20 vs .333 USD/accepted completion
    expect(time.backend).toBe("chatgpt"); // 6.67 vs 10 sec/accepted completion
    expect(cost.selection).toBe("measured");
    expect((await resolveThreadRoute(jev(), "task", policy({ objective: "effectiveness", estimates }))).backend).toBe("chatgpt");
  });
  it("never restores a route excluded by the success threshold", async () => {
    const route = await resolveThreadRoute(jev(), "task", policy({ estimates, objective: "cost", min_success_rate: .8 }));
    expect(route.backend).toBe("chatgpt"); expect(route.selection).toBe("measured");
    await expect(resolveThreadRoute(jev(), "task", policy({ estimates, min_success_rate: .95 }))).rejects.toThrow("no route admitted");
    await expect(resolveThreadRoute(jev(), "task", policy({ min_success_rate: .8 }))).rejects.toThrow("no route admitted");
    expect(() => policy({ estimates: [...estimates, estimates[0]] })).toThrow();
  });
  it("supports configured ChatGPT model and refuses mixed measurement sources", async () => {
    expect((await resolveThreadRoute(jev("research"), "task", policy({ frontier_model: "gpt-5.6-sol", frontier_thinking: "low" }))).model).toBe("gpt-5.6-sol");
    const mixed = estimates.map((e, i) => ({ ...e, source: `dataset-${i}` }));
    expect((await resolveThreadRoute(jev(), "task", policy({ estimates: mixed }))).selection).toBe("prior");
  });
  it("does not use measurements from a different thinking level", async () => {
    const route = await resolveThreadRoute(jev(), "task", policy({ objective: "time", estimates, frontier_thinking: "low" }));
    expect(route.selection).toBe("prior");
    expect(route.estimate).toBeNull();
  });
  it("does not let estimates override modality or classification fallback", async () => {
    const route = await resolveThreadRoute(jev("terminal", .1), "task", policy({ estimates }));
    expect(route.backend).toBe("chatgpt"); expect(route.selection).toBe("fallback");
  });
  it("validates policy and incompatible creation settings", () => {
    expect(() => policy({ weights: { cost: 0, time: 0, effectiveness: 0 } })).toThrow();
    expect(() => policy({ estimates: [{ ...estimates[0], success_rate: 0 }] })).toThrow();
    expect(() => parseAgentCreateBody(JSON.stringify({ settings: {}, configuration: { model_routing: {} } }))).toThrow();
    expect(() => parseConfiguration({ model_routing: {}, multi_agent: { enabled: true } })).toThrow();
    expect(() => validateAgentSettings({ model: OSS_MODEL, thinking: "max", fast_mode: false, reasoning_mode: "standard" })).toThrow();
  });
  it("singleflights concurrent admissions and retains route across restart", async () => {
    let retained: Awaited<ReturnType<typeof resolveThreadRoute>> | undefined;
    const store = { read: () => retained, commit: (r: NonNullable<typeof retained>) => { retained = r; } };
    const pin = new ThreadRoutePin(store), ai = jev();
    const make = () => resolveThreadRoute(ai, "first task", policy());
    const [a, b] = await Promise.all([pin.resolve(make), pin.resolve(make)]);
    expect(a).toBe(b); expect(ai.run).toHaveBeenCalledTimes(1);
    const restarted = new ThreadRoutePin(store);
    expect(await restarted.resolve(() => { throw new Error("must not reroute"); })).toBe(a);
  });
  it("does not retain a route if atomic commit failed", async () => {
    const ai = jev(), commit = vi.fn(() => { throw new Error("storage failure"); });
    const pin = new ThreadRoutePin({ read: () => undefined, commit });
    await expect(pin.resolve(() => resolveThreadRoute(ai, "task", policy()))).rejects.toThrow("storage failure");
    expect(commit).toHaveBeenCalledOnce();
  });
  it("migrates an existing Astra settings table without changing its row", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE managed_agent_settings (singleton INTEGER PRIMARY KEY, model TEXT CHECK(model IN ('gpt-6-astra')), thinking TEXT, reasoning_mode TEXT, fast_mode INTEGER);
      INSERT INTO managed_agent_settings VALUES (1,'gpt-6-astra','high','standard',0);`);
    const storage = {
      sql: { exec(sql: string, ...args: unknown[]) {
        if (/^\s*(SELECT|PRAGMA)/.test(sql)) { const rows = db.prepare(sql).all(...args as never[]); return { one: () => rows[0], toArray: () => rows }; }
        db.exec(sql); return { toArray: () => [] };
      } },
      transactionSync(fn: () => void) { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } },
    };
    initializeManagedAgentSettingsSchema(storage as never);
    expect(db.prepare("SELECT model FROM managed_agent_settings").get()?.model).toBe(FRONTIER_MODEL);
    db.prepare("UPDATE managed_agent_settings SET model = ?").run(OSS_MODEL);
    initializeManagedAgentSettingsSchema(storage as never);
    expect(db.prepare("SELECT model FROM managed_agent_settings").get()?.model).toBe(OSS_MODEL);
    db.close();
  });
});


describe("live Unified Billing Jev envelopes", () => {
  it("reads completed wrapped answers and usage", async () => {
    const route = await resolveThreadRoute({run:async()=>({state:"Completed",result:{answers:{family:{choice:"terminal",confidence:.99}},usage:{input_tokens:333,output_tokens:38}},gatewayMetadata:{keySource:"Unified"}})}, "Fix build", policy());
    expect(route.backend).toBe("workers_ai");
    expect(route.confidence).toBe(.99);
    expect(route.router_usage).toEqual({input_tokens:333,output_tokens:38});
  });
  it.each(["Pending", "Failed"])("does not accept %s answers", async state => {
    const route = await resolveThreadRoute({run:async()=>({state,result:{answers:{family:{choice:"terminal",confidence:1}}}})}, "Fix build", policy());
    expect(route.selection).toBe("fallback"); expect(route.backend).toBe("chatgpt");
  });
});
