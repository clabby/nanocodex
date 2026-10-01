// Byte-only fast paths for the two shell operations that otherwise build large
// Latin-1 strings. Admission uses Just Bash's public parser-backed transform;
// anything outside this deliberately small grammar stays in the interpreter.
const CHUNK_BYTES = 1024 * 1024;

/**
 * Return undefined without mutation when the command is not eligible. Call this
 * inside the host's serialized/refresh/cancellation boundary, and only when cat
 * and sha256sum have not been replaced by custom commands. Range callbacks are
 * optional; write callbacks must maintain the filesystem adapter's metadata.
 */
export async function tryExecuteBinaryCommand({
  bash, filesystem, command, cwd, root, signal, binaryIO, executionLimits,
}) {
  signal?.throwIfAborted();
  if (typeof bash?.transform !== "function"
      || typeof filesystem?.readFileBuffer !== "function"
      || typeof filesystem?.writeFile !== "function"
      || typeof filesystem?.lstat !== "function") return undefined;
  const sourceLimit = executionLimits?.maxSourceBytes;
  if (Number.isFinite(sourceLimit) && command.length > sourceLimit) {
    return { stdout: "", stderr: "binary shell: source size limit exceeded; use a native Hand\n", exitCode: 1 };
  }
  let plan;
  try {
    plan = admit(bash.transform(command).ast, cwd, root);
  } catch {
    // The interpreter owns parser errors and its exact diagnostics.
    return undefined;
  }
  if (!plan) return undefined;
  if (plan.rejected) return { stdout: "", stderr: `binary shell: ${plan.rejected}; use a native Hand\n`, exitCode: 1 };

  const sizes = new Map();
  try {
    const inputs = [];
    for (const argument of plan.inputArguments) {
      if (argument.path) { inputs.push(argument.path); continue; }
      if (typeof filesystem.readdir !== "function") return undefined;
      const names = await filesystem.readdir(argument.directory);
      const matches = names.filter((name) => typeof name === "string"
        && name !== "." && name !== ".."
        && (argument.prefix.startsWith(".") || !name.startsWith("."))
        && name.length >= argument.prefix.length + argument.suffix.length
        && name.startsWith(argument.prefix) && name.endsWith(argument.suffix)).sort();
      if (!matches.length) return undefined; // Bash owns unmatched-glob behavior.
      for (const name of matches) {
        const path = safePath(`${argument.directory}/${name}`, cwd, root);
        if (!path || path === plan.destination) return undefined;
        inputs.push(path);
      }
    }
    plan.inputs = inputs;
    // Refuse intermediate symlink aliases as well as leaf symlinks. Root
    // confinement alone is insufficient for a generic caller-owned adapter.
    const parents = new Set();
    for (const path of [...plan.inputs, ...plan.hashes.map(({ path }) => path), plan.destination].filter(Boolean)) {
      let parent = path.slice(0, path.lastIndexOf("/")) || "/";
      while (parent !== root && parent !== "/") {
        parents.add(parent);
        parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
      }
    }
    for (const path of parents) {
      const stat = await filesystem.lstat(path);
      if (!stat.isDirectory || stat.isSymbolicLink) return undefined;
    }
    // Do not accelerate missing files/directories/symlinks: the interpreter
    // owns cat's partial-output/error semantics, including destination aliases.
    for (const path of new Set([...plan.inputs, ...plan.hashes.map(({ path }) => path)])) {
      if (path === plan.destination) continue;
      const stat = await filesystem.lstat(path);
      if (!stat.isFile || stat.isSymbolicLink || !Number.isSafeInteger(stat.size) || stat.size < 0) {
        return undefined;
      }
      sizes.set(path, stat.size);
    }
    if (plan.destination) {
      try {
        const stat = await filesystem.lstat(plan.destination);
        if (!stat.isFile || stat.isSymbolicLink) return undefined;
      } catch (error) {
        if (error?.code !== "ENOENT") return undefined;
      }
    }
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
  signal?.throwIfAborted();
  const total = plan.inputs.reduce((sum, path) => sum + sizes.get(path), 0);
  if (!Number.isSafeInteger(total)) return undefined;
  const hashReadBytes = plan.hashes.reduce((sum, { path }) => sum + (path === plan.destination ? 0 : sizes.get(path)), 0);
  const inputBytes = total + hashReadBytes;
  const rangedRead = typeof binaryIO?.readRange === "function";
  const rangedWrite = rangedRead && typeof binaryIO?.writeRange === "function"
    && typeof binaryIO?.truncate === "function";
  const largestInput = plan.inputs.reduce((largest, path) => Math.max(largest, sizes.get(path)), 0);
  const largestHash = plan.hashes.reduce((largest, { path }) => Math.max(largest, path === plan.destination ? 0 : sizes.get(path)), 0);
  const liveBytes = plan.destination
    ? rangedWrite ? 2 * CHUNK_BYTES : 2 * total + Math.max(largestInput, rangedRead ? CHUNK_BYTES : largestHash)
    : rangedRead ? CHUNK_BYTES : 2 * largestHash;
  const outputBytes = plan.hashes.reduce((sum, { label }) => sum + 67 + label.length, 0);
  for (const [resource, actual] of [["maxInputBytes", inputBytes], ["maxLiveBytes", liveBytes], ["maxOutputSize", outputBytes]]) {
    const limit = executionLimits?.[resource];
    if (typeof limit === "number" && Number.isFinite(limit) && actual > limit) {
      return { stdout: "", stderr: `binary shell: ${resource} limit exceeded (${actual} > ${limit}); use a native Hand for larger files\n`, exitCode: 1 };
    }
  }
  let destinationBytes;
  let destinationDigest;
  let mutated = false;
  try {
    if (plan.destination) {
      if (rangedWrite) {
        // Like >, truncation precedes cat. Never fall back/re-execute afterwards.
        mutated = true;
        await binaryIO.truncate(plan.destination, 0);
        const hash = plan.hashes.some(({ path }) => path === plan.destination) ? new Sha256() : undefined;
        let position = 0;
        for (const path of plan.inputs) {
          await readChunks(path, sizes.get(path), binaryIO, signal, async (bytes) => {
            await binaryIO.writeRange(plan.destination, position, bytes);
            signal?.throwIfAborted();
            position += bytes.byteLength;
            hash?.update(bytes);
          });
        }
        destinationDigest = hash?.hex();
      } else {
        // Current Workspace is whole-read/write. One output allocation, one
        // source live at a time; admission also budgets the digest snapshot.
        // There is no byte -> string -> byte round trip.
        destinationBytes = new Uint8Array(total);
        let position = 0;
        for (const path of plan.inputs) {
          signal?.throwIfAborted();
          const bytes = await filesystem.readFileBuffer(path);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== sizes.get(path)) {
            return undefined; // No destination mutation yet (stale size metadata).
          }
          destinationBytes.set(bytes, position);
          position += bytes.byteLength;
          await yieldToHost(signal);
        }
        signal?.throwIfAborted();
        mutated = true;
        await filesystem.writeFile(plan.destination, destinationBytes);
      }
      sizes.set(plan.destination, total);
    }

    let stdout = "";
    for (const { path, label } of plan.hashes) {
      signal?.throwIfAborted();
      let digest;
      if (path === plan.destination && destinationDigest) digest = destinationDigest;
      else if (path === plan.destination && destinationBytes) {
        digest = await hashBytes(destinationBytes, signal);
        destinationDigest = digest;
      } else if (rangedRead) {
        const hash = new Sha256();
        await readChunks(path, sizes.get(path), binaryIO, signal, (bytes) => hash.update(bytes));
        digest = hash.hex();
      } else {
        const bytes = await filesystem.readFileBuffer(path);
        digest = await hashBytes(bytes, signal);
      }
      stdout += `${digest}  ${label}\n`;
    }
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    signal?.throwIfAborted();
    // Before writes, preserve exact upstream errors; afterwards replaying would
    // repeat effects. Surface one bounded shell error instead.
    if (!mutated) return undefined;
    return { stdout: "", stderr: `binary shell: ${String(error?.message ?? error)}\n`, exitCode: 1 };
  }
}

