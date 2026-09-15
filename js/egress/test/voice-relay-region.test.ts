import { describe, expect, it, vi } from "vitest";
import { handleEgress, handleManagedRealtimeCall, type EgressEnv } from "../src/egress";

function fixture(region?: string) {
  const relay = vi.fn(async (_request: Request) => new Response("v=0\r\n", { status: 201 }));
  const get = vi.fn(() => ({ fetch: relay }));
  const idFromName = vi.fn((name: string) => name);
  const credential = { kind: "chatgpt", revision: 1, secret: "private-test-token", accountId: "test-account" };
  const env = {
    AGENT_SUBJECTS: { getByName: () => ({ fetch: async () => Response.json({ user_id: "test-user" }) }) },
    USER_CREDENTIALS: { getByName: () => ({ resolveModelCredential: async () => ({ status: 200, credential }) }) },
    CHATGPT_EGRESS: { idFromName, get },
  } as unknown as EgressEnv;
  const request = new Request("https://nanocodex.internal/v1/realtime/calls", {
    method: "POST",
    headers: {
      authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
      "x-nanocodex-subject": "a".repeat(64), "content-type": "application/json",
      "openai-alpha": "quicksilver=v2", "session-id": "test-session",
      "thread-id": "test-session", "x-session-id": "test-session",
      ...(region === undefined ? {} : { "x-nanocodex-voice-region": region }),
    },
    body: '{"sdp":"v=0"}',
  });
  return { env, request, relay, get, idFromName };
}

describe("regional subscription voice relay", () => {
  it.each(["wnam", "enam", "weur", "eeur", "apac", "oc", "sam"])(
    "uses an isolated per-user %s relay without forwarding the placement header", async (region) => {
      const f = fixture(region);
      expect((await handleEgress(f.request, f.env)).status).toBe(201);
      expect(f.idFromName).toHaveBeenCalledWith(`voice-v1:${region}:test-user`);
      expect(f.get).toHaveBeenCalledWith(`voice-v1:${region}:test-user`, { locationHint: region });
      expect(f.relay.mock.calls[0]![0].headers.has("x-nanocodex-voice-region")).toBe(false);
      expect(f.relay.mock.calls[0]![0].headers.get("authorization")).toBe("Bearer private-test-token");
    },
  );
  it.each([undefined, "invalid", "wnam,enam"])("retains the existing relay for an absent/invalid hint (%s)", async (region) => {
    const f = fixture(region);
    expect((await handleEgress(f.request, f.env)).status).toBe(201);
    expect(f.idFromName).toHaveBeenCalledWith("user-v1:test-user");
  });
  it("still denies unavailable ownership before starting a regional relay", async () => {
    const f = fixture("wnam");
    f.env.AGENT_SUBJECTS = { getByName: () => ({ fetch: async () => new Response(null, { status: 404 }) }) } as unknown as EgressEnv["AGENT_SUBJECTS"];
    expect((await handleEgress(f.request, f.env)).status).toBe(403);
    expect(f.get).not.toHaveBeenCalled();
  });
});

describe("private managed voice ownership capability", () => {
  const subject = `managed-session-v1_${"a".repeat(64)}`;
  const owner = "11111111-1111-4111-8111-111111111111";
  it("uses the ingress's verified owner only on the dedicated private call entrypoint", async () => {
    const f = fixture("wnam");
    f.request.headers.set("x-nanocodex-subject", subject);
    f.request.headers.set("x-nanocodex-realtime-owner", owner);
    const credentials = vi.fn(async () => ({ status: 200, credential: {
      kind: "chatgpt", revision: 1, secret: "private-test-token", accountId: "test-account" },
    }));
    const getByName = vi.fn(() => ({ resolveModelCredential: credentials }));
    f.env.USER_CREDENTIALS = { getByName } as unknown as EgressEnv["USER_CREDENTIALS"];
    expect((await handleManagedRealtimeCall(f.request, f.env)).status).toBe(201);
    expect(getByName).toHaveBeenCalledWith(owner);
    expect(f.relay.mock.calls[0]![0].headers.has("x-nanocodex-realtime-owner")).toBe(false);
  });
  it("does not trust the same owner header on generic agent egress", async () => {
    const f = fixture("wnam");
    f.request.headers.set("x-nanocodex-subject", subject);
    f.request.headers.set("x-nanocodex-realtime-owner", owner);
    f.env.MANAGED_AGENT_OWNERSHIP = {
      fetch: async () => new Response(null, { status: 404 }),
    } as unknown as Fetcher;
    expect((await handleEgress(f.request, f.env)).status).toBe(403);
    expect(f.relay).not.toHaveBeenCalled();
  });
  it.each(["owner", "subject", "path", "placeholder"])("rejects invalid %s before touching a relay", async (invalid) => {
    const f = fixture("wnam");
    f.request.headers.set("x-nanocodex-subject", subject);
    f.request.headers.set("x-nanocodex-realtime-owner", owner);
    if (invalid === "owner") f.request.headers.set("x-nanocodex-realtime-owner", "arbitrary-user");
    if (invalid === "subject") f.request.headers.set("x-nanocodex-subject", "a".repeat(64));
    if (invalid === "placeholder") f.request.headers.set("authorization", "Bearer untrusted");
    const request = invalid === "path" ? new Request("https://nanocodex.internal/v1/responses", f.request) : f.request;
    expect((await handleManagedRealtimeCall(request, f.env)).status).toBe(403);
    expect(f.relay).not.toHaveBeenCalled();
  });
});
