import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { type Env, DurableAgentSession } from "../src/index";
import { performanceState } from "../src/performance";

it("preserves native SQL cursors, receivers, bindings and transaction rollback while auditing", async () => {
  const sessions = (env as unknown as Env).NANOCODEX_SESSIONS as DurableObjectNamespace<DurableAgentSession>;
  await runInDurableObject(sessions.getByName(crypto.randomUUID()), async (_instance, original) => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(() => new DurableAgentSession(original, { ...env, NANOCODEX_PERFORMANCE_TRACE: "true" } as unknown as Env)).not.toThrow();
      const state = performanceState(original);
      state.storage.sql.exec("CREATE TABLE audit_test (id INTEGER PRIMARY KEY, value TEXT)");
      state.storage.sql.exec("INSERT INTO audit_test VALUES (?, ?)", 1, "private-binding");
      expect(state.storage.sql.exec("SELECT * FROM audit_test").one()).toEqual({ id: 1, value: "private-binding" });
      expect([...state.storage.sql.exec("SELECT id FROM audit_test")]).toEqual([{ id: 1 }]);
      expect(state.storage.sql.exec("SELECT id FROM audit_test").toArray()).toEqual([{ id: 1 }]);
      expect([...state.storage.sql.exec("SELECT id FROM audit_test").raw()]).toEqual([[1]]);
      expect(() => state.storage.transactionSync(() => {
        state.storage.sql.exec("INSERT INTO audit_test VALUES (2, 'private-literal')");
        throw Error("rollback");
      })).toThrow("rollback");
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM audit_test").one().n).toBe(1);
      await state.storage.put("audit-key", "value");
      expect(await state.storage.get("audit-key")).toBe("value");
      await Promise.resolve();
      const records = logs.mock.calls.map(call => call[0]).filter(record => record?.type === "managed.sql_batch")
        .flatMap(record => record.statements).filter(record => record.tables.includes("audit_test"));
      expect(records.reduce((sum, record) => sum + record.count, 0)).toBe(8);
      expect(records.some(record => record.rows_read > 0)).toBe(true);
      expect(records.some(record => record.rows_written > 0)).toBe(true);
      expect(JSON.stringify(records)).not.toContain("private-binding");
      expect(JSON.stringify(records)).not.toContain("private-literal");
    } finally { logs.mockRestore(); await original.storage.deleteAlarm(); }
  });
});
