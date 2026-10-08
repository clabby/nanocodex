import assert from "node:assert/strict";
import test from "node:test";
import { durablePlacementOptions, withIngressPlacement, TRUSTED_INGRESS_HEADER, regionalApiKeyAuthorityName, regionalApiKeyAuthorityRegion, isRegionalApiKeyAuthorityName, isRegionalApiKeyAuthorityRegion } from "nanocodex/cloudflare/durable-placement";

test("public placement API preserves regions and rejects unknown placement", async () => {
  assert.deepEqual(durablePlacementOptions("SJC"), { locationHint: "wnam" });
  assert.deepEqual(durablePlacementOptions("LHR"), { locationHint: "weur" });
  assert.equal(durablePlacementOptions("ZZZ"), undefined);
  assert.equal(durablePlacementOptions("sjc"), undefined);
  const requests = [];
  const original = { NANOCODEX: { fetch: async request => { requests.push(request); return new Response(); } } };
  for (const colo of ["SJC", null]) {
    const scoped = withIngressPlacement(original, colo);
    await scoped.NANOCODEX.fetch("https://broker.internal/users/fixture/wallet", { headers: { [TRUSTED_INGRESS_HEADER]: "NRT" } });
  }
  assert.deepEqual(requests.map(request => request.headers.get(TRUSTED_INGRESS_HEADER)), ["SJC", null]);
  assert.equal(original.trustedClientIngressColo, undefined);
});

test("regional API-key authority routing is opt-in and names exactly one primary and region", () => {
  const primary = "a".repeat(64);
  assert.equal(regionalApiKeyAuthorityRegion("LAX", "true"), "wnam");
  assert.equal(regionalApiKeyAuthorityRegion("VIE", "true"), undefined);
  assert.equal(regionalApiKeyAuthorityRegion("LAX", "1"), undefined);
  assert.equal(regionalApiKeyAuthorityRegion("LAX", undefined), undefined);
  assert.equal(regionalApiKeyAuthorityRegion("lax", "true"), undefined);
  assert.equal(regionalApiKeyAuthorityName(primary, "wnam"), `api-key-authority:v1:wnam:${primary}`);
  assert.equal(isRegionalApiKeyAuthorityName(regionalApiKeyAuthorityName(primary, "oc")), true);
  assert.equal(isRegionalApiKeyAuthorityName(`api-key-authority:v1:mars:${primary}`), false);
  assert.equal(isRegionalApiKeyAuthorityName(`api-key-authority:v1:wnam:${primary}x`), false);
  assert.equal(isRegionalApiKeyAuthorityRegion("weur"), true);
  assert.equal(isRegionalApiKeyAuthorityRegion("WEUR"), false);
});
