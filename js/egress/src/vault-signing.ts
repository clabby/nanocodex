/** Broker-only signing. Neither key material nor generated credentials leave this module
 * except as substitutions for the final outbound request. Never include caught crypto
 * errors in responses or diagnostics: implementations may quote their input. */
export type VaultSigning = Readonly<{
  algorithm: "HMAC-SHA256" | "HMAC-SHA512" | "RS256" | "ES256" | "EdDSA";
  message?: string;
  jwt?: Readonly<{ header: Record<string, unknown>; payload: Record<string, unknown> }>;
  encoding?: "hex" | "base64" | "base64url";
  key_encoding?: "utf8" | "base64" | "hex" | "pkcs8";
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateVaultSigning(value: unknown): VaultSigning {
  if (!record(value)
    || Object.keys(value).some(key => !["algorithm", "message", "jwt", "encoding", "key_encoding"].includes(key))
    || typeof value.algorithm !== "string"
    || !["HMAC-SHA256", "HMAC-SHA512", "RS256", "ES256", "EdDSA"].includes(String(value.algorithm))
    || (Object.hasOwn(value, "message") === Object.hasOwn(value, "jwt"))
    || (Object.hasOwn(value, "message") && typeof value.message !== "string")
    || (value.encoding !== undefined && (typeof value.encoding !== "string" || !["hex", "base64", "base64url"].includes(value.encoding)))
    || (value.key_encoding !== undefined && (typeof value.key_encoding !== "string" || !["utf8", "base64", "hex", "pkcs8"].includes(value.key_encoding)))
    || JSON.stringify(value).includes("NANOCODEX_VAULT_")) throw new Error("invalid signing request");
  const hmac = String(value.algorithm).startsWith("HMAC-");
  if ((hmac && value.key_encoding === "pkcs8") || (!hmac && value.key_encoding === "utf8")) {
    throw new Error("invalid signing request");
  }
  if (Object.hasOwn(value, "jwt")) {
    if (hmac || !record(value.jwt) || Object.keys(value.jwt).length !== 2
      || !record(value.jwt.header) || !record(value.jwt.payload)
      || (value.jwt.header.alg !== undefined && value.jwt.header.alg !== value.algorithm)
      || Object.hasOwn(value.jwt.header, "crit") || Object.hasOwn(value.jwt.header, "b64")
      || (value.encoding !== undefined && value.encoding !== "base64url")) {
      throw new Error("invalid signing request");
    }
  }
  return value as VaultSigning;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encoded(bytes: Uint8Array, encoding: VaultSigning["encoding"]): string {
  if (encoding === "hex") return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const value = base64(bytes);
  return encoding === "base64" ? value : value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function keyBytes(value: string, encoding: VaultSigning["key_encoding"]): Uint8Array<ArrayBuffer> {
  if (encoding === "utf8") return new Uint8Array(new TextEncoder().encode(value));
  if (encoding === "hex") {
    if (!/^(?:[a-fA-F0-9]{2})+$/.test(value)) throw new Error("invalid signing key");
    return Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16));
  }
  let data = value;
  if (encoding === "pkcs8") {
    const pem = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----\s*$/.exec(value);
    if (!pem) throw new Error("invalid signing key");
    data = pem[1].replace(/\s/g, "");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || !data) {
    throw new Error("invalid signing key");
  }
  const binary = atob(data);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export async function signVaultRequest(keyValue: string, signing: VaultSigning): Promise<string> {
  const hmac = signing.algorithm.startsWith("HMAC-");
  const bytes = keyBytes(keyValue, signing.key_encoding ?? (hmac ? "utf8" : "pkcs8"));
  const algorithm = hmac ? { name: "HMAC", hash: signing.algorithm === "HMAC-SHA256" ? "SHA-256" : "SHA-512" }
    : signing.algorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
    : signing.algorithm === "ES256" ? { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }
    : { name: "Ed25519" };
  const key = await crypto.subtle.importKey(hmac ? "raw" : "pkcs8", bytes, algorithm, false, ["sign"]);
  const jwt = signing.jwt;
  const message = jwt
    ? encoded(new TextEncoder().encode(JSON.stringify({ ...jwt.header, alg: signing.algorithm })), "base64url")
      + "." + encoded(new TextEncoder().encode(JSON.stringify(jwt.payload)), "base64url")
    : signing.message!;
  const signature = encoded(new Uint8Array(await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(message))), signing.encoding);
  return jwt ? `${message}.${signature}` : signature;
}

/** Substitutions operate on values, then serialization escapes all injected bytes.
 * Keys are deliberately immutable. This also validates templates before resolution. */
export function transformVaultBody(
  body: string,
  encoding: "raw" | "json" | "form",
  substitute: (value: string) => string,
): string {
  if (encoding === "raw") return substitute(body);
  const checkKey = (key: string) => {
    if (key.includes("NANOCODEX_VAULT_")) throw new Error("invalid body key");
  };
  if (encoding === "form") {
    // URLSearchParams alone accepts malformed percent escapes; reject those first.
    for (const part of body.split("&")) decodeURIComponent(part.replaceAll("+", " "));
    const form = new URLSearchParams();
    for (const [key, value] of new URLSearchParams(body)) {
      checkKey(key);
      form.append(key, substitute(value));
    }
    return form.toString();
  }
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 64) throw new Error("invalid body depth");
    if (typeof value === "string") return substitute(value);
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      checkKey(key);
      return [key, visit(item, depth + 1)];
    }));
    return value;
  };
  return JSON.stringify(visit(JSON.parse(body), 0));
}
