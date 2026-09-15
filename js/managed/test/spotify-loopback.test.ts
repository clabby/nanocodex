import { describe, expect, it } from "vitest";
import { canManageNativeConnectors, readSpotifyLoopbackBody } from "../src/connectors";
import type { Principal } from "../src/account-auth";

describe("native Spotify account boundary", () => {
  it("requires owner device authority and rejects delegated grants", () => {
    const owner = { userId: "owner", organizationId: "org", teamId: "team", subjectId: "api_key:device", credentialId: "device", authorizationEpoch: 1, kind: "api_key", role: "owner", capabilities: ["api_keys:write", "tools:use"] } as Principal;
    expect(canManageNativeConnectors(owner)).toBe(true);
    expect(canManageNativeConnectors({ ...owner, role: "writer" })).toBe(false);
    expect(canManageNativeConnectors({ ...owner, capabilities: ["tools:use"] })).toBe(false);
    expect(canManageNativeConnectors({ ...owner, kind: "service" })).toBe(false);
    expect(canManageNativeConnectors({ ...owner, connectGrant: { grantId: "grant", connectors: ["spotify"], mcpIds: [] } })).toBe(false);
    expect(canManageNativeConnectors(undefined)).toBe(false);
  });
  it("accepts only bounded code/state or cancellation, never tokens or client overrides", async () => {
    const parse = (body: unknown, callback = true, disconnect = false) => readSpotifyLoopbackBody(new Request("https://app.test", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), callback, disconnect);
    const valid = { state: "s".repeat(43), code: "one-time-code" };
    expect(await parse(valid)).toEqual(valid);
    expect(await parse({ state: valid.state, error: "access_denied" })).toEqual({ state: valid.state, error: "access_denied" });
    for (const body of [{ ...valid, access_token: "secret" }, { ...valid, error: "denied" },
      { ...valid, state: "wrong" }, { ...valid, code: "x".repeat(9000) }, { ...valid, client_id: "other" }]) {
      expect(await parse(body)).toBeUndefined();
    }
    expect(await parse({ connection_id: "c".repeat(43) }, false, true)).toEqual({ connection_id: "c".repeat(43) });
    expect(await parse({ connection_id: "../other" }, false, true)).toBeUndefined();
    expect(await parse({ connection_id: "c".repeat(43), user_id: "someone-else" }, false, true)).toBeUndefined();
    expect(await parse({}, false)).toEqual({});
    expect(await parse({ redirect_uri: "https://evil.test" }, false)).toBeUndefined();
  });
});
