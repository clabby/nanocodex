import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(root, "output/native-enrollment");
const path = "/.well-known/nanocodex-native-input";
const command = "node --test js/managed/test/native-input-discovery-journey.test.mjs";
const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });

// Run both shipped Worker entrypoints over loopback HTTP and a real workerd
// service binding. Synthetic bindings are configured by the test controller;
// no production test hooks, enrollment state, credentials or privileged helpers.
async function bundle(entry) {
  const assets = [];
  const result = await build({
    entryPoints: [resolve(root, entry)], bundle: true, write: false, metafile: true,
    format: "esm", platform: "node", conditions: ["workerd"], target: "es2022",
    external: ["cloudflare:*", "node:*"],
    alias: { "node-rsa": resolve(root, "js/nanocodex/tools/browser/unsupportedNodeRsa.mjs") },
    banner: { js: 'import { createRequire } from "node:module"; const require=createRequire("/worker.mjs");' },
    plugins: [{ name: "wasm", setup(builder) {
      builder.onResolve({ filter: /\.wasm(?:\?module)?$/ }, async args => {
        const contents = await readFile(resolve(args.resolveDir, args.path.replace(/\?module$/, "")));
        const name = `asset-${assets.length}.wasm`;
        assets.push({ type: "CompiledWasm", path: name, contents });
        return { path: `./${name}`, external: true };
      });
    } }], logLevel: "silent",
  });
  return { modules: [{ type: "ESModule", path: "worker.mjs", contents: result.outputFiles[0].text }, ...assets],
    inputs: Object.keys(result.metafile.inputs) };
}

