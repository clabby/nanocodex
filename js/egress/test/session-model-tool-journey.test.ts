import { exports } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Real workerd entrypoints: the test runtime's MANAGED_AGENT_OWNERSHIP binding
// always answers 503, so any Session ownership callback fails closed with
// agent_subject_unavailable. The private Session model entrypoint must reach
// live credential resolution for the asserted owner without it.
const modelEgress = (exports as unknown as { SessionModelEgress: Fetcher }).SessionModelEgress;
const owner = "session-model-tool-journey-owner";
const subject = `managed-session-v1_${"e".repeat(64)}`;

function search(headers: Record<string, string>, path = "/v1/search"): Request {
  return new Request(`https://nanocodex.internal${path}`, { method: "POST", headers: {
    authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL", "content-type": "application/json",
    "x-nanocodex-subject": subject, ...headers,
  }, body: JSON.stringify({ id: "journey", commands: { search_query: [{ q: "fixture" }] } }) });
}

describe("SessionModelEgress managed tool journey", () => {
  it("search and image calls skip the Session callback that fails on the general broker", async () => {
    const generic = await SELF.fetch(search({}));
    expect(generic.status).toBe(503);
    expect(await generic.json()).toMatchObject({ error: "agent_subject_unavailable" });
    // A caller-supplied model owner assertion is never honored by the general broker.
    expect((await SELF.fetch(search({ "x-nanocodex-session-model-owner": owner }))).status).toBe(403);
    for (const path of ["/v1/search", "/v1/images/generations", "/v1/images/edits"]) {
      const response = await modelEgress.fetch(search({ "x-nanocodex-session-model-owner": owner }, path));
      const text = await response.text();
      // This owner has no model credential, so live credential resolution
      // (not the ownership callback) decides the outcome.
      expect(text, path).not.toContain("agent_subject_unavailable");
      expect(text, path).not.toContain("invalid_session_model_authority");
      expect(response.status, `${path} ${text}`).toBe(409);
      expect(JSON.parse(text), path).toMatchObject({ error: "user_credential_unavailable" });
    }
  });
});