function admit(ast, cwd, root) {
  if (ast?.type !== "Script" || ast.statements?.length !== 1) return undefined;
  const statement = ast.statements[0];
  if (statement.type !== "Statement" || statement.background || statement.deferredError
      || !Array.isArray(statement.pipelines) || !Array.isArray(statement.operators)) return undefined;
  const pipelines = statement.pipelines;
  if (pipelines.length < 1 || pipelines.length > 2
      || statement.operators.length !== pipelines.length - 1
      || statement.operators.some((operator) => operator !== "&&")) return undefined;
  const commands = [];
  for (const pipeline of pipelines) {
    if (pipeline.type !== "Pipeline" || pipeline.negated || pipeline.timed || pipeline.timePosix
        || pipeline.commands?.length !== 1 || pipeline.pipeStderr?.some(Boolean)) return undefined;
    const node = pipeline.commands[0];
    if (node.type !== "SimpleCommand" || node.assignments?.length !== 0) return undefined;
    const name = literalWord(node.name);
    if (name !== "cat" && name !== "sha256sum") return undefined;
    const args = [];
    const words = [];
    for (const word of node.args ?? []) {
      const arg = literalWord(word);
      if (arg === undefined && name !== "cat") return undefined;
      args.push(arg);
      words.push(word);
    }
    if (args[0] === "--") { args.shift(); words.shift(); }
    if (args.length === 0 || args.some((arg) => arg !== undefined && (!arg || arg === "-" || arg.startsWith("-")))) return undefined;
    commands.push({ node, name, args, words });
  }
  const first = commands[0];
  let destination;
  let inputArguments = [];
  let hashArgs = [];
  if (first.name === "cat") {
    if (first.node.redirections?.length !== 1) return undefined;
    const redirect = first.node.redirections[0];
    if (redirect.type !== "Redirection" || redirect.operator !== ">"
        || redirect.fdVariable || (redirect.fd !== null && redirect.fd !== 1)) return undefined;
    destination = safePath(literalWord(redirect.target), cwd, root);
    inputArguments = first.words.map((word) => inputArgument(word, cwd, root));
    // Never let an unsupported glob reach string-based cat after redirection
    // has truncated the destination. Refusal is atomic and bounded.
    if (destination && inputArguments.some((arg, index) => !arg && first.words[index].parts?.some((part) => part.type === "Glob"))) {
      return { rejected: "unsupported binary glob (one basename * only)" };
    }
    if (!destination || inputArguments.some((arg) => !arg || arg.path === destination)) return undefined;
    if (commands.length === 2) {
      const next = commands[1];
      if (next.name !== "sha256sum" || next.node.redirections?.length !== 0) return undefined;
      hashArgs = next.args;
    }
  } else {
    if (commands.length !== 1 || first.node.redirections?.length !== 0) return undefined;
    hashArgs = first.args;
  }
  const hashes = hashArgs.map((label) => ({ label, path: safePath(label, cwd, root) }));
  if (hashes.some(({ path }) => !path)) return undefined;
  return { destination, inputArguments, inputs: [], hashes };
}

