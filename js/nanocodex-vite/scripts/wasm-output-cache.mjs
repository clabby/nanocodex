// Uses only Node built-ins; no Python, Rust, or pnpm setup needed.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertCachedManagedWasmAttestation, hashManagedWasmArtifacts } from "../../nanocodex/scripts/check-managed-wasm.mjs";

export const rustToolchain = "1.97";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const metadataPath = ".ci-wasm-cache/outputs.json";
const rawPath = ".ci-wasm-cache/source.wasm";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const excluded = new Set([".git", "target", "node_modules", "pkg-web", "pkg-node"]);

async function walk(directory, skipStandaloneTests = false) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || (skipStandaloneTests && ["tests", "benches"].includes(entry.name))) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile() || entry.isSymbolicLink()) result.push(path);
  }
  return result;
}

// Strict TOML 1.0 reader for Cargo manifests. Invalid documents and
// unsupported values (date-times) throw instead of approximating the grammar.
export function parseToml(text) {
  const root = Object.create(null);
  const headed = new WeakSet(); // defined by [header] or [[header]]
  const dotted = new WeakSet(); // defined by a dotted key
  const frozen = new WeakSet(); // inline tables and value arrays
  const control = /[\x00-\x08\x0a-\x1f\x7f]/;
  let position = 0;
  const fail = (message) => {
    throw new SyntaxError(`invalid TOML: ${message} at line ${text.slice(0, position).split("\n").length}`);
  };
  const spaces = () => { while (text[position] === " " || text[position] === "\t") position++; };
  const newline = () => {
    if (text[position] === "\n") position++;
    else if (text[position] === "\r" && text[position + 1] === "\n") position += 2;
    else return false;
    return true;
  };
  const comment = () => {
    if (text[position] !== "#") return;
    for (position++; position < text.length && text[position] !== "\n"; position++) {
      if (control.test(text[position]) && text[position] !== "\t" && !(text[position] === "\r" && text[position + 1] === "\n")) fail("control character in comment");
    }
  };
  const blank = () => { do { spaces(); comment(); } while (newline()); };
  const endOfLine = () => { spaces(); comment(); if (position < text.length && !newline()) fail("expected end of line"); };
  const escape = () => {
    const character = text[position++];
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" }[character];
    if (simple !== undefined) return simple;
    const length = character === "u" ? 4 : character === "U" ? 8 : fail("invalid escape");
    const digits = text.slice(position, position + length);
    if (!/^[0-9A-Fa-f]+$/.test(digits) || digits.length !== length) fail("invalid unicode escape");
    position += length;
    const code = Number.parseInt(digits, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail("invalid unicode scalar");
    return String.fromCodePoint(code);
  };
  const string = (allowMultiline) => {
    const quote = text[position];
    const literal = quote === "'";
    if (text.startsWith(quote.repeat(3), position)) {
      if (!allowMultiline) fail("multi-line string key");
      position += 3;
      newline();
      let value = "";
      for (;;) {
        if (position >= text.length) fail("unterminated multi-line string");
        if (text.startsWith(quote.repeat(3), position)) {
          let extra = 0;
          while (extra < 2 && text[position + 3 + extra] === quote) extra++;
          position += 3 + extra;
          return value + quote.repeat(extra);
        }
        if (newline()) { value += "\n"; continue; }
        if (!literal && text[position] === "\\") {
          const start = ++position;
          spaces();
          if (newline()) {
            while (text[position] === " " || text[position] === "\t" || newline()) if (text[position] === " " || text[position] === "\t") position++;
            continue;
          }
          position = start;
          value += escape();
          continue;
        }
        if (control.test(text[position]) && text[position] !== "\t") fail("control character in string");
        value += text[position++];
      }
    }
    let value = "";
    for (position++; ;) {
      const character = text[position++];
      if (character === quote) return value;
      if (character === undefined || character === "\n" || character === "\r") fail("unterminated string");
      if (!literal && character === "\\") value += escape();
      else if (control.test(character) && character !== "\t") fail("control character in string");
      else value += character;
    }
  };
  const key = () => {
    const parts = [];
    for (;;) {
      spaces();
      if (text[position] === '"' || text[position] === "'") parts.push(string(false));
      else {
        const start = position;
        while (/[A-Za-z0-9_-]/.test(text[position] ?? "")) position++;
        if (start === position) fail("expected key");
        parts.push(text.slice(start, position));
      }
      spaces();
      if (text[position] !== ".") return parts;
      position++;
    }
  };
  // Returns the table stored at table[name], creating it when absent.
  const child = (table, name) => {
    if (!Object.hasOwn(table, name)) table[name] = Object.create(null);
    let next = table[name];
    if (Array.isArray(next) && !frozen.has(next)) next = next.at(-1);
    if (next === null || typeof next !== "object" || Array.isArray(next)) fail(`key ${name} is not a table`);
    if (frozen.has(next)) fail(`cannot extend inline table ${name}`);
    return next;
  };
  const value = () => {
    const character = text[position];
    if (character === '"' || character === "'") return string(true);
    if (character === "[") {
      const array = [];
      frozen.add(array);
      for (position++; ;) {
        blank();
        if (text[position] === "]") { position++; return array; }
        array.push(value());
        blank();
        if (text[position] === ",") position++;
        else if (text[position] === "]") { position++; return array; }
        else fail("expected , or ] in array");
      }
    }
    if (character === "{") {
      const table = Object.create(null);
      position++;
      spaces();
      if (text[position] !== "}") {
        for (;;) {
          assign(table, key());
          spaces();
          if (text[position] === "}") break;
          if (text[position] !== ",") fail("expected , or } in inline table");
          position++;
        }
      }
      position++;
      frozen.add(table);
      return table;
    }
    const match = /^(?:true|false|[+-]?(?:inf|nan)|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)(?=[ \t\r\n,\]}#]|$)/
      .exec(text.slice(position, position + 256));
    if (!match) fail("unsupported value (TOML date-times are not supported)");
    position += match[0].length;
    const token = match[0].replaceAll("_", "");
    if (token === "true" || token === "false") return token === "true";
    if (token.endsWith("inf")) return token.startsWith("-") ? -Infinity : Infinity;
    return token.endsWith("nan") ? Number.NaN : Number(token);
  };
  function assign(table, parts) {
    spaces();
    if (text[position] !== "=") fail("expected =");
    position++;
    spaces();
    for (const part of parts.slice(0, -1)) {
      table = child(table, part);
      if (headed.has(table)) fail(`dotted key cannot extend table ${part}`);
      dotted.add(table);
    }
    const name = parts.at(-1);
    if (Object.hasOwn(table, name)) fail(`duplicate key ${name}`);
    table[name] = value();
  }
  let current = root;
  for (;;) {
    blank();
    if (position >= text.length) return root;
    if (text[position] !== "[") {
      assign(current, key());
      endOfLine();
      continue;
    }
    const array = text[position + 1] === "[";
    position += array ? 2 : 1;
    const parts = key();
    if (!text.startsWith(array ? "]]" : "]", position)) fail("unterminated table header");
    position += array ? 2 : 1;
    endOfLine();
    let parent = root;
    for (const part of parts.slice(0, -1)) parent = child(parent, part);
    const name = parts.at(-1);
    if (array) {
      if (!Object.hasOwn(parent, name)) parent[name] = [];
      if (!Array.isArray(parent[name]) || frozen.has(parent[name])) fail(`key ${name} is not an array of tables`);
      current = Object.create(null);
      parent[name].push(current);
    } else {
      if (Object.hasOwn(parent, name) && Array.isArray(parent[name])) fail(`duplicate table ${parts.join(".")}`);
      current = child(parent, name);
      if (headed.has(current) || dotted.has(current)) fail(`duplicate table ${parts.join(".")}`);
    }
    headed.add(current);
  }
}

// Three-valued cfg evaluation for wasm32-unknown-unknown: true, false, or null
// (unknown). Unsupported predicates/syntax stay null, so their dependencies
// remain included. Cargo target predicates do not depend on feature activation.
function wasmCfg(platform) {
  const expression = /^cfg\s*\(([\s\S]*)\)$/.exec(platform.trim());
  if (!expression) return /^cfg\b/.test(platform.trim()) ? null : platform === "wasm32-unknown-unknown";
  const tokens = [];
  for (let text = expression[1].trim(); text;) {
    const match = /^\s*([A-Za-z_][A-Za-z_0-9]*|"(?:[^"\\]|\\.)*"|[(),=])/.exec(text);
    if (!match) return null;
    tokens.push(match[1]);
    text = text.slice(match[0].length).trim();
  }
  const known = { target_arch: "wasm32", target_os: "unknown", target_family: "wasm", target_env: "", target_vendor: "unknown", target_pointer_width: "32", target_endian: "little" };
  let index = 0;
  const take = () => { if (index >= tokens.length) throw new RangeError("truncated cfg"); return tokens[index++]; };
  const parse = () => {
    const name = take();
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new SyntaxError("unknown cfg syntax");
    if (tokens[index] === "=") {
      take();
      const value = JSON.parse(take());
      return Object.hasOwn(known, name) ? known[name] === value : null;
    }
    if (tokens[index] === "(") {
      take();
      const values = [];
      while (tokens[index] !== ")") {
        values.push(parse());
        if (tokens[index] !== ",") break;
        take();
      }
      if (take() !== ")") throw new SyntaxError("unterminated cfg");
      if (name === "all") return values.includes(false) ? false : values.includes(null) ? null : true;
      if (name === "any") return values.includes(true) ? true : values.includes(null) ? null : false;
      if (name === "not" && values.length === 1) return values[0] === null ? null : !values[0];
      return null;
    }
    return name === "unix" || name === "windows" ? false : null;
  };
  try {
    const value = parse();
    return index === tokens.length ? value : null;
  } catch {
    return null;
  }
}