test("public native enrollment metadata: account -> managed HTTP, strict keys and unchanged private authority", { timeout: 120_000 }, async () => {
  await mkdir(output, { recursive: true });
  const trace = [];
  const [account, managed] = await Promise.all([bundle("js/account/worker/index.ts"), bundle("js/managed/src/index.ts")]);
  await writeFile(resolve(output, "bundle-inputs.json"), JSON.stringify({ account: account.inputs, managed: managed.inputs }, null, 2));
  const valid = key(), other = key();
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(valid.x, "base64url"), Buffer.from(valid.y, "base64url")]);
  const expected = { protocol: "nanocodex-secure-sudo", version: 1,
    approval_public_key: raw.toString("base64"), approval_public_key_sha256: createHash("sha256").update(raw).digest("hex") };
  const privateMarkers = [valid.d, other.d, "synthetic-private-echo-marker"];
  const compatibility = { compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat", "enable_request_signal"] };
  let mf, base;
  function options(signingKey, { backend = true, accountKey = JSON.stringify(other) } = {}) {
    return { port: base ? Number(base.port) : 0, workers: [
      { name: "account", ...compatibility, modules: account.modules,
        bindings: { ENVIRONMENT: "development", NATIVE_SECURE_INPUT_SIGNING_KEY: accountKey },
        serviceBindings: backend ? { NANOCODEX_BACKEND: "managed" } : {} },
      { name: "managed", ...compatibility, modules: managed.modules, unsafeDirectSockets: [{ host: "127.0.0.1", port: 0 }],
        bindings: { ...(signingKey === undefined ? {} : { NATIVE_SECURE_INPUT_SIGNING_KEY: signingKey }),
          NATIVE_SECURE_INPUT_HELPERS: "synthetic-private-echo-marker" } },
    ] };
  }
  async function configure(signingKey, config) { await mf.setOptions(options(signingKey, config)); }
  async function request(label, suffix = path, { method = "GET", headers, body, status = 200, json = expected, direct = false } = {}) {
    // Both workers receive actual network HTTP; direct backend uses a separate
    // loopback listener, so method/body handling is exercised by workerd too.
    const origin = direct ? await mf.unsafeGetDirectURL("managed") : base;
    // node:http preserves a bare trailing "?" that fetch clients normalize away.
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: origin.hostname, port: origin.port, path: suffix,
        method, headers, agent: false, signal: AbortSignal.timeout(10_000) }, incoming => {
        const chunks = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("end", () => resolve(new Response(chunks.length ? Buffer.concat(chunks) : null,
          { status: incoming.statusCode, headers: incoming.headers })));
        incoming.on("error", reject);
      });
      request.on("error", reject);
      request.end(body);
    });
    const text = await response.text();
    for (const marker of privateMarkers) assert.ok(!text.includes(marker) && !JSON.stringify([...response.headers]).includes(marker), `${label}: private data escaped`);
    trace.push({ label, target: direct ? "managed" : "account", method, path: suffix, expectedStatus: status,
      status: response.status, body: text, cacheControl: response.headers.get("cache-control"), allow: response.headers.get("allow") });
    assert.equal(response.status, status, `${label}: ${text}`);
    if (suffix.startsWith(path) && suffix !== path + "/" && suffix !== path + "-other" && status !== 403) {
      assert.equal(response.headers.get("cache-control"), "no-store", label);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
    }
    if (method === "HEAD") assert.equal(text, "");
    else if (json !== false) assert.deepEqual(JSON.parse(text), json, label);
    if (status === 405) assert.equal(response.headers.get("allow"), "GET");
    return response;
  }
  try {
    mf = new Miniflare(options(JSON.stringify(valid)));
    base = await mf.ready;
    await request("anonymous public metadata; account key ignored");
    await request("backend public metadata", path, { direct: true });
    await request("caller key and authority headers do not select metadata", path, { headers: {
      authorization: "Bearer synthetic-irrelevant", cookie: "synthetic-private-echo-marker",
      "x-nanocodex-owner-id": "forged-owner", "x-nanocodex-connect-user": "forged-user",
      "x-nanocodex-native-input-key": JSON.stringify(other), origin: "https://untrusted.example",
    } });
    for (const direct of [false, true]) {
      for (const suffix of [path + "/", path + "-other"]) {
        await request("discovery requires exact path", suffix, { direct, status: 404, json: false });
      }
      for (const suffix of ["?key=synthetic-private-echo-marker", "?", "?version=1"]) {
        await request("queries rejected", path + suffix, { direct, status: 400, json: { error: "invalid_request" } });
      }
      for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
        await request("read-only method contract", path, { direct, method, status: 405,
          ...(method === "POST" ? { body: "synthetic-private-echo-marker" } : {}), json: { error: "method_not_allowed" } });
      }
      await request("private approval still requires account authority", "/v1/agents/11111111-1111-4111-8111-111111111111/native-secure-input", {
        direct, method: "POST", body: JSON.stringify({ request_id: "synthetic", action: "describe" }),
        headers: { "content-type": "application/json" }, status: 401, json: { error: "unauthorized" },
      });
    }
    await request("inference bearer retains original scope denial", path, {
      headers: { authorization: "Bearer nci_synthetic" }, status: 403, json: { error: "inference_key_scope" },
    });
    const invalid = [
      ["unconfigured", undefined], ["empty", ""], ["malformed JSON", "synthetic-private-echo-marker{"],
      ["null", "null"], ["public key only", JSON.stringify({ kty: "EC", crv: "P-256", x: valid.x, y: valid.y })],
      ["wrong curve", JSON.stringify({ ...valid, crv: "P-384" })],
      ["wrong type", JSON.stringify({ ...valid, kty: "RSA" })],
      ["bad coordinate", JSON.stringify({ ...valid, x: "synthetic-private-echo-marker" })],
      ["noncanonical scalar", JSON.stringify({ ...valid, d: valid.d + "=" })],
      ["incompatible key usage", JSON.stringify({ ...valid, key_ops: ["verify"] })],
      ["incompatible algorithm", JSON.stringify({ ...valid, alg: "ES384" })],
      ["private scalar out of range", JSON.stringify({ ...valid, d: Buffer.alloc(32, 255).toString("base64url") })],
      ["zero scalar", JSON.stringify({ ...valid, d: Buffer.alloc(32).toString("base64url") })],
      ["invalid point", JSON.stringify({ ...valid, x: Buffer.alloc(32).toString("base64url"), y: Buffer.alloc(32).toString("base64url") })],
      ["inconsistent private/public pair", JSON.stringify({ ...valid, d: other.d })],
      ["oversized", JSON.stringify(valid) + " ".repeat(4096)],
    ];
    for (const [label, configured] of invalid) {
      await configure(configured);
      for (const direct of [false, true]) await request(label, path, { direct, status: 503, json: { error: "native_input_unavailable" } });
    }
    await configure(JSON.stringify(valid), { backend: false });
    await request("missing backend fails closed despite account key", path, { status: 503, json: { error: "native_input_unavailable" } });
    await configure(JSON.stringify(valid));
    await request("valid configuration recovers");
  } finally {
    await writeFile(resolve(output, "journey.json"), JSON.stringify({ command, trace }, null, 2));
    await mf?.dispose();
  }
});
