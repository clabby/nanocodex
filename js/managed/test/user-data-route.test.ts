import { SELF, env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { userDataTool } from "../src/user-data-tool";
const bindings = env as unknown as { NANOCODEX_USER_DATA: DurableObjectNamespace; NANOCODEX_USER_DATA_OBJECTS: R2Bucket };
async function request(body: unknown, token = "fixture-alice-both", headers: Record<string, string> = {}) {
  return SELF.fetch("https://data.example/v1/data", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
async function call(body: unknown, status = 200, token = "fixture-alice-both", headers: Record<string, string> = {}) {
  const response = await request(body, token, headers);
  const result = await response.json() as any;
  console.log(JSON.stringify({ journey: "user-data", operation: (body as any).operation, expected: status, observed: response.status, result: JSON.stringify(result).slice(0, 2000) }));
  expect(response.status, JSON.stringify(result)).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return result;
}
const key = (suffix: string) => `com.example/${crypto.randomUUID()}/${suffix}`;
const objectPut = (key: string, content: string, extra = {}) => ({
  operation: "object_put", key, content, encoding: "utf8", content_type: "text/plain; charset=utf-8", ...extra,
});

describe("user data Workers HTTP journeys (SQLite and R2)", () => {
  it("isolates accounts, rejects spoofed tenant binding and enforces capabilities/origin", async () => {
    const id = key("profile");
    await call({ operation: "document_put", key: id, value: { fixture: "alice" } });
    await call({ operation: "document_get", key: id }, 404, "fixture-bob-both", { "x-nanocodex-user-id": "user-data-fixture-alice" });
    await call({ operation: "document_get", key: id, userId: "user-data-fixture-alice" }, 400, "fixture-bob-both");
    await call({ operation: "document_put", key: id, value: 2 }, 403, "fixture-alice-read");
    await call({ operation: "document_get", key: id }, 403, "fixture-alice-write");
    await call({ operation: "document_list" }, 401, "invalid");
    await call({ operation: "document_get", key: id }, 403, "fixture-alice-session", { origin: "https://other.example" });
    await call({ operation: "document_get", key: id }, 200, "fixture-alice-session", { origin: "https://data.example" });
    const bind = await bindings.NANOCODEX_USER_DATA.getByName("different-tenant").fetch("https://internal/initialize", {
      method: "PUT", headers: { "x-nanocodex-user-id": "user-data-fixture-alice" },
    });
    expect(bind.status).toBe(404);
    console.log("tenant/name mismatch initialize: expected=404 observed=" + bind.status);
  });

  it("keeps document versions across deletion, retries and competing conditional updates", async () => {
    const id = key("profile");
    const put = { operation: "document_put", key: id, value: { b: 2, a: 1 } };
    expect((await call(put)).document).toMatchObject({ version: 1, unchanged: false });
    expect((await call({ ...put, value: { a: 1, b: 2 } })).document).toMatchObject({ version: 1, unchanged: true });
    const responses = await Promise.all([2, 3].map(value => request({ ...put, value, if_version: 1 })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    console.log("concurrent document CAS: expected=[200,409] observed=" + responses.map(r => r.status));
    await Promise.all(responses.map(r => r.text()));
    await call({ operation: "document_delete", key: id, if_version: 1 }, 409);
    const deleted = await call({ operation: "document_delete", key: id, if_version: 2 }, 200, "fixture-alice-write");
    expect(deleted).toEqual({ operation: "document_delete", document: { key: id, version: 2 }, deleted: true });
    await call({ operation: "document_get", key: id }, 404);
    await call({ operation: "document_delete", key: id }, 404);
    expect((await call(put)).document.version).toBe(3);
    await call({ ...put, value: 9, if_version: 1 }, 409);
  });

  it("paginates documents, objects and series with case-sensitive literal prefixes", async () => {
    const prefix = key("Page") + "/";
    for (const suffix of ["a", "b", "c"]) {
      await call({ operation: "document_put", key: prefix + suffix, value: suffix });
      await call(objectPut(prefix + suffix, suffix));
      await call({ operation: "timeseries_write", series: prefix + suffix, points: [{ timestamp_ms: 0, value: 1 }] });
    }
    for (const [operation, field, identity] of [["document_list", "documents", "key"], ["object_list", "objects", "key"], ["timeseries_list", "series", "series"]]) {
      const first = await call({ operation, prefix, limit: 2 });
      expect(first[field!].map((row: any) => row[identity!])).toEqual([prefix + "a", prefix + "b"]);
      const second = await call({ operation, prefix, cursor: first.next_cursor, limit: 2 });
      expect(second[field!].map((row: any) => row[identity!])).toEqual([prefix + "c"]);
      expect(second.next_cursor).toBeUndefined();
      expect((await call({ operation, prefix: prefix.replace("Page", "page") }))[field!]).toEqual([]);
      expect((await call({ operation, prefix: prefix + "%" }))[field!]).toEqual([]);
    }
  });

  it("returns a continuation when document bytes fill a page before its requested count", async () => {
    const prefix = key("large") + "/";
    for (let n = 0; n < 5; n++) {
      await call({ operation: "document_put", key: prefix + n, value: "x".repeat(250 * 1024) });
    }
    const first = await call({ operation: "document_list", prefix, limit: 1000 });
    expect(first.documents.length).toBeGreaterThan(0);
    expect(first.documents.length).toBeLessThan(5);
    const second = await call({ operation: "document_list", prefix, limit: 1000, cursor: first.next_cursor });
    expect(first.documents.length + second.documents.length).toBe(5);
    expect(second.next_cursor).toBeUndefined();
    console.log(`byte-bounded pagination: first=${first.documents.length}, second=${second.documents.length}, total=5`);
  });

  it("replays time-series ingestion, rolls back conflicting batches and aggregates", async () => {
    const series = key("heart-rate");
    const write = { operation: "timeseries_write", series, points: [
      { timestamp_ms: 1000, value: 60, fields: { source: "fixture" } },
      { timestamp_ms: 2000, value: 70 }, { timestamp_ms: 3000, value: 80 },
    ] };
    expect(await call(write)).toMatchObject({ inserted: 3, replayed: 0 });
    expect(await call(write)).toMatchObject({ inserted: 0, replayed: 3 });
    await call({ ...write, points: [{ timestamp_ms: 4000, value: 99 }, { timestamp_ms: 2000, value: 9 }] }, 409);
    expect((await call({ operation: "timeseries_query", series, start_ms: 4000 })).points).toEqual([]);
    expect(await call({ ...write, conflict: "replace", points: [{ timestamp_ms: 2000, value: 72 }] })).toMatchObject({ replaced: 1 });
    const first = await call({ operation: "timeseries_query", series, order: "desc", limit: 2 });
    expect(first.points.map((p: any) => p.timestamp_ms)).toEqual([3000, 2000]);
    const last = await call({ operation: "timeseries_query", series, order: "desc", cursor: first.next_cursor });
    expect(last.points.map((p: any) => p.timestamp_ms)).toEqual([1000]);
    expect((await call({ operation: "timeseries_aggregate", series, start_ms: 1000, end_ms: 3000, bucket_ms: 2000, aggregation: "avg" })).buckets)
      .toEqual([{ start_ms: 1000, value: 66, count: 2 }, { start_ms: 3000, value: 80, count: 1 }]);
  });

  it("round-trips R2 bytes and preserves versions across concurrent writes and recreation", async () => {
    const id = key("raw");
    const put = objectPut(id, "\ufefffixture");
    expect((await call(put)).object).toMatchObject({ version: 1, size_bytes: 10, unchanged: false });
    expect((await call({ operation: "object_get", key: id })).object.content).toBe("\ufefffixture");
    expect((await call(put)).object).toMatchObject({ version: 1, unchanged: true });
    await call({ operation: "object_get", key: id }, 404, "fixture-bob-both");
    const responses = await Promise.all(["left", "right"].map(content => request(objectPut(id, content, { if_version: 1 }))));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    console.log("concurrent R2 CAS: expected=[200,409] observed=" + responses.map(r => r.status));
    const bodies = await Promise.all(responses.map(r => r.json())) as any[];
    const winner = bodies.find(body => body.object)?.object;
    const read = await call({ operation: "object_get", key: id });
    expect(read.object.sha256).toBe(winner.sha256);
    expect(["left", "right"]).toContain(read.object.content);
    await call({ operation: "object_delete", key: id, if_version: 1 }, 409);
    await call({ operation: "object_delete", key: id, if_version: 2 });
    await call({ operation: "object_get", key: id }, 404);
    expect((await call(put)).object.version).toBe(3);
    await call({ ...put, if_version: 1 }, 409);
    await call({ ...put, sha256: "0".repeat(64) }, 400);
    await call({ ...put, content: "bad!", encoding: "base64" }, 400);
    const replay = objectPut(key("concurrent-replay"), "same bytes");
    const replayResponses = await Promise.all([request(replay), request(replay)]);
    expect(replayResponses.map(response => response.status)).toEqual([200, 200]);
    const replayBodies = await Promise.all(replayResponses.map(response => response.json())) as any[];
    expect(replayBodies.map(body => body.object.version)).toEqual([1, 1]);
    expect(replayBodies.map(body => body.object.unchanged).sort()).toEqual([false, true]);
    console.log("concurrent identical R2 retry: both HTTP 200, version=1, one unchanged receipt");
    const binary = key("binary");
    await call({ ...objectPut(binary, "/wAB"), encoding: "base64" });
    await call({ operation: "object_get", key: binary }, 400);
    expect((await call({ operation: "object_get", key: binary, encoding: "base64" })).object.content).toBe("/wAB");
  });

  it("cleans superseded and deleted R2 payloads while retaining the live version", async () => {
    const id = key("cleanup");
    const scope = bindings.NANOCODEX_USER_DATA.getByName("user-data-fixture-alice");
    const physicalKey = () => runInDurableObject(scope, async (_instance, state) =>
      state.storage.sql.exec<{ r2_key: string }>("SELECT r2_key FROM user_objects WHERE key = ?", id).toArray()[0]!.r2_key);
    await call(objectPut(id, "old"));
    const oldKey = await physicalKey();
    await call(objectPut(id, "current"));
    const liveKey = await physicalKey();
    expect(liveKey).not.toBe(oldKey);
    // Cleanup is intentionally invisible over HTTP. The narrow integration hook
    // advances only its deadline; alarm and R2 deletion run as shipped.
    await runInDurableObject(scope, async (_instance, state) => {
      state.storage.sql.exec("UPDATE user_object_gc SET due_at_ms = 0");
    });
    expect(await runDurableObjectAlarm(scope)).toBe(true);
    expect(await bindings.NANOCODEX_USER_DATA_OBJECTS.head(oldKey)).toBeNull();
    expect(await bindings.NANOCODEX_USER_DATA_OBJECTS.head(liveKey)).not.toBeNull();
    expect((await call({ operation: "object_get", key: id })).object.content).toBe("current");
    await call({ operation: "object_delete", key: id });
    await runInDurableObject(scope, async (_instance, state) => {
      state.storage.sql.exec("UPDATE user_object_gc SET due_at_ms = 0");
    });
    expect(await runDurableObjectAlarm(scope)).toBe(true);
    await call({ operation: "object_get", key: id }, 404);
    await runInDurableObject(scope, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM user_object_gc").toArray()[0]?.count).toBe(0);
    });
    expect(await bindings.NANOCODEX_USER_DATA_OBJECTS.head(liveKey)).toBeNull();
    console.log("R2 cleanup: superseded payload absent, live payload readable, deleted payload absent after alarm");
  });

  it("fails closed on missing or corrupt R2 bytes and recovers through public operations", async () => {
    const id = key("integrity");
    const scope = bindings.NANOCODEX_USER_DATA.getByName("user-data-fixture-alice");
    const physicalKey = () => runInDurableObject(scope, async (_instance, state) =>
      state.storage.sql.exec<{ r2_key: string }>("SELECT r2_key FROM user_objects WHERE key = ?", id).toArray()[0]!.r2_key);
    await call(objectPut(id, "original"));
    const stored = await physicalKey();
    // Corruption cannot be requested over HTTP. Mutate only the backing bytes;
    // public reads still execute the shipped digest and availability checks.
    await bindings.NANOCODEX_USER_DATA_OBJECTS.put(stored, "corrupt");
    expect(await call({ operation: "object_get", key: id }, 500)).toEqual({
      error: "user_data_failed", message: "data service is temporarily unavailable",
    });
    await bindings.NANOCODEX_USER_DATA_OBJECTS.delete(stored);
    await call({ operation: "object_get", key: id }, 500);
    await call({ operation: "object_delete", key: id, if_version: 1 });
    expect((await call(objectPut(id, "recovered"))).object.version).toBe(2);
    expect((await call({ operation: "object_get", key: id })).object.content).toBe("recovered");
    console.log("R2 integrity: corruption and missing bytes produce HTTP 500; delete/recreate restores readable version 2");
  });

  it("returns actionable malformed/bounded-input errors then recovers", async () => {
    const id = key("bounds");
    const malformed = await SELF.fetch("https://data.example/v1/data", {
      method: "POST", headers: { authorization: "Bearer fixture-alice-both" }, body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid_json" });
    await call({ operation: "document_put", key: id, value: "x".repeat(256 * 1024) }, 413);
    await call(objectPut(id, "x".repeat(1024 * 1024 + 1)), 413);
    const oversized = await SELF.fetch("https://data.example/v1/data", {
      method: "POST", headers: { authorization: "Bearer fixture-alice-both" }, body: " ".repeat(2 * 1024 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "payload_too_large" });
    await call({ operation: "document_put", key: id, value: JSON.parse("[".repeat(34) + "0" + "]".repeat(34)) }, 400);
    await call({ operation: "timeseries_aggregate", series: id, start_ms: 0, end_ms: 1000, bucket_ms: 1, aggregation: "avg" }, 400);
    await call({ operation: "timeseries_write", series: id, points: [{ timestamp_ms: 1, value: 1e308 }, { timestamp_ms: 2, value: 1e308 }] });
    await call({ operation: "timeseries_aggregate", series: id, start_ms: 0, end_ms: 10, bucket_ms: 10, aggregation: "sum" }, 400);
    await call({ operation: "document_get", key: "../secret" }, 400);
    await call({ operation: "timeseries_query", series: id, cursor: "9007199254740992" }, 400);
    await call({ operation: "document_put", key: id, value: { recovered: true } });
    expect((await call({ operation: "document_get", key: id })).document.value).toEqual({ recovered: true });
    console.log("bounded request stream: expected=413 observed=" + oversized.status);
  });

  it("runs the agent tool against HTTP and enforces its active capability", async () => {
    const id = key("tool");
    let canWrite = true;
    const tool = userDataTool({
      requireCapability: capability => { if (capability === "data:write" && !canWrite) throw new Error("forbidden"); },
      execute: operation => call(operation),
    });
    const context = { callId: "fixture", parentCallId: "root", sessionId: crypto.randomUUID(), model: "test", signal: new AbortController().signal };
    await expect(tool.handler({ operation: "document_put", key: id, value: 42 }, context)).resolves.toMatchObject({ document: { value: 42 } });
    canWrite = false;
    await expect(tool.handler({ operation: "document_put", key: id, value: 43 }, context)).rejects.toThrow("forbidden");
    await expect(tool.handler({ operation: "document_get", key: id }, context)).resolves.toMatchObject({ document: { value: 42 } });
  });
});
