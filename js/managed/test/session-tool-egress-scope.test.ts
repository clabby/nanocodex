import { describe, expect, it, vi } from "vitest";
import { handleManagedEgress } from "../src/managed-egress";
import {
  managedCredentialSubject,
  scopedSessionToolEgress,
  sessionCredentialOwner,
  SESSION_TOOL_OWNER_HEADER,
} from "../src/session-credential-ownership";

const storageId = "a".repeat(64);
const ownerId = "11111111-1111-4111-8111-111111111111";
const sessionId = "018f25e8-7b51-7a32-8c4d-0123456789ab";
const subject = managedCredentialSubject(storageId);
const coordinates = { owner_id: ownerId, session_id: sessionId, runtime_profile: "managed" };
const active = {
  subject, storageId,
  binding: { ...coordinates, subject: storageId, state: "active", strategy: "session_v1" },
  session: coordinates, initialization: { ...coordinates, state: "active" },
  deleting: false, deleted: false, exported: false, importPending: false,
};

function bindings() {
  const general: Request[] = [];
  const tool: Request[] = [];
  return {
    general, tool,
    generalBinding: { fetch: vi.fn(async (request: Request) => { general.push(request); return new Response("general"); }), connect: vi.fn() } as unknown as Fetcher,
    toolBinding: { fetch: vi.fn(async (request: Request) => { tool.push(request); return new Response("tool"); }) } as unknown as Fetcher,
  };
}

describe("Session tool egress scoping", () => {
  it("routes the Session's own tool traffic through the private binding with a live local owner and no callback route", async () => {
    const b = bindings();
    const owner = vi.fn(() => sessionCredentialOwner(active));
    const egress = scopedSessionToolEgress(b.generalBinding, b.toolBinding, storageId, subject, owner);
    for (let i = 0; i < 8; i++) {
      // The real Just Bash/curl gateway path for a public destination.
      const response = await handleManagedEgress(new Request("https://example.com/data"), egress, subject);
      expect(await response.text()).toBe("tool");
    }
    expect(b.general).toHaveLength(0);
    expect(b.tool).toHaveLength(8);
    expect(owner).toHaveBeenCalledTimes(8); // re-evaluated per request, never cached
    for (const request of b.tool) {
      expect(request.url).toBe("https://public-egress.internal/v1/request");
      expect(request.headers.get("x-nanocodex-subject")).toBe(subject);
      expect(request.headers.get(SESSION_TOOL_OWNER_HEADER)).toBe(ownerId);
    }
  });

  it("replaces a caller-supplied owner header with the Session's authoritative owner", async () => {
    const b = bindings();
    const egress = scopedSessionToolEgress(b.generalBinding, b.toolBinding, storageId, subject, () => sessionCredentialOwner(active));
    await egress.fetch(new Request("https://public-egress.internal/v1/request", { headers: {
      "x-nanocodex-subject": subject, [SESSION_TOOL_OWNER_HEADER]: "attacker-owner",
    } }));
    expect(b.tool[0]!.headers.get(SESSION_TOOL_OWNER_HEADER)).toBe(ownerId);
    // The shell gateway rejects caller-supplied ownership headers outright.
    const viaGateway = await handleManagedEgress(new Request("https://example.com/", {
      headers: { [SESSION_TOOL_OWNER_HEADER]: "attacker-owner" },
    }), egress, subject);
    expect(viaGateway.status).toBe(403);
    expect(b.tool).toHaveLength(1);
    expect(b.general).toHaveLength(0);
  });

  it.each([
    ["deleting", { ...active, deleting: true }],
    ["deleted", { ...active, deleted: true }],
    ["exported", { ...active, exported: true }],
    ["import pending", { ...active, importPending: true }],
    ["inactive binding", { ...active, binding: { ...active.binding, state: "pending" } }],
  ])("fails closed without any binding call when ownership is unavailable (%s)", async (_label, state) => {
    const b = bindings();
    const egress = scopedSessionToolEgress(b.generalBinding, b.toolBinding, storageId, subject, () => sessionCredentialOwner(state));
    await expect(egress.fetch(new Request("https://public-egress.internal/v1/request", { headers: {
      "x-nanocodex-subject": subject, [SESSION_TOOL_OWNER_HEADER]: ownerId,
    } }))).rejects.toThrow("managed tool ownership is unavailable");
    expect(b.general).toHaveLength(0);
    expect(b.tool).toHaveLength(0);
  });

  it("keeps foreign, missing, and legacy subjects on the general broker with owner assertions stripped", async () => {
    const b = bindings();
    const owner = vi.fn(() => ownerId);
    const scoped = scopedSessionToolEgress(b.generalBinding, b.toolBinding, storageId, subject, owner);
    for (const headers of [{ "x-nanocodex-subject": managedCredentialSubject("b".repeat(64)) }, {}] as Record<string, string>[]) {
      await scoped.fetch(new Request("https://public-egress.internal/v1/request", { headers: { ...headers, [SESSION_TOOL_OWNER_HEADER]: ownerId } }));
    }
    // Directory-strategy Sessions and deployments without the binding keep the existing path.
    const legacy = scopedSessionToolEgress(b.generalBinding, b.toolBinding, storageId, storageId, owner);
    await legacy.fetch(new Request("https://public-egress.internal/v1/request", { headers: { "x-nanocodex-subject": storageId, [SESSION_TOOL_OWNER_HEADER]: ownerId } }));
    const unbound = scopedSessionToolEgress(b.generalBinding, undefined, storageId, subject, owner);
    await unbound.fetch(new Request("https://public-egress.internal/v1/request", { headers: { "x-nanocodex-subject": subject, [SESSION_TOOL_OWNER_HEADER]: ownerId } }));
    expect(b.tool).toHaveLength(0);
    expect(b.general).toHaveLength(4);
    for (const request of b.general) expect(request.headers.has(SESSION_TOOL_OWNER_HEADER)).toBe(false);
    expect(owner).not.toHaveBeenCalled();
  });
});

