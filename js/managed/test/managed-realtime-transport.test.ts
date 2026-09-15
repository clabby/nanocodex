import { describe, expect, it, vi } from "vitest";
import { validRealtimeSession, voiceRelayRegion, routeManagedRealtimeTransport } from "../src/managed-realtime-transport";

const session = () => ({
  model: "gpt-live-1-codex", instructions: "Use the user's ChatGPT subscription.",
  audio: { output: { voice: "maple" } }, delegation: { type: "client" },
});

describe("ChatGPT subscription voice call boundary", () => {
  it("accepts the Codex acknowledgement option and preserves provider defaults", () => {
    expect(validRealtimeSession(session())).toBe(true);
    for (const ack_filler of [true, false]) {
      expect(validRealtimeSession({ ...session(), delegation: { type: "client", ack_filler } })).toBe(true);
    }
  });
  it("accepts full instructions beyond the former 32 KiB cutoff", () => {
    expect(validRealtimeSession({ ...session(), instructions: "x".repeat(96 * 1024) })).toBe(true);
  });
  it("rejects malformed acknowledgements and arbitrary provider fields", () => {
    for (const ack_filler of [null, "false", 0, {}, []]) {
      expect(validRealtimeSession({ ...session(), delegation: { type: "client", ack_filler } })).toBe(false);
    }
    expect(validRealtimeSession({ ...session(), delegation: { type: "server", ack_filler: true } })).toBe(false);
    expect(validRealtimeSession({ ...session(), delegation: { type: "client", ack_filler: true, instructions: "override" } })).toBe(false);
  });
  it("rejects Platform audio options, custom voices, and other models", () => {
    expect(validRealtimeSession({ ...session(), audio: { input: { turn_detection: { type: "semantic_vad" } }, output: { voice: "maple" } } })).toBe(false);
    expect(validRealtimeSession({ ...session(), audio: { output: { voice: "maple", speed: 1.5 } } })).toBe(false);
    for (const voice of ["alloy", "voice_custom", { id: "voice_custom" }]) {
      expect(validRealtimeSession({ ...session(), audio: { output: { voice } } })).toBe(false);
    }
    expect(validRealtimeSession({ ...session(), model: "gpt-realtime" })).toBe(false);
  });
});


describe("voice relay geography", () => {
  it.each([
    ["NA", "-122.4", "wnam"], ["NA", "-74", "enam"],
    ["EU", "2.3", "weur"], ["EU", "23.7", "eeur"],
    ["AS", "139", "apac"], ["SA", "-46", "sam"], ["OC", "151", "oc"],
    ["AF", "30", undefined], ["NA", "", undefined], ["EU", "bad", undefined],
  ])("uses trusted %s/%s metadata", (continent, longitude, expected) => {
    expect(voiceRelayRegion({ cf: { continent, longitude } } as Request)).toBe(expected);
  });
  it("does not accept a caller's placement header without Cloudflare metadata", () => {
    expect(voiceRelayRegion(new Request("https://test.example", {
      headers: { "x-nanocodex-voice-region": "wnam", "cf-ipcontinent": "NA" },
    }))).toBeUndefined();
  });
});

describe("private voice egress admission", () => {
  async function fixture(owned: boolean, privateBinding = true) {
    const owner = "11111111-1111-4111-8111-111111111111";
    const id = "a".repeat(64);
    const token = `ncx_live_${"k".repeat(12)}_${"s".repeat(43)}`;
    const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(token),
    )))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const relay = vi.fn(async (_request: Request) => new Response("v=0", { status: 201 }));
    const generic = vi.fn(async (_request: Request) => new Response("v=0", { status: 201 }));
    const ownership = vi.fn(async (_url: string, _init: RequestInit) => owned
      ? Response.json({ subject: `managed-session-v1_${id}`, strategy: "session_v1" })
      : new Response(null, { status: 404 }));
    const env = {
      NANOCODEX_API_KEYS: { getByName: () => ({ fetch: async () => Response.json({
        id: "k".repeat(12), prefix: `ncx_live_${"k".repeat(12)}`, label: "voice", digest,
        createdAt: 1, userId: owner, organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        teamId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "writer",
        authorizationEpoch: 1, capabilities: ["agents:write"],
      }, { headers: { "x-nanocodex-api-key-authorized": "1" } }) }) },
      NANOCODEX_SESSIONS: { idFromName: () => ({ toString: () => id }), get: () => ({ fetch: ownership }) },
      NANOCODEX: { fetch: generic },
      ...(privateBinding ? { NANOCODEX_REALTIME: { fetch: relay } } : {}),
    } as unknown as Parameters<typeof routeManagedRealtimeTransport>[1];
    const url = new URL("https://test.example/v1/agents/11111111-1111-7111-8111-111111111111/realtime/calls");
    const request = new Request(url, {
      method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
        "x-nanocodex-voice-session-id": "22222222-2222-7222-8222-222222222222",
        "x-nanocodex-realtime-owner": "attacker", "x-nanocodex-voice-region": "wnam",
      }, body: JSON.stringify({ sdp: "v=0", session: session() }),
    });
    const response = await routeManagedRealtimeTransport(request, env, url, 1000);
    return { response, relay, generic, ownership, owner };
  }
  it("checks ownership before forwarding its own owner assertion", async () => {
    const f = await fixture(true);
    expect(f.response?.status).toBe(201);
    expect(f.ownership).toHaveBeenCalledTimes(1);
    expect(f.generic).not.toHaveBeenCalled();
    const request = f.relay.mock.calls[0]![0];
    expect(request.headers.get("x-nanocodex-realtime-owner")).toBe(f.owner);
    expect(request.headers.has("x-nanocodex-voice-region")).toBe(false);
  });
  it("does not reach either egress capability when ownership is denied", async () => {
    const f = await fixture(false);
    expect(f.response?.status).toBe(404);
    expect(f.relay).not.toHaveBeenCalled();
    expect(f.generic).not.toHaveBeenCalled();
  });
  it("retains the generic broker's ownership check while the binding is absent", async () => {
    const f = await fixture(true, false);
    expect(f.response?.status).toBe(201);
    expect(f.generic.mock.calls[0]![0].headers.has("x-nanocodex-realtime-owner")).toBe(false);
  });
});
