import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const user = "cloudflare-connector-journey";
const control = `https://broker.internal/users/${user}`;
const subject = "C".repeat(43);
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Cloudflare Vault-to-connector journey", () => {
  it("connects by private Vault reference, reads without a machine, fences secrets and disconnects", async () => {
    const created = await SELF.fetch(`${control}/credentials/vault/api_key`, json({ name: "Cloudflare", api_key: "synthetic-cloudflare-token" }));
    expect(created.status).toBe(201);
    const vault = await created.json<{ id: string }>();
    expect(JSON.stringify(vault)).not.toContain("synthetic-cloudflare-token");
    // Only a Vault reference is accepted at the connector control boundary.
    expect((await SELF.fetch(`${control}/connectors/cloudflare`, json({ access_token: "synthetic-cloudflare-token" }))).status).toBe(400);
    const foreign = await SELF.fetch("https://broker.internal/users/another-user/connectors/cloudflare", json({ vault_id: vault.id }));
    expect(foreign.status).toBe(409);
    const connected = await SELF.fetch(`${control}/connectors/cloudflare`, json({ vault_id: vault.id }));
    expect(connected.status).toBe(200);
    const result = await connected.json<{ connected: boolean; connection_id: string }>();
    expect(result.connected).toBe(true);
    expect(result.connection_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(result)).not.toContain("synthetic-cloudflare-token");
    const status = await (await SELF.fetch(`${control}/connectors`)).json<{ connectors: Record<string, { connected: boolean }> }>();
    expect(status.connectors.cloudflare.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain("synthetic-cloudflare-token");
    const bind = await SELF.fetch(`https://broker.internal/subjects/${subject}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_id: user }) });
    expect(bind.status).toBe(200);
    const headers = { authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL", "x-nanocodex-subject": subject, "x-nanocodex-connector-connection": result.connection_id };
    const api = "https://api.cloudflare.com/client/v4";
    const read = await SELF.fetch(`${api}/accounts`, { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ success: true, result: [{ name: "Synthetic account" }] });
    const account = "d".repeat(32);
    const query = await SELF.fetch(`${api}/accounts/${account}/workers/observability/telemetry/query`, { ...json({ queryId: "fixture", view: "events" }), headers: { ...headers, "content-type": "application/json" } });
    expect(query.status).toBe(200);
    for (const path of ["/user/tokens", `/accounts/${account}/tokens`, `/accounts/${account}/workers/scripts/example/tails`, `/accounts/${account}/workers/scripts/example/secrets`]) {
      expect((await SELF.fetch(api + path, { method: "POST", headers })).status).toBe(403);
    }
    expect((await SELF.fetch(`${api}/accounts?redirect=1`, { headers })).status).toBe(502);
    const reflected = await SELF.fetch(`${api}/accounts?reflect=1`, { headers });
    await expect(reflected.text()).rejects.toThrow();
    expect((await SELF.fetch(`${control}/connectors/cloudflare/connections/${result.connection_id}`, { method: "DELETE" })).status).toBe(204);
    expect((await SELF.fetch(`${api}/accounts`, { headers })).status).toBe(404);
  });

  it("rejects an invalid token without publishing a connection", async () => {
    const base = "https://broker.internal/users/cloudflare-invalid";
    const created = await SELF.fetch(`${base}/credentials/vault/api_key`, json({ name: "Cloudflare", api_key: "synthetic-invalid-token" }));
    const vault = await created.json<{ id: string }>();
    const response = await SELF.fetch(`${base}/connectors/cloudflare`, json({ vault_id: vault.id }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "cloudflare_token_invalid" });
    const status = await (await SELF.fetch(`${base}/connectors`)).json<{ connectors: Record<string, { connected: boolean }> }>();
    expect(status.connectors.cloudflare.connected).toBe(false);
  });
  it("verifies account-owned tokens against the explicit account and preserves auth on failed reconnect", async () => {
    const base = "https://broker.internal/users/cloudflare-account-token";
    const account_id = "d".repeat(32);
    const created = await SELF.fetch(`${base}/credentials/vault/api_key`, json({ name: "Cloudflare account", api_key: "synthetic-cloudflare-account-token" }));
    const vault = await created.json<{ id: string }>();
    const vault_id = vault.id;
    expect((await SELF.fetch(`${base}/connectors/cloudflare`, json({ vault_id }))).status).toBe(409);
    expect((await SELF.fetch(`${base}/connectors/cloudflare`, json({ vault_id, account_id: "f".repeat(32) }))).status).toBe(409);
    expect((await SELF.fetch(`${base}/connectors/cloudflare`, json({ vault_id, account_id: "../user" }))).status).toBe(400);
    const connected = await SELF.fetch(`${base}/connectors/cloudflare`, json({ vault_id, account_id }));
    expect(connected.status).toBe(200);
    const result = await connected.json<{ connected: boolean; connection_id: string }>();
    expect(result.connected).toBe(true);
    const accountSubject = "D".repeat(43);
    expect((await SELF.fetch(`https://broker.internal/subjects/${accountSubject}`, { ...json({ user_id: "cloudflare-account-token" }), method: "PUT" })).status).toBe(200);
    const read = await SELF.fetch(`https://api.cloudflare.com/client/v4/accounts/${account_id}/workers/scripts`, { headers: {
      authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL", "x-nanocodex-subject": accountSubject,
      "x-nanocodex-connector-connection": result.connection_id,
    } });
    expect(read.status).toBe(200);
    const expired = await SELF.fetch(`${base}/credentials/vault/api_key`, json({ name: "Expired", api_key: "synthetic-cloudflare-expired-token" }));
    const expiredVault = await expired.json<{ id: string }>();
    expect((await SELF.fetch(`${base}/connectors/cloudflare`, json({ vault_id: expiredVault.id, account_id }))).status).toBe(409);
    const status = await (await SELF.fetch(`${base}/connectors`)).json<any>();
    expect(status.connectors.cloudflare.connections).toHaveLength(1);
    expect(status.connectors.cloudflare.connections[0]).toMatchObject({ id: result.connection_id, account_id });
  });

});
