import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleEgress, SessionModelEgress, type EgressEnv } from "../src/egress";

const owner = "11111111-1111-4111-8111-111111111111";
const subject = `managed-session-v1_${"a".repeat(64)}`;
const ownerHeader = "x-nanocodex-session-model-owner";
function request() {
  return new Request("https://nanocodex.internal/v1/responses", { headers: {
    [ownerHeader]: owner, "x-nanocodex-subject": subject,
    authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL", upgrade: "websocket",
    "openai-beta": "responses_websockets=2026-02-06",
  } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Session-only model egress", () => {
  it("uses the private binding's live Session assertion without a callback and still reads current credentials", async () => {
    const lookup = vi.fn(async () => ({ status: 200, resolve_ms: 3, credential: { kind: "openai", revision: 1, secret: "fixture-provider-secret" } }));
    const getByName = vi.fn(() => ({ resolveModelCredential: lookup }));
    const callback = vi.fn(async () => { throw new Error("unexpected ownership callback"); });
    const upstream = vi.fn(async (input: Request) => {
      expect(input.url).toBe("https://api.openai.com/v1/responses");
      expect(input.headers.has(ownerHeader)).toBe(false);
      expect(input.headers.has("x-nanocodex-subject")).toBe(false);
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", upstream);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const env = { USER_CREDENTIALS: { getByName }, MANAGED_AGENT_OWNERSHIP: { fetch: callback } } as unknown as EgressEnv;
    const entrypoint = new SessionModelEgress(createExecutionContext(), env);
    for (let i = 0; i < 2; i++) expect((await entrypoint.fetch(request())).status).toBe(200);
    expect(getByName).toHaveBeenCalledWith(owner);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(callback).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-provider-secret");
    expect(log.mock.calls[0]?.[0]).toMatchObject({ credential_kind: "openai", subject_ms: expect.any(Number), credential_ms: expect.any(Number), credential_broker_ms: 3, upstream_ms: expect.any(Number) });
  });

  it("never accepts the owner header through the general broker", async () => {
    const response = await handleEgress(request(), {} as EgressEnv);
    expect(response.status).toBe(403);
  });

  it("rejects non-model destinations, malformed subjects, missing owners, and missing protocol headers", async () => {
    const entrypoint = new SessionModelEgress(createExecutionContext(), {} as EgressEnv);
    for (const url of ["https://broker.internal/users/other/credentials", "https://nanocodex.internal/v1/search", "https://nanocodex.internal/v1/responses?other=1", "https://example.com/v1/responses"]) {
      expect((await entrypoint.fetch(new Request(url, request()))).status).toBe(403);
    }
    for (const header of [ownerHeader, "x-nanocodex-subject", "authorization", "upgrade", "openai-beta"]) {
      const input = request(); input.headers.delete(header);
      expect((await entrypoint.fetch(input)).status).toBe(403);
    }
    for (const [header, value] of [[ownerHeader, "not a user"], ["x-nanocodex-subject", "b".repeat(64)]]) {
      const input = request(); input.headers.set(header!, value!);
      expect((await entrypoint.fetch(input)).status).toBe(403);
    }
  });
});
