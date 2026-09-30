import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";

beforeAll(async () => {
  const bindings = env as unknown as { NANOCODEX_CRM: D1Database; CRM_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(bindings.NANOCODEX_CRM, bindings.CRM_MIGRATIONS);
});
const origin = "https://apps.example.test";
const document = {
  title: "Counter", runtime: "swift-v1",
  source: 'struct Counter: View { @Persisted("count") var count = 0; var body: some View { Text("Count: \\(count)") } }',
};
async function call(path: string, method = "GET", body?: unknown, account = "owner", headers: Record<string, string> = {}) {
  const response = await SELF.fetch(`${origin}/v1/apps${path}`, {
    method, headers: { authorization: `Bearer ${account}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json() as Record<string, unknown>;
  console.info(JSON.stringify({ scenario: "prompt-apps.no-validator", method, path, account, status: response.status, value }));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return { status: response.status, value };
}

// Full successful save/state/revision/isolation/recovery journeys live in
// native-app-validation-journey.test.mjs, where the actual Swift executable
// supplies validation. This ordinary worker suite has no native Hand and must
// never manufacture a successful interpreter receipt to make saves pass.
it("fails closed without a native validator and leaves the account app collection empty", async () => {
  expect((await call("", "GET", undefined, "anonymous")).status).toBe(401);
  for (const account of ["connect", "no-tools"])
    expect((await call("", "GET", undefined, account)).status).toBe(403);
  expect((await call("", "POST", document, "read")).status).toBe(403);
  expect((await call("", "GET", undefined, "write")).status).toBe(403);
  expect((await call("", "POST", document, "cookie")).status).toBe(403);
  expect((await call("", "POST", document, "cookie", { origin: "https://evil.test" })).status).toBe(403);
  const create = await call("", "POST", document);
  expect(create).toEqual({ status: 503, value: { error: "app_validation_unavailable" } });
  const validate = await call("/validate", "POST", { runtime: document.runtime, source: document.source });
  expect(validate).toEqual({ status: 503, value: { error: "app_validation_unavailable" } });
  expect((await call("", "POST", document, "cookie", { origin })).status).toBe(503);
  expect((await call("")).value.apps).toEqual([]);
  expect((await call("", "GET", undefined, "other")).value.apps).toEqual([]);
});

it("rejects invalid API input before it needs a native Hand", async () => {
  expect((await call("", "POST", { ...document, source: "🪴".repeat(65537) })).status).toBe(400);
  expect((await call("", "POST", { ...document, owner_id: "other" })).value.error).toBe("invalid_input");
  expect((await call("", "POST", { ...document, id: "chosen" })).value.error).toBe("invalid_input");
  expect((await call("?limit=1&limit=2")).status).toBe(400);
  expect((await call("?limit=101")).status).toBe(400);
  for (const input of [{ title: "Legacy", html: "<h1>Legacy</h1>" }, { ...document, html: "<h1>Mixed</h1>" }])
    expect((await call("", "POST", input)).value.error).toBe("invalid_input");
  for (const runtime of [undefined, null, "html-v1", "javascript-v1", "swift-v2", "Swift-v1"])
    expect((await call("", "POST", { ...document, runtime })).value.error).toBe("unsupported_runtime");
  for (const steps of [[{ action: "execute", source: "unsafe" }], [{ action: "tap" }], Array(33).fill({ action: "reopen" })])
    expect((await call("/validate", "POST", { runtime: document.runtime, source: document.source, steps })).status).toBe(400);
  expect((await call("")).value.apps).toEqual([]);
});