describe("Session tool egress ownership lifecycle", () => {
  it("re-reads ownership on every request: owner change and deletion between requests take effect immediately", async () => {
    const b = bindings();
    const states: (typeof active)[] = [
      active,
      { ...active, binding: { ...active.binding, owner_id: "22222222-2222-4222-8222-222222222222" },
        session: { ...coordinates, owner_id: "22222222-2222-4222-8222-222222222222" },
        initialization: { ...coordinates, owner_id: "22222222-2222-4222-8222-222222222222", state: "active" } },
      { ...active, deleting: true },
      { ...active, deleted: true },
    ];
    let index = 0;
    const egress = scopedSessionToolEgress(b.generalBinding, b.toolBinding, storageId, subject,
      () => sessionCredentialOwner(states[index]!));
    const send = () => egress.fetch(new Request("https://public-egress.internal/v1/request", { headers: { "x-nanocodex-subject": subject } }));
    await send(); index = 1; await send();
    expect(b.tool.map(request => request.headers.get(SESSION_TOOL_OWNER_HEADER)))
      .toEqual([ownerId, "22222222-2222-4222-8222-222222222222"]);
    index = 2; await expect(send()).rejects.toThrow("managed tool ownership is unavailable");
    index = 3; await expect(send()).rejects.toThrow("managed tool ownership is unavailable");
    expect(b.tool).toHaveLength(2);
    expect(b.general).toHaveLength(0); // never a callback-path fallback for the Session's own subject
  });

  it("strips spoofed tool and model owner headers on both the private and general paths", async () => {
    const b = bindings();
    const spoofed = { [SESSION_TOOL_OWNER_HEADER]: "attacker", "x-nanocodex-session-model-owner": "attacker" };
    const egress = scopedSessionToolEgress(b.generalBinding, b.toolBinding, storageId, subject, () => ownerId);
    await egress.fetch(new Request("https://public-egress.internal/v1/request", { headers: { "x-nanocodex-subject": subject, ...spoofed } }));
    await egress.fetch(new Request("https://public-egress.internal/v1/request", { headers: { "x-nanocodex-subject": "s".repeat(43), ...spoofed } }));
    expect(b.tool[0]!.headers.get(SESSION_TOOL_OWNER_HEADER)).toBe(ownerId);
    expect(b.tool[0]!.headers.has("x-nanocodex-session-model-owner")).toBe(false);
    expect(b.general[0]!.headers.has(SESSION_TOOL_OWNER_HEADER)).toBe(false);
    expect(b.general[0]!.headers.has("x-nanocodex-session-model-owner")).toBe(false);
    // The real shell gateway denies either spoofed header before any binding call.
    for (const [name, value] of Object.entries(spoofed)) {
      const response = await handleManagedEgress(new Request("https://example.com/", { headers: { [name]: value } }), egress, subject);
      expect(response.status).toBe(403);
      const vault = await handleManagedEgress(new Request("https://example.com/", { headers: { [name]: value, "x-nanocodex-vault-id": "v".repeat(22) } }), egress, subject);
      expect(vault.status).toBe(403);
    }
    expect(b.tool).toHaveLength(1);
    expect(b.general).toHaveLength(1);
  });

  it("burst of repeated connector and public operations uses only the private binding (no ownership callback route)", async () => {
    const b = bindings();
    const owner = vi.fn(() => sessionCredentialOwner(active));
    const egress = scopedSessionToolEgress(b.generalBinding, b.toolBinding, storageId, subject, owner);
    for (let i = 0; i < 16; i++) {
      await handleManagedEgress(new Request("https://api.github.com/repos/octo/site/git/blobs", { method: "POST", body: "{}" }),
        egress, subject, () => true);
      await handleManagedEgress(new Request(`https://example.com/${i}`), egress, subject);
    }
    expect(b.general).toHaveLength(0);
    expect(b.tool).toHaveLength(32);
    expect(owner).toHaveBeenCalledTimes(32);
    expect(new Set(b.tool.map(request => request.headers.get(SESSION_TOOL_OWNER_HEADER)))).toEqual(new Set([ownerId]));
    expect(b.tool.filter(request => request.url.startsWith("https://api.github.com/"))).toHaveLength(16);
  });
});

describe("Session tool egress wiring", () => {
  it("routes every Session-subject tool caller through the scoped tool egress", async () => {
    // Vite raw import; a variable specifier keeps TypeScript from resolving "?raw".
    const rawIndex = "../src/index.ts?raw";
    const { default: source } = await import(/* @vite-ignore */ rawIndex) as { default: string };
    for (const pattern of [
      /createManagedComputerRuntime\(\{[\s\S]{0,400}?egress: this\.#toolEgress\(\)/,
      /calendarFetch: \(request, context\) => handleManagedEgress\(request, this\.#toolEgress\(\)/,
      /createVaultRequestTool\(this\.#toolEgress\(\)/,
      /managedAccountMcpServers\(\[connection\], this\.#toolEgress\(\)/,
      /serverHandTool\(\{[\s\S]{0,300}?egress: this\.#toolEgress\(\)/,
    ]) expect(source).toMatch(pattern);
    // No Session-subject egress helper may receive the callback-prone general binding.
    expect(source).not.toMatch(/handleManagedEgress\(\s*request,\s*this\.env\.NANOCODEX\b/);
    expect(source).not.toMatch(/createVaultRequestTool\(this\.env\.NANOCODEX\b/);
    expect(source).not.toMatch(/managedAccountMcpServers\(\[connection\], this\.env\.NANOCODEX\b/);
  });
});