// Retain optional dependencies and unknown cfgs, excluding only target tables
// proven inapplicable to wasm32. Host build/proc-macro dependencies stay broad.
// Registry/git dependencies are pinned by Cargo.lock. No Cargo metadata call.
function dependencyDirectories(repository) {
  const isTable = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const table = (value) => (isTable(value) ? value : {});
  const manifest = (directory) => {
    const path = resolve(directory, "Cargo.toml");
    try { return parseToml(readFileSync(path, "utf8")); }
    catch (error) { throw new Error(`${relative(repository, path)}: ${error.message}`, { cause: error }); }
  };
  const workspace = table(table(manifest(repository).workspace).dependencies);
  const visited = new Set();
  const inputs = new Map();
  const visit = (directory, target) => {
    directory = realpathSync(directory);
    const location = relative(repository, directory);
    if (location.startsWith("..") || isAbsolute(location)) throw new Error(`local Rust dependency ${directory} must remain inside repository`);
    const data = manifest(directory);
    const library = table(data.lib);
    // A proc macro and its dependency tree compile for the build host.
    target = target && !library["proc-macro"];
    if (visited.has(`${target}:${directory}`)) return;
    visited.add(`${target}:${directory}`);
    const buildScript = existsSync(resolve(directory, "build.rs")) || Boolean(table(data.package).build);
    // Explicit production entry points can live in normally test-only folders.
    const firstSegment = (path) => (path.startsWith("/") ? "/" : path.split("/").find((part) => part && part !== "."));
    const entryPoints = [library, ...(Array.isArray(data.bin) ? data.bin : [])];
    const keepTests = buildScript || entryPoints.some((entry) => ["tests", "benches"].includes(firstSegment(String(table(entry).path ?? ""))));
    inputs.set(directory, { directory, buildScript, skipStandaloneTests: !keepTests });
    for (const [platform, section] of [[null, data], ...Object.entries(table(data.target))]) {
      for (const kind of ["dependencies", "build-dependencies"]) {
        // Target-specific build dependencies are selected for the host.
        const dependencyTarget = target && kind !== "build-dependencies";
        if (dependencyTarget && platform !== null && wasmCfg(platform) === false) continue;
        for (const [name, declared] of Object.entries(table(table(section)[kind]))) {
          if (!isTable(declared)) continue;
          let dependency = declared;
          let base = directory;
          if (dependency.workspace) {
            if (!Object.hasOwn(workspace, name)) throw new Error(`${directory}/Cargo.toml: ${name} is not a workspace dependency`);
            dependency = workspace[name];
            base = repository;
          }
          if (isTable(dependency) && Object.hasOwn(dependency, "path")) visit(resolve(base, dependency.path), dependencyTarget);
        }
      }
    }
  };
  visit(resolve(repository, "js/nanocodex"), true);
  return [...inputs.keys()].sort().map((directory) => inputs.get(directory));
}

