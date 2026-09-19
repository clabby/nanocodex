import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type DurableAgentSession } from "../src/index";
import { parseCompleteAgentSettings } from "../src/agent-settings";
import { parseConfiguration } from "../src/agent-configuration";
import { resolveThreadRoute, routingPolicySchema } from "../src/thread-model-routing";
import type { Principal } from "../src/account-auth";

const glm = { model: "@cf/zai-org/glm-5.3", thinking: "medium", reasoning_mode: "standard", fast_mode: false } as const;
const principal: Principal = {
  kind: "api_key", userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "owner", subjectId: "user:routing-fixture", credentialId: "routing-test",
  authorizationEpoch: 1, capabilities: ["agents:read", "agents:write", "tools:use"],
};
const sessions = () => (env as unknown as { NANOCODEX_SESSIONS: DurableObjectNamespace<DurableAgentSession> }).NANOCODEX_SESSIONS;
const request = (path: string, method: string, body?: unknown) => new Request(`https://session.internal${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});
async function fixture(run: (instance: DurableAgentSession, state: DurableObjectState) => Promise<void>) {
  await runInDurableObject(sessions().getByName(crypto.randomUUID()), async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO session_state
      (singleton,session_id,owner_id,organization_id,team_id,authorization_epoch,public_origin,runtime_profile,last_active)
      VALUES (1,?,?,?,?,1,'https://nanocodex.example','managed',?)`,
    "0198d3f0-8844-7000-8000-000000000092", principal.userId, principal.organizationId, principal.teamId, Date.now());
    await run(instance, state);
  });
}

describe("managed routing admission", () => {
  it.each([
    { settings: glm },
    { configuration: { settings: glm } },
  ])("rejects direct GLM HTTP creation before creating an agent: %j", async body => {
    const response = await worker.fetch(new Request("https://nanocodex.example/v1/agents", {
      method: "POST", body: JSON.stringify(body),
    }), env as Parameters<typeof worker.fetch>[1], createExecutionContext(), principal);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request", message: expect.stringContaining("only through model_routing") });
  });

  it("preserves persisted GLM settings while rejecting direct settings mutations atomically", () => fixture(async (instance, state) => {
    expect(parseCompleteAgentSettings(glm)).toEqual(glm);
    const before = state.storage.sql.exec("SELECT * FROM managed_agent_settings").one();
    const response = await instance.fetch(request("/settings", "PATCH", glm));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request", message: expect.stringContaining("only through model_routing") });
    expect(state.storage.sql.exec("SELECT * FROM managed_agent_settings").one()).toEqual(before);
    expect(state.storage.sql.exec("SELECT * FROM managed_thread_route").toArray()).toEqual([]);
  }));

  it.each([false, true])("locks routed settings and portability (route already pinned: %s)", pinned => fixture(async (instance, state) => {
    state.storage.sql.exec("INSERT INTO managed_configuration VALUES (1, ?)", JSON.stringify(parseConfiguration({ model_routing: {} })));
    if (pinned) {
      const route = await resolveThreadRoute({ run: async () => ({ answers: { family: { choice: "terminal", confidence: .99 } } }) }, "Fix build", routingPolicySchema.parse({}));
      state.storage.sql.exec("INSERT INTO managed_thread_route VALUES (1, ?)", JSON.stringify(route));
      state.storage.sql.exec("UPDATE managed_agent_settings SET model = ?, thinking = ?, reasoning_mode = 'standard', fast_mode = 0", route.model, route.thinking);
    }
    const settings = state.storage.sql.exec("SELECT * FROM managed_agent_settings").one();
    const route = state.storage.sql.exec("SELECT * FROM managed_thread_route").toArray();
    for (const patch of [{ model: "gpt-5.6-sol" }, { thinking: "low" }]) {
      const response = await instance.fetch(request("/settings", "PATCH", patch));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "settings_locked" });
    }
    for (const operation of ["export", "import"]) {
      const response = await instance.fetch(request(`/durability/${operation}`, "POST", {}));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "routed_session_not_portable" });
    }
    expect(state.storage.sql.exec("SELECT * FROM managed_agent_settings").one()).toEqual(settings);
    expect(state.storage.sql.exec("SELECT * FROM managed_thread_route").toArray()).toEqual(route);
    // Export rejection must not fence the session as exported.
    const stillLocked = await instance.fetch(request("/settings", "PATCH", { thinking: "high" }));
    expect(await stillLocked.json()).toMatchObject({ error: "settings_locked" });
  }));
});