// Exactly one parser-recognized basename '*' is supported. The directory is
// literal, and prefix/suffix matching consumes directory entries rather than
// reparsing shell source. Complex glob syntax remains with the interpreter.
function inputArgument(word, cwd, root) {
  const literal = literalWord(word);
  if (literal !== undefined) {
    const path = safePath(literal, cwd, root);
    return path ? { path } : undefined;
  }
  if (word?.type !== "Word" || !Array.isArray(word.parts)) return undefined;
  const globIndices = word.parts.map((part, index) => part.type === "Glob" ? index : -1).filter((index) => index >= 0);
  if (globIndices.length !== 1) return undefined;
  const index = globIndices[0];
  if (word.parts[index].pattern !== "*") return undefined;
  const prefixPath = literalParts(word.parts.slice(0, index));
  const suffix = literalParts(word.parts.slice(index + 1));
  if (prefixPath === undefined || suffix === undefined || suffix.includes("/")) return undefined;
  const slash = prefixPath.lastIndexOf("/");
  const directoryText = slash < 0 ? "." : prefixPath.slice(0, slash) || "/";
  const prefix = prefixPath.slice(slash + 1);
  const placeholder = safePath(`${directoryText}/__binary_glob__`, cwd, root);
  if (!placeholder) return undefined;
  return { directory: placeholder.slice(0, placeholder.lastIndexOf("/")) || "/", prefix, suffix };
}

