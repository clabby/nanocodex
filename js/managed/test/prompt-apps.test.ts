import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
beforeAll(async () => {
  const bindings = env as unknown as { NANOCODEX_CRM: D1Database; CRM_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(bindings.NANOCODEX_CRM, bindings.CRM_MIGRATIONS);
});
const origin = "https://apps.example.test";
const document = { title: "Reading tracker", description: "Books and progress", html: '<!doctype html><h1>Books</h1><script>window.ready=true</script>' };
async function call(path: string, method = "GET", body?: unknown, account = "owner", headers: Record<string, string> = {}) {
  const response = await SELF.fetch(`${origin}/v1/apps${path}`, {
    method, headers: { authorization: `Bearer ${account}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json() as any;
  console.info(JSON.stringify({ scenario: "prompt-apps.http", method, path, account, status: response.status,
    result: value.error ?? { id: value.id, revision: value.revision, apps: value.apps?.length, deleted: value.deleted } }));
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, value };
}
it("creates a generated app, persists and resolves state conflicts across clients, isolates accounts and atomically deletes", async () => {
  expect((await call("", "GET", undefined, "anonymous")).status).toBe(401);
  expect((await call("", "GET", undefined, "connect")).status).toBe(403);
  expect((await call("", "GET", undefined, "no-tools")).status).toBe(403);
  expect((await call("", "POST", document, "read")).status).toBe(403);
  expect((await call("", "GET", undefined, "write")).status).toBe(403);
  expect((await call("", "POST", document, "cookie")).status).toBe(403);
  expect((await call("", "POST", document, "cookie", { origin: "https://evil.test" })).status).toBe(403);
  const created = await call("", "POST", document, "cookie", { origin });
  expect(created.status).toBe(201);
  expect(created.value).toMatchObject({ ...document, revision: 1 });
  const id = created.value.id, path = `/${id}`;
  const page = await call("?limit=1");
  expect(page.value.apps).toHaveLength(1);
  expect(page.value.apps[0]).not.toHaveProperty("html");
  expect((await call(path)).value).toEqual(created.value);
  expect((await call("", "GET", undefined, "other")).value.apps).toEqual([]);
  for (const [suffix, method, body] of [["", "GET"], ["", "PUT", { ...document, revision: 1 }], ["/data", "GET"], ["/data", "PUT", { value: {}, revision: 0 }], ["?revision=1", "DELETE"]] as const)
    expect((await call(`${path}${suffix}`, method, body, "other")).status).toBe(404);
  expect((await call(`${path}/restore`, "POST", { revision: 1 })).value.error).toBe("no_previous_revision");
  expect((await call(`${path}/data`)).value).toEqual({ value: null, revision: 0, updated_at: null });
  const racing = await Promise.all([1, 2].map(count => call(`${path}/data`, "PUT", { value: { count }, revision: 0 })));
  expect(racing.map(result => result.status).sort()).toEqual([200, 409]);
  const first = (await call(`${path}/data`)).value;
  expect(first.revision).toBe(1);
  expect((await call(`${path}/data`, "PUT", { value: { count: 3 }, revision: first.revision })).value.revision).toBe(2);
  expect((await call(path, "PUT", { ...document, title: "Bookshelf", revision: 1 })).value.revision).toBe(2);
  expect((await call(path, "PUT", { ...document, revision: 1 })).value.error).toBe("revision_conflict");
  expect((await call(`${path}?revision=1`, "DELETE")).status).toBe(409);
  expect((await call(`${path}/data`)).value.value).toEqual({ count: 3 });
  const restored = await call(`${path}/restore`, "POST", { revision: 2 });
  expect(restored.value).toMatchObject({ ...document, revision: 3 });
  expect((await call(`${path}/data`)).value.value).toEqual({ count: 3 });
  expect((await call(`${path}/restore`, "POST", { revision: 2 })).status).toBe(409);
  expect((await call(path, "DELETE", { revision: 3 })).value.deleted).toBe(true);
  expect((await call(path)).status).toBe(404);
  expect((await call(`${path}/data`)).status).toBe(404);
  expect((await call(`${path}/data`, "PUT", { value: "revive", revision: 2 })).status).toBe(404);
});
it("rejects malformed and oversized input, enforces revisions and paginates without HTML", async () => {
  expect((await call("", "POST", { ...document, html: "🪴".repeat(65537) })).status).toBe(400);
  expect((await call("", "POST", { ...document, owner_id: "other" })).status).toBe(400);
  expect((await call("", "POST", { ...document, id: "chosen" })).status).toBe(400);
  expect((await call("?limit=1&limit=2")).status).toBe(400);
  expect((await call("?limit=101")).status).toBe(400);
  const a = await call("", "POST", document), b = await call("", "POST", document);
  expect(a.status).toBe(201); expect(b.status).toBe(201);
  const first = (await call("?limit=1")).value;
  expect(first.next_cursor).toBeTypeOf("string");
  const second = (await call(`?limit=1&cursor=${first.next_cursor}`)).value;
  expect(second.apps[0].id).not.toBe(first.apps[0].id);
  expect(second.next_cursor).toBeNull();
  const path = `/${a.value.id}`;
  expect((await call(path, "PUT", document)).status).toBe(400);
  expect((await call(path, "DELETE")).status).toBe(400);
  expect((await call(`${path}/data`, "PUT", { revision: 0 })).status).toBe(400);
  expect((await call(`${path}/data`, "PUT", { value: "x".repeat(262144), revision: 0 })).status).toBe(413);
  expect((await call(`${path}/data`, "PUT", { value: null, revision: -1 })).status).toBe(400);
  expect((await call(`${path}/data`, "PUT", { value: null, revision: 0 })).value.revision).toBe(1);
});
