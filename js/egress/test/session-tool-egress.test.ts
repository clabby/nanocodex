import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleEgress, SessionToolEgress, type EgressEnv } from "../src/egress";

const owner = "11111111-1111-4111-8111-111111111111";
const subject = `managed-session-v1_${"a".repeat(64)}`;
const ownerHeader = "x-nanocodex-session-tool-owner";
const connection = "c".repeat(43);

function publicRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://public-egress.internal/v1/request", { headers: {
    "x-nanocodex-subject": subject, "x-nanocodex-target-url": "https://example.com/data", ...headers,
  } });
}
function githubRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://api.github.com/repos/octo/site/git/blobs", { method: "POST", headers: {
    "x-nanocodex-subject": subject, authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
    "content-type": "application/json", ...headers,
  }, body: JSON.stringify({ content: "x", encoding: "utf-8" }) });
}
function callbackEnv(extra: Record<string, unknown> = {}) {
  const callback = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(`https://managed-ownership.internal/v1/resolve?subject=${subject}`);
    return Response.json({ user_id: owner });
  });
  const connectorFetch = vi.fn(async (_request: Request) => Response.json({ sha: "blob" }, { status: 201 }));
  const connectorOwners: string[] = [];
  const env = {
    MANAGED_AGENT_OWNERSHIP: { fetch: callback },
    AGENT_SUBJECTS: { getByName: () => { throw new Error("must not allocate a legacy subject DO"); } },
    USER_CONNECTORS: { getByName: (name: string) => { connectorOwners.push(name); return { fetch: connectorFetch }; } },
    ...extra,
  } as unknown as EgressEnv;
  return { env, callback, connectorFetch, connectorOwners };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Session-only tool egress", () => {
  it("baseline: generic egress calls back into the originating Session once per tool request", async () => {
    const { env, callback } = callbackEnv();
    const upstream = vi.fn(async () => new Response("ok"));
    for (let i = 0; i < 8; i++) {
      expect((await handleEgress(publicRequest(), env, undefined, upstream as typeof fetch)).status).toBe(200);
    }
    // Each callback is a nested Worker -> Session invocation that becomes the
    // Session's newest incoming request: the depth ratchet in production.
    expect(callback).toHaveBeenCalledTimes(8);
  });

  it("public HTTP uses the private owner assertion with zero Session callbacks and strips private headers", async () => {
    const { env, callback } = callbackEnv();
    const upstream = vi.fn(async (input: Request) => {
      expect(input.url).toBe("https://example.com/data");
      for (const name of [ownerHeader, "x-nanocodex-subject", "x-nanocodex-target-url"]) expect(input.headers.has(name)).toBe(false);
      return new Response("ok");
    });
    vi.stubGlobal("fetch", upstream);
    const entrypoint = new SessionToolEgress(createExecutionContext(), env);
    for (let i = 0; i < 8; i++) {
      const response = await entrypoint.fetch(publicRequest({ [ownerHeader]: owner }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    }
    expect(upstream).toHaveBeenCalledTimes(8);
    expect(callback).not.toHaveBeenCalled();
  });

  it("connector (GitHub) requests reach the asserted owner's broker without a Session callback", async () => {
    const { env, callback, connectorFetch, connectorOwners } = callbackEnv();
    const entrypoint = new SessionToolEgress(createExecutionContext(), env);
    for (let i = 0; i < 8; i++) {
      expect((await entrypoint.fetch(githubRequest({ [ownerHeader]: owner }))).status).toBe(201);
    }
    expect(callback).not.toHaveBeenCalled();
    expect(connectorFetch).toHaveBeenCalledTimes(8);
    expect(new Set(connectorOwners)).toEqual(new Set([owner]));
    for (const [request] of connectorFetch.mock.calls) expect(request.headers.has(ownerHeader)).toBe(false);
  });

  it("rejects missing, malformed, or spoofed authority before any callback, broker, or upstream call", async () => {
    const { env, callback, connectorFetch } = callbackEnv();
    const upstream = vi.fn(async () => new Response("must not fetch"));
    vi.stubGlobal("fetch", upstream);
    const entrypoint = new SessionToolEgress(createExecutionContext(), env);
    const cases: Request[] = [
      publicRequest(),                                                     // missing owner assertion
      publicRequest({ [ownerHeader]: "" }),
      publicRequest({ [ownerHeader]: "../owner" }),                         // malformed owner
      publicRequest({ [ownerHeader]: owner, "x-nanocodex-subject": "s".repeat(43) }), // non-Session subject
      new Request("https://public-egress.internal/v1/request", { headers: { [ownerHeader]: owner, "x-nanocodex-target-url": "https://example.com/" } }),
      publicRequest({ [ownerHeader]: owner, "x-nanocodex-session-model-owner": owner }),
    ];
    for (const request of cases) expect((await entrypoint.fetch(request)).status).toBe(403);
    expect(callback).not.toHaveBeenCalled();
    expect(connectorFetch).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("supports only Session tool routes; model, control, vault-browser, phone, and owner-path routes fail closed", async () => {
    const { env, callback } = callbackEnv({ USER_CREDENTIALS: { getByName: () => { throw new Error("must not resolve credentials"); } } });
    const upstream = vi.fn(async () => new Response("must not fetch"));
    vi.stubGlobal("fetch", upstream);
    const entrypoint = new SessionToolEgress(createExecutionContext(), env);
    const headers = { [ownerHeader]: owner, "x-nanocodex-subject": subject, authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL", "content-type": "application/json" };
    for (const url of [
      "https://nanocodex.internal/v1/messages",
      "https://nanocodex.internal/v1/responses",
      "https://nanocodex.internal/v1/model-status",
      `https://broker.internal/users/${owner}/connectors/link?attempt=${"a".repeat(43)}`,
      `https://broker.internal/subjects/${"s".repeat(43)}`,
      "https://browser-vault.internal/v1/login",
      "https://browser-vault.internal/v1/totp",
      `https://phone-service.internal/v1/users/${owner}/numbers`,
      `https://vault-egress.internal/v1/users/${owner}/request`,
      "https://public-egress.internal/v1/request?x=1",
      "https://ssh.internal/v1/execute/extra",
      `https://mcp.internal/v1/connections/${connection}/extra`,
      "https://example.com/not-a-connector",
    ]) {
      const response = await entrypoint.fetch(new Request(url, { method: "POST", headers, body: "{}" }));
      expect(response.status, url).toBe(403);
    }
    expect(callback).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("the general broker rejects any caller-supplied tool owner header", async () => {
    const { env, callback, connectorFetch } = callbackEnv();
    const upstream = vi.fn(async () => new Response("must not fetch"));
    for (const request of [publicRequest({ [ownerHeader]: owner }), githubRequest({ [ownerHeader]: owner })]) {
      const response = await handleEgress(request, env, undefined, upstream as typeof fetch);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "invalid_session_tool_authority" });
    }
    expect(callback).not.toHaveBeenCalled();
    expect(connectorFetch).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("an authority for one subject never authorizes a different subject through handleEgress", async () => {
    const { env, callback } = callbackEnv();
    const upstream = vi.fn(async () => new Response("must not fetch"));
    const other = `managed-session-v1_${"b".repeat(64)}`;
    const response = await handleEgress(publicRequest({ "x-nanocodex-subject": other }), env, undefined,
      upstream as typeof fetch, undefined, undefined, { subject, owner });
    expect(response.status).toBe(403);
    expect(callback).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("Session tool egress keeps per-resource ownership checks", () => {
  function mcpRequest(): Request {
    return new Request(`https://mcp.internal/v1/connections/${connection}`, { method: "POST", headers: {
      "x-nanocodex-subject": subject, [ownerHeader]: owner, "content-type": "application/json", accept: "application/json",
    }, body: "{}" });
  }

  it("MCP: a burst reaches the asserted owner's connection proxy with zero Session callbacks", async () => {
    const directory = vi.fn(async () => Response.json({ user_id: owner }));
    const { env, callback, connectorFetch, connectorOwners } = callbackEnv({ MCP_CONNECTIONS: { getByName: () => ({ fetch: directory }) } });
    const entrypoint = new SessionToolEgress(createExecutionContext(), env);
    for (let i = 0; i < 8; i++) expect((await entrypoint.fetch(mcpRequest())).status).toBe(201);
    expect(callback).not.toHaveBeenCalled();
    expect(directory).toHaveBeenCalledTimes(8); // connection ownership still checked on every request
    expect(connectorFetch).toHaveBeenCalledTimes(8);
    expect(new Set(connectorOwners)).toEqual(new Set([owner]));
    expect(connectorFetch.mock.calls[0]![0].url).toBe(`https://mcp-connections.internal/v1/connections/${connection}/proxy`);
  });

  it("MCP: a connection owned by another user is still denied under a valid Session assertion", async () => {
    const directory = vi.fn(async () => Response.json({ user_id: "22222222-2222-4222-8222-222222222222" }));
    const { env, callback, connectorFetch } = callbackEnv({ MCP_CONNECTIONS: { getByName: () => ({ fetch: directory }) } });
    const response = await new SessionToolEgress(createExecutionContext(), env).fetch(mcpRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "mcp_connection_owner_mismatch" });
    expect(callback).not.toHaveBeenCalled();
    expect(connectorFetch).not.toHaveBeenCalled();
  });

  it("connector requests still require the provider credential placeholder", async () => {
    const { env, callback, connectorFetch } = callbackEnv();
    const request = githubRequest({ [ownerHeader]: owner, authorization: "Bearer caller-secret" });
    expect((await new SessionToolEgress(createExecutionContext(), env).fetch(request)).status).toBe(403);
    expect(callback).not.toHaveBeenCalled();
    expect(connectorFetch).not.toHaveBeenCalled();
  });
});

describe("Session tool egress: Vault and SSH owner routing", () => {
  function credentialsEnv(status: number) {
    const brokerOwners: string[] = [];
    const brokerPaths: string[] = [];
    const brokerFetch = vi.fn(async (input: RequestInfo | URL) => {
      brokerPaths.push(new URL(String(input)).pathname);
      return Response.json({ error: "not_found" }, { status });
    });
    const base = callbackEnv({ USER_CREDENTIALS: { getByName: (name: string) => { brokerOwners.push(name); return { fetch: brokerFetch }; } } });
    return { ...base, brokerOwners, brokerPaths, brokerFetch };
  }

  it("Vault requests resolve the Vault entry from the asserted owner's broker, never the Session callback", async () => {
    const { env, callback, brokerOwners, brokerPaths } = credentialsEnv(404);
    const upstream = vi.fn(async () => new Response("must not fetch"));
    vi.stubGlobal("fetch", upstream);
    const entrypoint = new SessionToolEgress(createExecutionContext(), env);
    for (let i = 0; i < 4; i++) {
      const response = await entrypoint.fetch(new Request("https://vault-egress.internal/v1/request", { method: "POST", headers: {
        "content-type": "application/json", "x-nanocodex-subject": subject, [ownerHeader]: owner,
      }, body: JSON.stringify({ vault_id: "v".repeat(22), url: "https://merchant.example.com/checkout", method: "GET", headers: { authorization: "Basic {{NANOCODEX_VAULT_BASIC}}" } }) }));
      expect(response.status).toBeGreaterThanOrEqual(400); // fixture broker has no such entry
    }
    expect(callback).not.toHaveBeenCalled();
    expect(new Set(brokerOwners)).toEqual(new Set([owner]));
    expect(brokerPaths.every(path => path === `/v1/vault-entry/${"v".repeat(22)}`)).toBe(true);
    expect(brokerPaths).toHaveLength(4);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("SSH resolves the identity from the asserted owner's broker, never the Session callback", async () => {
    const { env, callback, brokerOwners, brokerPaths } = credentialsEnv(404);
    const entrypoint = new SessionToolEgress(createExecutionContext(), env);
    for (let i = 0; i < 4; i++) {
      const response = await entrypoint.fetch(new Request("https://ssh.internal/v1/execute", { method: "POST", headers: {
        "content-type": "application/json", "x-nanocodex-subject": subject, [ownerHeader]: owner,
      }, body: JSON.stringify({ identity_ref: "fixture-identity", hostname: "example.com", port: 22, username: "deploy", command: ["true"] }) }));
      expect(response.status).toBeGreaterThanOrEqual(400); // fixture broker has no such identity
    }
    expect(callback).not.toHaveBeenCalled();
    expect(new Set(brokerOwners)).toEqual(new Set([owner]));
    expect(brokerPaths).toEqual(Array(4).fill("/v1/ssh-identities/fixture-identity"));
  });
});
