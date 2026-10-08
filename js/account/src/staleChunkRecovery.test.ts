import assert from "node:assert/strict";
import { test } from "node:test";
import { installStaleChunkRecovery } from "./staleChunkRecovery.ts";

function harness(stored?: string) {
  const listeners: Record<string, (event: Event) => void> = {};
  const storage = new Map<string, string>(stored ? [["nanocodex:stale-chunk-reload", stored]] : []);
  let reloads = 0;
  const target = {
    addEventListener: (type: string, listener: (event: Event) => void) => { listeners[type] = listener; },
    location: { reload: () => { reloads += 1; } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
  };
  return { target: target as never, fire: () => { const event = new Event("vite:preloadError", { cancelable: true }); listeners["vite:preloadError"]!(event); return event; }, reloads: () => reloads, storage };
}

test("a stale chunk after a deploy reloads the tab once", () => {
  const h = harness();
  installStaleChunkRecovery(h.target, () => 1_000_000);
  const event = h.fire();
  assert.equal(h.reloads(), 1);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.storage.get("nanocodex:stale-chunk-reload"), "1000000");
});

test("a repeated chunk failure right after a reload surfaces instead of looping", () => {
  const h = harness("1000000");
  installStaleChunkRecovery(h.target, () => 1_030_000);
  const event = h.fire();
  assert.equal(h.reloads(), 0);
  assert.equal(event.defaultPrevented, false);
});

test("a later stale build reloads again", () => {
  const h = harness("1000000");
  installStaleChunkRecovery(h.target, () => 1_000_000 + 61_000);
  h.fire();
  assert.equal(h.reloads(), 1);
});