function literalWord(word) {
  if (word?.type !== "Word" || !Array.isArray(word.parts)) return undefined;
  return literalParts(word.parts);
}
function literalParts(parts) {
  let value = "";
  for (const part of parts) {
    if (["Literal", "SingleQuoted", "Escaped"].includes(part.type) && typeof part.value === "string") {
      // Defensive: upstream normally represents glob/brace/tilde expansions
      // separately. Refuse unquoted metacharacters even on a changed AST.
      if (part.type === "Literal" && /[*?\[\]{}~]/.test(part.value)) return undefined;
      value += part.value;
    } else if (part.type === "DoubleQuoted" && Array.isArray(part.parts)) {
      const inner = literalParts(part.parts);
      if (inner === undefined) return undefined;
      value += inner;
    } else return undefined;
  }
  return value;
}
function safePath(value, cwd, root) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f\\]/.test(value)
      || typeof root !== "string" || !root.startsWith("/") || typeof cwd !== "string") return undefined;
  const normalize = (path) => {
    const segments = [];
    for (const segment of path.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    return `/${segments.join("/")}`;
  };
  const boundary = normalize(root);
  const within = (path) => path === boundary || path.startsWith(`${boundary === "/" ? "" : boundary}/`);
  if (!within(normalize(cwd))) return undefined;
  const path = normalize(value.startsWith("/") ? value : `${cwd}/${value}`);
  return within(path) && path !== boundary && !path.startsWith("/dev/") ? path : undefined;
}
async function readChunks(path, size, io, signal, consume) {
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    signal?.throwIfAborted();
    const length = Math.min(CHUNK_BYTES, size - offset);
    const bytes = await io.readRange(path, offset, length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new Error(`short binary range read: ${path}`);
    }
    signal?.throwIfAborted();
    await consume(bytes);
    await yieldToHost(signal);
  }
}
async function yieldToHost(signal) {
  // A resolved Promise does not let cancellation timers/I/O run in Workers.
  await new Promise((resolve) => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}
async function hashBytes(bytes, signal) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("binary read must return Uint8Array");
  if (globalThis.crypto?.subtle) {
    const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    signal?.throwIfAborted();
    return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const hash = new Sha256();
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    hash.update(bytes.subarray(offset, offset + CHUNK_BYTES));
    await yieldToHost(signal);
  }
  return hash.hex();
}

// Incremental SHA-256 for range-backed storage. Uses one 64-byte tail and a
// fixed 64-word schedule, independent of file size; no runtime dependencies.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
class Sha256 {
  state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  words = new Uint32Array(64);
  tail = new Uint8Array(64);
  tailSize = 0;
  length = 0;
  update(bytes) {
    this.length += bytes.byteLength;
    let position = 0;
    if (this.tailSize) {
      const count = Math.min(64 - this.tailSize, bytes.byteLength);
      this.tail.set(bytes.subarray(0, count), this.tailSize);
      this.tailSize += count;
      position = count;
      if (this.tailSize === 64) { this.block(this.tail, 0); this.tailSize = 0; }
    }
    while (position + 64 <= bytes.byteLength) {
      this.block(bytes, position);
      position += 64;
    }
    if (position < bytes.byteLength) {
      this.tail.set(bytes.subarray(position), 0);
      this.tailSize = bytes.byteLength - position;
    }
  }
  block(bytes, offset) {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a,b,c,d,e,f,g,h] = this.state;
    for (let i = 0; i < 64; i++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + K[i] + w[i]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const values = [a,b,c,d,e,f,g,h];
    for (let i = 0; i < 8; i++) this.state[i] += values[i];
  }
  hex() {
    const length = this.length;
    const padding = new Uint8Array(this.tailSize < 56 ? 64 - this.tailSize : 128 - this.tailSize);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(length / 0x20000000));
    view.setUint32(padding.length - 4, (length * 8) >>> 0);
    this.update(padding);
    return Array.from(this.state, (word) => word.toString(16).padStart(8, "0")).join("");
  }
}
