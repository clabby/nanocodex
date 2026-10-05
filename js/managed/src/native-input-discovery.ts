/** Public enrollment metadata only; private keys and validation errors never leave this route. */
const PATH = "/.well-known/nanocodex-native-input";
const probe = new TextEncoder().encode("nanocodex-native-input-discovery-key-pair-check-v1");
const unavailable = () => response({ error: "native_input_unavailable" }, 503);
function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: {
    "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers,
  } });
}
function coordinate(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error();
  const bytes = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  if (bytes.length !== 32 || btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== value) throw new Error();
  return value;
}
export async function routeNativeInputDiscovery(
  request: Request, env: { NATIVE_SECURE_INPUT_SIGNING_KEY?: string }, url = new URL(request.url),
): Promise<Response | undefined> {
  if (url.pathname !== PATH) return undefined;
  if (request.method !== "GET") return response({ error: "method_not_allowed" }, 405, { allow: "GET" });
  if (url.href.includes("?")) return response({ error: "invalid_request" }, 400);
  try {
    const configured = env.NATIVE_SECURE_INPUT_SIGNING_KEY;
    if (!configured || configured.length > 4096) return unavailable();
    const jwk = JSON.parse(configured);
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk) || jwk.kty !== "EC" || jwk.crv !== "P-256") return unavailable();
    const publicJwk = { kty: "EC", crv: "P-256", x: coordinate(jwk.x), y: coordinate(jwk.y) };
    coordinate(jwk.d);
    // Keep JWK usage restrictions: discovery must not accept a key the signer rejects.
    const privateKey = await crypto.subtle.importKey("jwk", jwk,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("jwk", publicJwk,
      { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    // Import alone can accept inconsistent private/public JWK components.
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, probe);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, probe)) return unavailable();
    const exported = await crypto.subtle.exportKey("raw", publicKey);
    if (!(exported instanceof ArrayBuffer)) return unavailable();
    const raw = new Uint8Array(exported);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    return response({
      protocol: "nanocodex-secure-sudo", version: 1,
      approval_public_key: btoa(String.fromCharCode(...raw)),
      approval_public_key_sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join(""),
    });
  } catch { return unavailable(); }
}
