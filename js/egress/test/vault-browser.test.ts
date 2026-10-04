import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const PASSWORD = "fixture-browser-password";
const ORIGIN = "https://login.example.test";

// Exercise the shipped Worker fetch entrypoint and its real encrypted Durable
// Object storage. The browser-only service binding is intentionally privileged;
// model HTTP gateway denial is covered by the separate transport journey.
describe("private browser Vault boundary", () => {
  it("uses an owned login directly, treating a saved origin as a hint while rejecting invalid authority", async () => {
    const owner = "vault-browser-owner";
    const subject = "B".repeat(43);
    const other = "C".repeat(43);
    for (const [id, user] of [[subject, owner], [other, "vault-browser-other"]]) {
      expect((await SELF.fetch(`https://broker.internal/subjects/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_id: user }) })).status).toBe(200);
    }
    const create = (kind: string, body: Record<string, string>) => SELF.fetch(`https://broker.internal/users/${owner}/credentials/vault/${kind}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const created = await create("login", { name: "Fixture login", username: "fixture@example.test", password: PASSWORD });
    expect(created.status).toBe(201);
    const entry = await created.json<{ id: string; browser_origin?: string }>();
    expect(entry.browser_origin).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(PASSWORD);
    const resolve = (who = subject, origin: unknown = ORIGIN, id = entry.id) => SELF.fetch("https://browser-vault.internal/v1/login", {
      method: "POST", headers: { "content-type": "application/json", "x-nanocodex-subject": who },
      body: JSON.stringify({ vault_id: id, expected_origin: origin }),
    });
    const assertLogin = async (origin = ORIGIN) => {
      const response = await resolve(subject, origin);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ username: "fixture@example.test", password: PASSWORD });
    };

    // Saving a login is sufficient: no second metadata approval request.
    await assertLogin();
    const hint = (origin: string, who = owner) => SELF.fetch(`https://broker.internal/users/${who}/credentials/vault/login/${entry.id}/origin`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser_origin: origin }),
    });
    expect((await hint(ORIGIN, "vault-browser-other")).status).toBe(404);
    const savedHint = await hint("https://old-login.example.test");
    expect(savedHint.status).toBe(200);
    const metadata = await savedHint.json();
    expect(metadata).toMatchObject({ id: entry.id, browser_origin: "https://old-login.example.test" });
    expect(JSON.stringify(metadata)).not.toContain(PASSWORD);
    // The explicit browser destination may differ by host or port from the hint.
    await assertLogin();
    await assertLogin("https://login.example.test:444");
    await assertLogin("https://another-login.example.test");

    expect((await resolve(other)).status).toBe(403);
    expect((await resolve("D".repeat(43))).status).toBe(403);
    const apiKey = await create("api_key", { name: "Fixture API", api_key: "fixture-api-secret" });
    expect(apiKey.status).toBe(201);
    const apiEntry = await apiKey.json<{ id: string }>();
    const wrongKind = await resolve(subject, ORIGIN, apiEntry.id);
    expect(wrongKind.status).toBe(403);
    expect(await wrongKind.text()).not.toContain("fixture-api-secret");
    for (const origin of ["http://login.example.test", `${ORIGIN}/`, `${ORIGIN}/path`, "https://person:secret@login.example.test", `${ORIGIN}?x=y`, `${ORIGIN}#fragment`, "not-an-origin", "", null]) {
      const denied = await resolve(subject, origin);
      expect(denied.status, String(origin)).toBe(400);
      expect(await denied.text()).not.toContain(PASSWORD);
    }
    expect((await SELF.fetch("https://browser-vault.internal/v1/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vault_id: entry.id, expected_origin: ORIGIN }) })).status).toBe(403);
    for (const [kind, id] of [["login", entry.id], ["api_key", apiEntry.id]]) {
      expect((await SELF.fetch(`https://broker.internal/users/${owner}/credentials/vault/${kind}/${id}`, { method: "DELETE" })).status).toBe(204);
    }
    expect((await resolve()).status).toBe(403);
  });
});
