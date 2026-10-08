/** Cloudflare hints affect only first use and never change object identity.
 * Hints are best effort, not jurisdiction or execution-colo assertions.
 * https://developers.cloudflare.com/durable-objects/reference/data-location/ */
const TRUSTED_INGRESS_HEADER = "x-nanocodex-placement-colo";
const COLOS = {
  SFO: "wnam",
  SJC: "wnam",
  LAX: "wnam",
  SEA: "wnam",
  PDX: "wnam",
  PHX: "wnam",
  DEN: "wnam",
  LAS: "wnam",
  SLC: "wnam",
  IAD: "enam",
  EWR: "enam",
  BOS: "enam",
  ATL: "enam",
  ORD: "enam",
  MIA: "enam",
  LHR: "weur",
  CDG: "weur",
  FRA: "weur",
  AMS: "weur",
  MXP: "weur",
  MAD: "weur",
  DUB: "weur",
  ZRH: "weur",
  WAW: "eeur",
  OTP: "eeur",
  ATH: "eeur",
  SIN: "apac",
  NRT: "apac",
  HKG: "apac",
  SYD: "oc",
  MEL: "oc",
  AKL: "oc",
  GRU: "sam",
  SCL: "sam",
  EZE: "sam"
};
function ingressColo(value) {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}
function placementRegion(value) {
  const colo = ingressColo(value);
  return colo === null ? void 0 : COLOS[colo];
}
function durablePlacementOptions(colo) {
  const locationHint = placementRegion(colo);
  return locationHint ? { locationHint } : void 0;
}
/** Replace any caller assertion with platform or retained Session metadata. */
function placementHeaders(headers, colo) {
  const result = new Headers(headers);
  result.delete(TRUSTED_INGRESS_HEADER);
  const trusted = ingressColo(colo);
  if (trusted) result.set(TRUSTED_INGRESS_HEADER, trusted);
  return result;
}
/** Scope a request-local env only; never replace a retained DO env or its
 * discovery-cache/model-transport binding identities. */
function withIngressPlacement(env, colo) {
  const trustedClientIngressColo = ingressColo(colo);
  const binding = env.NANOCODEX;
  return { ...env, trustedClientIngressColo, ...binding ? {
    NANOCODEX: {
      fetch(input, init) {
        const request = new Request(input, init);
        return binding.fetch(new Request(request, { headers: placementHeaders(request.headers, trustedClientIngressColo) }));
      }
    }
  } : {} };
}
/** Regions with an ingress-local API-key lease replica. Names are routing,
 * never authority: a replica verifies its own binding before answering. */
const REGIONAL_API_KEY_AUTHORITY_REGIONS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc"];
const REGIONAL_API_KEY_AUTHORITY_NAME = /^api-key-authority:v1:(wnam|enam|sam|weur|eeur|apac|oc):[0-9a-f]{64}$/;
function isRegionalApiKeyAuthorityRegion(value) {
  return typeof value === "string" && REGIONAL_API_KEY_AUTHORITY_REGIONS.includes(value);
}
function regionalApiKeyAuthorityName(primaryObjectId, region) {
  return `api-key-authority:v1:${region}:${primaryObjectId}`;
}
function isRegionalApiKeyAuthorityName(value) {
  return typeof value === "string" && REGIONAL_API_KEY_AUTHORITY_NAME.test(value);
}
/** Trusted ingress colo only; any value other than "true" keeps the primary route. */
function regionalApiKeyAuthorityRegion(colo, enabled) {
  if (enabled !== "true") return void 0;
  const region = placementRegion(colo);
  return isRegionalApiKeyAuthorityRegion(region) ? region : void 0;
}
export {
  REGIONAL_API_KEY_AUTHORITY_REGIONS,
  TRUSTED_INGRESS_HEADER,
  durablePlacementOptions,
  ingressColo,
  isRegionalApiKeyAuthorityName,
  isRegionalApiKeyAuthorityRegion,
  placementHeaders,
  placementRegion,
  regionalApiKeyAuthorityName,
  regionalApiKeyAuthorityRegion,
  withIngressPlacement
};
