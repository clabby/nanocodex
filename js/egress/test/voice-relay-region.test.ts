import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleEgress, handleManagedRealtimeCall, ManagedRealtimeEgress, type EgressEnv } from "../src/egress";

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
  it.each(["0", "1"])("keeps sampled transport stable for voice session ending %s", async (last) => {
    const f = fixture("wnam");
    f.env.CHATGPT_VOICE_RELAY_RPC = "sample";
    f.request.headers.set("x-session-id", `11111111-1111-4111-8111-11111111111${last}`);
    const createRealtimeCall = vi.fn(async () => ({ status: 201, headers: {}, body: "answer SDP" }));
    f.get.mockReturnValue({ fetch: f.relay, createRealtimeCall } as ReturnType<typeof f.get>);
    expect((await handleEgress(f.request, f.env)).status).toBe(201);
    expect(createRealtimeCall).toHaveBeenCalledTimes(last === "0" ? 1 : 0);
    expect(f.relay).toHaveBeenCalledTimes(last === "0" ? 0 : 1);
  });
  it("transfers the complete SDP exchange through the private relay RPC when enabled", async () => {
    const f = fixture("wnam");
    f.env.CHATGPT_VOICE_RELAY_RPC = "true";
    const createRealtimeCall = vi.fn(async (_body: string, _headers: Record<string, string>) => ({
      status: 201, headers: { "content-type": "application/sdp", location: "/calls/fixture" }, body: "answer SDP",
    }));
    f.get.mockReturnValue({ fetch: f.relay, createRealtimeCall } as ReturnType<typeof f.get>);
    const response = await handleEgress(f.request, f.env);
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/calls/fixture");
    expect(await response.text()).toBe("answer SDP");
    expect(createRealtimeCall).toHaveBeenCalledTimes(1);
    expect(createRealtimeCall.mock.calls[0]![0]).toBe('{"sdp":"v=0"}');
    expect(createRealtimeCall.mock.calls[0]![1].authorization).toBe("Bearer private-test-token");
    expect(createRealtimeCall.mock.calls[0]![1]["x-nanocodex-voice-region"]).toBeUndefined();
    expect(f.relay).not.toHaveBeenCalled();
  });
  it("does not create a second provider call after a relay RPC failure", async () => {
    const f = fixture("wnam");
    f.env.CHATGPT_VOICE_RELAY_RPC = "true";
    const createRealtimeCall = vi.fn(async () => { throw new Error("RPC interrupted after provider accepted call"); });
    f.get.mockReturnValue({ fetch: f.relay, createRealtimeCall } as ReturnType<typeof f.get>);
    expect((await handleEgress(f.request, f.env)).status).toBe(502);
    expect(createRealtimeCall).toHaveBeenCalledTimes(1);
    expect(f.relay).not.toHaveBeenCalled();
  });
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
  it("returns complete SDP through private RPC and retains credential/ownership policy", async () => {
    const f = fixture("wnam");
    f.request.headers.set("x-nanocodex-subject", subject);
    f.request.headers.set("x-nanocodex-realtime-owner", owner);
    const entrypoint = new ManagedRealtimeEgress(createExecutionContext(), f.env);
    const reply = await entrypoint.createCall(await f.request.text(), Object.fromEntries(f.request.headers));
    expect(reply.status).toBe(201);
    expect(reply.body).toBe("v=0\r\n");
    expect(JSON.stringify(reply)).not.toContain("private-test-token");
    const denied = await entrypoint.createCall("{}", {});
    expect(denied.status).toBe(403);
    expect(f.relay).toHaveBeenCalledTimes(1);
  });
  it.each([subject, "a".repeat(64)])("uses the ingress's verified owner without a directory lookup for %s", async (subject) => {
    const f = fixture("wnam");
    f.request.headers.set("x-nanocodex-subject", subject);
    f.request.headers.set("x-nanocodex-realtime-owner", owner);
    const directory = vi.fn(async () => { throw new Error("directory must not be read"); });
    f.env.AGENT_SUBJECTS = { getByName: directory } as unknown as EgressEnv["AGENT_SUBJECTS"];
    const credentials = vi.fn(async () => ({ status: 200, credential: {
      kind: "chatgpt", revision: 1, secret: "private-test-token", accountId: "test-account" },
    }));
    const getByName = vi.fn(() => ({ resolveModelCredential: credentials }));
    f.env.USER_CREDENTIALS = { getByName } as unknown as EgressEnv["USER_CREDENTIALS"];
    expect((await handleManagedRealtimeCall(f.request, f.env)).status).toBe(201);
    expect(getByName).toHaveBeenCalledWith(owner);
    expect(directory).not.toHaveBeenCalled();
    expect(f.relay.mock.calls[0]![0].headers.has("x-nanocodex-realtime-owner")).toBe(false);
  });
  it.each([subject, "a".repeat(64)])("does not trust the owner header on generic agent egress for %s", async (subject) => {
    const f = fixture("wnam");
    f.request.headers.set("x-nanocodex-subject", subject);
    f.request.headers.set("x-nanocodex-realtime-owner", owner);
    f.env.MANAGED_AGENT_OWNERSHIP = {
      fetch: async () => new Response(null, { status: 404 }),
    } as unknown as Fetcher;
    f.env.AGENT_SUBJECTS = { getByName: () => ({ fetch: async () => new Response(null, { status: 404 }) }) } as unknown as EgressEnv["AGENT_SUBJECTS"];
    expect((await handleEgress(f.request, f.env)).status).toBe(403);
    expect(f.relay).not.toHaveBeenCalled();
  });
  it.each(["owner", "subject", "path", "placeholder"])("rejects invalid %s before touching a relay", async (invalid) => {
    const f = fixture("wnam");
    f.request.headers.set("x-nanocodex-subject", subject);
    f.request.headers.set("x-nanocodex-realtime-owner", owner);
    if (invalid === "owner") f.request.headers.set("x-nanocodex-realtime-owner", "arbitrary-user");
    if (invalid === "subject") f.request.headers.set("x-nanocodex-subject", "a".repeat(63));
    if (invalid === "placeholder") f.request.headers.set("authorization", "Bearer untrusted");
    const request = invalid === "path" ? new Request("https://nanocodex.internal/v1/responses", f.request) : f.request;
    expect((await handleManagedRealtimeCall(request, f.env)).status).toBe(403);
    expect(f.relay).not.toHaveBeenCalled();
  });
});
