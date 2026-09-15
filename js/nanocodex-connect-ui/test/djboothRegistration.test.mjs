import assert from "node:assert/strict";
import test from "node:test";
import { registeredApp } from "nanocodex-connect-ui/connectPolicy.mjs";

test("DJ Booth registration binds the music app to its exact cloud origin", () => {
  const origin = "https://djbooth-library.gakonst.workers.dev";
  const dialog = "https://nanocodex.gakonst.workers.dev/connect-dialog/";
  assert.deepEqual(registeredApp(origin, "djbooth", dialog, false), {
    id: "djbooth", name: "DJ Booth", origin,
  });
  assert.throws(() => registeredApp(origin, "atlas-workspace", dialog, false), /does not match/);
  assert.throws(() => registeredApp("https://djbooth-library.gakonst.workers.dev.attacker.example", "djbooth", dialog, false), /not registered/);
});