// Every file whose content can change the WASM outputs, as sorted absolute paths.
async function inputFiles(repository) {
  const files = new Set();
  const omittedTestDirectories = new Set();
  for (const { directory, buildScript, skipStandaloneTests } of dependencyDirectories(repository)) {
    files.add(resolve(directory, "Cargo.toml"));
    if (skipStandaloneTests) for (const name of ["tests", "benches"]) omittedTestDirectories.add(resolve(directory, name));
    if (directory === resolve(repository, "js/nanocodex") && !buildScript) {
      for (const path of await walk(resolve(directory, "src"))) files.add(path);
      for (const name of ["build.rs", "README.md"]) {
        try { await readFile(resolve(directory, name)); files.add(resolve(directory, name)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    } else {
      for (const path of await walk(directory, skipStandaloneTests)) files.add(path);
    }
  }
  for (const name of ["Cargo.toml", "Cargo.lock", "js/nanocodex-vite/scripts/build-js-package.sh",
    "js/nanocodex-vite/scripts/wasm-output-cache.mjs", "js/nanocodex-vite/scripts/wasm-memory-views.mjs",
    "js/nanocodex/scripts/deduplicate-wasm.mjs", "js/nanocodex/scripts/write-package-types.mjs",
    "js/nanocodex/scripts/write-wasm-attestation.mjs", "js/nanocodex/scripts/check-managed-wasm.mjs"]) files.add(resolve(repository, name));
  for (const name of [".cargo", "rust-toolchain", "rust-toolchain.toml"]) {
    try {
      if (name === ".cargo") for (const path of await walk(resolve(repository, name))) files.add(path);
      else { await readFile(resolve(repository, name)); files.add(resolve(repository, name)); }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // Rust literal include/#[path] references can leave their crate directory.
  // Follow those recursively while retaining checkout-relative content keys.
  for (const path of files) {
    if (!path.endsWith(".rs")) continue;
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/(?:include(?:_str|_bytes)?!\s*\(\s*|#\[path\s*=\s*)(?:r(#{0,8}))?"([^"\n]+)"/g)) {
      const included = resolve(dirname(path), match[2]);
      assert.ok(!relative(repository, included).startsWith(".."), "Rust include must remain inside repository");
      await readFile(included);
      files.add(included);
      // A production Rust module in tests/ can itself use ordinary mod children.
      // Retain that subtree rather than approximating Rust module resolution.
      if (included.endsWith(".rs")) for (const directory of omittedTestDirectories) {
        if (!relative(directory, included).startsWith("..")) {
          for (const path of await walk(directory)) files.add(path);
          omittedTestDirectories.delete(directory);
        }
      }
    }
  }
  return [...files].sort();
}

// Resolution errors propagate: an input set this script cannot prove complete
// must fail the build loudly instead of silently reusing or skipping the cache.
export async function fingerprintInputs(repository = root, mode = "release", environment = process.env) {
  repository = await realpath(repository);
  assert.ok(["release", "development"].includes(mode));
  const files = await inputFiles(repository);
  const pkg = JSON.parse(await readFile(resolve(repository, "js/nanocodex/package.json"), "utf8"));
  const buildEnvironment = Object.fromEntries(Object.entries(environment)
    .filter(([name]) => /^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_INCREMENTAL|CARGO_PROFILE_.*|CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_.*)$/.test(name))
    // cargo +1.97 overrides RUSTUP_TOOLCHAIN. Dev/test overrides do not affect
    // --profile wasm, and rust-toolchain setup commonly introduces them.
    .filter(([name, value]) => name !== "CARGO_INCREMENTAL" || value !== (mode === "release" ? "0" : "1"))
    .filter(([name]) => !name.startsWith("CARGO_PROFILE_") || (mode === "release"
      ? /^CARGO_PROFILE_(WASM|RELEASE)_/.test(name)
      : /^CARGO_PROFILE_DEV_/.test(name))).sort());
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ schema: 1, mode, rustToolchain, bindgen: "0.2.126", binaryen: pkg.devDependencies.binaryen, buildEnvironment }));
  for (const path of files) hash.update(JSON.stringify([relative(repository, path), sha(await readFile(path))]));
  return hash.digest("hex");
}

async function outputs(repository) {
  const web = pathToFileURL(`${resolve(repository, "js/nanocodex/pkg-web")}/`);
  const artifacts = await hashManagedWasmArtifacts(web);
  const node = {};
  for (const name of ["nanocodex.js", "nanocodex.d.ts", "package.json"]) node[name] = sha(await readFile(resolve(repository, "js/nanocodex/pkg-node", name)));
  return { artifacts, node, sourceWasmSha256: sha(await readFile(resolve(repository, rawPath))) };
}

// Computing the key happens first so resolution errors are never mistaken for
// an ordinary cache miss (for example a fresh checkout without metadata).
export async function check(repository = root, mode = "release") {
  const key = await fingerprintInputs(repository, mode);
  let retained;
  try { retained = JSON.parse(await readFile(resolve(repository, metadataPath), "utf8")); }
  catch (error) { throw new CacheMiss(error.code === "ENOENT" ? "no retained outputs" : error.message); }
  try {
    assert.equal(retained.schema, 1);
    assert.equal(retained.fingerprint, key, "WASM inputs changed");
  } catch (error) { throw new CacheMiss(error.message.split("\n")[0]); }
  try {
    const current = await outputs(repository);
    assert.deepEqual(retained.outputs, current);
    assertCachedManagedWasmAttestation(JSON.parse(await readFile(resolve(repository, "js/nanocodex/pkg-web/nanocodex-build.json"), "utf8")), current);
  } catch (error) { throw new CacheMiss(`outputs do not match retained metadata: ${error.message.split("\n")[0]}`); }
}

export class CacheMiss extends Error {}

// turbo.json must hash every WASM input into nanocodex#build, or cached
// downstream tasks (Worker bundles embedding the WASM) replay stale outputs
// after a Rust edit. Supported input forms: $TURBO_DEFAULT$ (the package),
// $TURBO_ROOT$/<file>, and $TURBO_ROOT$/<directory>/**.
export async function assertTurboInputs(repository = root) {
  repository = await realpath(repository);
  const inputs = JSON.parse(await readFile(resolve(repository, "turbo.json"), "utf8")).tasks?.["nanocodex#build"]?.inputs ?? [];
  const covered = inputs.map((input) => {
    if (input === "$TURBO_DEFAULT$") return "js/nanocodex/**";
    if (!input.startsWith("$TURBO_ROOT$/")) throw new Error(`unsupported nanocodex#build input ${input}`);
    const path = input.slice("$TURBO_ROOT$/".length);
    if (/[*?[{!]/.test(path.replace(/\/\*\*$/, ""))) throw new Error(`unsupported nanocodex#build input glob ${input}`);
    return path;
  });
  const missing = (await inputFiles(repository)).map((path) => relative(repository, path))
    .filter((path) => !covered.some((input) => input.endsWith("/**") ? path.startsWith(input.slice(0, -2)) : path === input));
  if (missing.length) {
    throw new Error(`turbo.json nanocodex#build inputs omit WASM inputs; add them (for example $TURBO_ROOT$/<crate>/**): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`);
  }
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function save(repository = root, mode = "release", source) {
  // Remove pre-release cache locations so older local builds cannot publish raw WASM.
  for (const name of [".nanocodex-source.wasm", ".nanocodex-output-cache.json"]) {
    await rm(resolve(repository, "js/nanocodex/pkg-web", name), { force: true });
  }
  await mkdir(resolve(repository, ".ci-wasm-cache"), { recursive: true });
  await writeFile(resolve(repository, ".ci-wasm-cache/.gitignore"), "*\n");
  await atomicWrite(resolve(repository, rawPath), await readFile(source));
  await atomicWrite(resolve(repository, metadataPath), `${JSON.stringify({ schema: 1, fingerprint: await fingerprintInputs(repository, mode), outputs: await outputs(repository) })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, mode = "release", source] = process.argv.slice(2);
  if (command === "key") console.log(await fingerprintInputs(root, mode));
  else if (command === "check") {
    // Exit 1 is an ordinary miss (rebuild). Resolution failures exit 2 so the
    // build stops instead of treating an unprovable input set as a miss.
    try { await check(root, mode); console.log("WASM output cache verified"); }
    catch (error) {
      if (!(error instanceof CacheMiss)) { console.error("WASM input fingerprint failed:", error); process.exit(2); }
      console.error(`WASM output cache miss: ${error.message}`);
      process.exitCode = 1;
    }
  } else if (command === "check-turbo") await assertTurboInputs(root);
  else if (command === "save" && source) await save(root, mode, resolve(source));
  else throw new Error("usage: wasm-output-cache.mjs key|check|check-turbo [release|development], or save <mode> <raw-wasm>");
}
