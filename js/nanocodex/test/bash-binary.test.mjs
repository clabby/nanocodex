import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, mkdir, rm, lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { justBash, createJustBashRuntime } from "../../nanocodex-tools/tools/bash.mjs";
import { createWorkspace } from "../../nanocodex-tools/tools/workspace.mjs";
import { tryExecuteBinaryCommand } from "../../nanocodex-tools/tools/shell-binary.mjs";

const childCase = process.env.NANOCODEX_BINARY_CHILD;
if (childCase) {
  // Each real-runtime journey runs in an externally killable child. A stalled
  // interpreter cannot prevent the parent's eight-second deadline from firing.
  await journey(childCase);
} else {
  for (const name of ["workspace", "admission", "ranges", "range-failure", "budget", "glob-limit", "live-limit"]) {
    test(`binary shell public exec journey: ${name}`, { timeout: 9_000 }, async (t) => {
      const result = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url)], {
        timeout: 8_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, NANOCODEX_BINARY_CHILD: name },
      });
      const evidence = JSON.parse(result.stdout.trim());
      assert.equal(evidence.passed, true);
      t.diagnostic(JSON.stringify(evidence));
    });
  }
}

async function interpreter() {
  // Existing dependency installation may live outside an isolated worktree.
  // A test-only loader selects it without editing node_modules or installing.
  return import(process.env.NANOCODEX_TEST_JUST_BASH_URL ?? "nanocodex-tools/just-bash/browser");
}
function context(signal = new AbortController().signal) {
  return { callId: "synthetic-binary-call", parentCallId: "synthetic-parent", sessionId: "binary-fixture", model: "fixture", signal };
}
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function pattern(length, seed) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = (index * 37 + seed) & 255;
  return bytes;
}
async function journey(name) {
  const directory = await mkdtemp(join(tmpdir(), "nanocodex-binary-"));
  try {
    if (name === "workspace") await workspaceJourney(directory);
    else if (name === "admission") await admissionJourney(directory);
    else if (name === "budget") await budgetJourney(directory);
    else if (name === "glob-limit" || name === "live-limit") await atomicLimitJourney(directory, name);
    else await rangeJourney(directory, name === "range-failure");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
function diskWorkspace(directory, trace) {
  const path = (relative) => join(directory, relative);
  return createWorkspace({
    root: "/workspace",
    backend: {
      async list(relative, { recursive }) {
        const entries = [];
        async function walk(relative) {
          for (const entry of await readdir(path(relative), { withFileTypes: true })) {
            const candidate = relative ? `${relative}/${entry.name}` : entry.name;
            const metadata = await lstat(path(candidate));
            entries.push({ path: candidate, kind: entry.isDirectory() ? "directory" : "file", size: metadata.size });
            if (recursive && entry.isDirectory()) await walk(candidate);
          }
        }
        await walk(relative);
        return entries;
      },
      async readFile(relative) {
        const bytes = await readFile(path(relative));
        trace.push({ operation: "read", path: relative, bytes: bytes.byteLength });
        return bytes;
      },
      async writeFile(relative, contents) {
        await mkdir(dirname(path(relative)), { recursive: true });
        await writeFile(path(relative), contents);
        trace.push({ operation: "write", path: relative, bytes: contents.byteLength });
      },
      async mkdir(relative) { await mkdir(path(relative), { recursive: true }); },
      async remove(relative, options) { await rm(path(relative), { ...options, force: true }); },
    },
  });
}
async function workspaceJourney(directory) {
  const left = pattern(8 * 1024 * 1024 + 57, 11);
  const right = pattern(7 * 1024 * 1024 + 71, 193);
  await writeFile(join(directory, ".part-010"), right);
  await writeFile(join(directory, ".part-002"), left);
  const expected = Buffer.concat([left, right]);
  const digest = sha(expected);
  const trace = [];
  const source = diskWorkspace(directory, trace);
  const runtime = await justBash({ filesystem: source, loadInterpreter: interpreter, refreshFilesystemBeforeExec: true });
  const command = "cat /workspace/.part-* > joined.bin && sha256sum joined.bin";
  const started = performance.now();
  const result = await runtime.tool.handler({ cmd: command }, context());
  const elapsedMs = performance.now() - started;
  assert.equal(result.exit_code, 0, result.output);
  assert.equal(result.output, `${digest}  joined.bin\n`);
  assert.deepEqual(await readFile(join(directory, "joined.bin")), expected);
  assert.deepEqual(trace, [
    { operation: "read", path: ".part-002", bytes: left.byteLength },
    { operation: "read", path: ".part-010", bytes: right.byteLength },
    { operation: "write", path: "joined.bin", bytes: expected.byteLength },
  ], "concat/hash must not reread the destination or stringify binary stdout");
  const reopened = await justBash({ filesystem: source, loadInterpreter: interpreter });
  const hashResult = await reopened.tool.handler({ cmd: "sha256sum joined.bin" }, context());
  assert.equal(hashResult.output, result.output);
  assert.equal(hashResult.exit_code, 0);
  const listing = await runtime.filesystem.list(".");
  assert.equal(listing.find(({ path }) => path === "/workspace/joined.bin").size, expected.byteLength);
  console.log(JSON.stringify({ passed: true, journey: "workspace", command, bytes: expected.byteLength, digest, elapsedMs: Math.round(elapsedMs), observed: result, persistedHash: hashResult.output, maxRSSKiB: process.resourceUsage().maxRSS, trace }));
}
async function budgetJourney(directory) {
  const bytes = 152 * 1024 * 1024 + 1;
  const handle = await open(join(directory, ".part-001"), "w");
  try { await handle.truncate(bytes); } finally { await handle.close(); }
  await writeFile(join(directory, "joined.bin"), "keep existing destination");
  const trace = [];
  const runtime = await justBash({ filesystem: diskWorkspace(directory, trace), loadInterpreter: interpreter });
  const command = "cat /workspace/.part-* > joined.bin && sha256sum joined.bin";
  const started = performance.now();
  const result = await runtime.tool.handler({ cmd: command }, context());
  assert.equal(result.exit_code, 1);
  assert.match(result.output, /maxInputBytes.*limit exceeded/);
  assert.deepEqual(trace, [], "oversize plans must fail before any binary read or destination write");
  assert.equal(await readFile(join(directory, "joined.bin"), "utf8"), "keep existing destination");
  const hashResult = await runtime.tool.handler({ cmd: "sha256sum .part-001" }, context());
  assert.equal(hashResult.exit_code, 1);
  assert.match(hashResult.output, /maxInputBytes.*limit exceeded/);
  const recovery = await runtime.tool.handler({ cmd: "printf healthy" }, context());
  assert.equal(recovery.output, "healthy");
  assert.equal(recovery.exit_code, 0);
  console.log(JSON.stringify({ passed: true, journey: "budget", command, inputBytes: bytes, elapsedMs: Math.round(performance.now() - started), observed: result, trace, recovery }));
}

async function atomicLimitJourney(directory, name) {
  await writeFile(join(directory, ".part-001"), pattern(1024, 7));
  await writeFile(join(directory, "joined.bin"), "preserve destination");
  const trace = [];
  const runtime = await justBash({ filesystem: diskWorkspace(directory, trace),
    ...(name === "live-limit" ? { executionLimits: { maxLiveBytes: 1024 } } : {}) });
  const commands = name === "glob-limit" ? ["cat .part-00? > joined.bin && sha256sum joined.bin", "cat .part-[0-9]* > joined.bin", "cat */*.bin > joined.bin"] : ["cat .part-* > joined.bin && sha256sum joined.bin"];
  const outcomes = [];
  for (const cmd of commands) {
    const observed = await runtime.tool.handler({ cmd }, context());
    assert.equal(observed.exit_code, 1);
    assert.match(observed.output, /unsupported binary glob|maxLiveBytes.*limit exceeded/);
    assert.deepEqual(trace, [], "limit must precede read/allocation/write");
    assert.equal(await readFile(join(directory, "joined.bin"), "utf8"), "preserve destination");
    outcomes.push({ cmd, observed });
  }
  const recovery = await runtime.tool.handler({ cmd: "echo recovered" }, context());
  assert.equal(recovery.output, "recovered\n");
  console.log(JSON.stringify({ passed: true, journey: name, outcomes, trace, recovery }));
}

async function admissionJourney(directory) {
  await writeFile(join(directory, "a.txt"), "abc");
  await writeFile(join(directory, "b.txt"), "def");
  const source = diskWorkspace(directory, []);
  const runtime = await justBash({ filesystem: source, loadInterpreter: interpreter });
  const commands = [
    "cat a.txt b.txt > joined.txt && sha256sum joined.txt",
    "cat *.txt > glob.bin && sha256sum glob.bin",
    "file=a.txt; cat \"$file\" > expanded.bin; sha256sum expanded.bin",
    "cat $(printf a.txt) > substitution.bin && sha256sum substitution.bin",
    "cat missing a.txt > partial.bin && sha256sum partial.bin",
    "cat a.txt > a.txt",
    "cat b.txt >> appended.bin && sha256sum appended.bin",
    "cat b.txt | sha256sum",
    "sha256sum missing b.txt",
    "cat b.txt > /tmp/escape.bin",
  ];
  const { Bash } = await interpreter();
  const reference = new Bash({ cwd: "/workspace", files: { "/workspace/a.txt": "abc", "/workspace/b.txt": "def" } });
  const outcomes = [];
  for (const cmd of commands) {
    const expected = await reference.exec(cmd);
    let actual;
    try { actual = await runtime.tool.handler({ cmd }, context()); }
    catch (error) {
      assert.equal(cmd, "cat b.txt > /tmp/escape.bin");
      assert.match(error.message, /escapes \/workspace/);
      outcomes.push({ cmd, observed: error.message });
      continue;
    }
    if (cmd.endsWith("/tmp/escape.bin")) {
      assert.notEqual(actual.exit_code, 0);
      assert.match(actual.output, /escapes \/workspace/);
    } else {
      assert.equal(actual.exit_code, expected.exitCode, cmd);
      assert.equal(actual.output, expected.stdout + expected.stderr, cmd);
    }
    outcomes.push({ cmd, observed: actual });
  }
  assert.equal((await readFile(join(directory, "a.txt"))).byteLength, 0, "self-redirection must use ordinary shell semantics");
  assert.equal(await readFile(join(directory, "partial.bin"), "utf8"), "abc");
  // Custom overrides must not be silently bypassed by fast-path execution.
  const overridden = await justBash({ filesystem: source, loadInterpreter: interpreter, customCommands: [{ name: "cat", execute: async () => ({ stdout: "custom\n", stderr: "", exitCode: 0 }) }] });
  const custom = await overridden.tool.handler({ cmd: "cat b.txt > custom.txt && sha256sum custom.txt" }, context());
  assert.equal(custom.output, `${sha("custom\n")}  custom.txt\n`);
  outcomes.push({ cmd: "custom cat override", observed: custom });
  console.log(JSON.stringify({ passed: true, journey: "admission", outcomes }));
}
async function rangeJourney(directory, fail) {
  const { Bash } = await interpreter();
  const left = pattern(2 * 1024 * 1024 + 55, 9);
  const right = pattern(1024 * 1024 + 3, 17);
  await writeFile(join(directory, "left.bin"), left);
  await writeFile(join(directory, "right.bin"), right);
  const expected = Buffer.concat([left, right]);
  const trace = [];
  const localPath = (absolute) => join(directory, absolute.slice("/workspace/".length));
  const filesystem = {
    async lstat(path) {
      const metadata = await lstat(localPath(path));
      return { isFile: metadata.isFile(), isDirectory: metadata.isDirectory(), isSymbolicLink: metadata.isSymbolicLink(), size: metadata.size };
    },
    async readFileBuffer(path) {
      trace.push({ operation: "whole-read", path });
      return readFile(localPath(path));
    },
    async writeFile(path, bytes) {
      trace.push({ operation: "whole-write", path });
      await writeFile(localPath(path), bytes);
    },
  };
  const binaryIO = {
    async readRange(path, offset, length) {
      trace.push({ operation: "range-read", path, offset, length });
      const handle = await open(localPath(path), "r");
      try {
        const bytes = new Uint8Array(length);
        const result = await handle.read(bytes, 0, length, offset);
        return bytes.subarray(0, result.bytesRead);
      } finally { await handle.close(); }
    },
    async truncate(path) {
      trace.push({ operation: "truncate", path });
      await writeFile(localPath(path), new Uint8Array());
    },
    async writeRange(path, offset, contents) {
      trace.push({ operation: "range-write", path, offset, length: contents.byteLength });
      if (fail) throw new Error("synthetic range write failure");
      const handle = await open(localPath(path), "r+");
      try { await handle.write(contents, 0, contents.byteLength, offset); }
      finally { await handle.close(); }
    },
  };
  const bash = new Bash({ cwd: "/workspace" });
  let command;
  let fallbackCount = 0;
  // Current public Workspace has no range API. Exercise optional host range
  // callbacks at the narrowest real boundary: public exec tool + disk storage +
  // actual upstream parser. This gap is explicit, not a mocked Workspace API.
  const runtime = await createJustBashRuntime({
    cwd: "/workspace", filesystem: bash.fs, loadInterpreter: interpreter,
    aroundExecute: async ({ execute, signal }) => {
      const result = await tryExecuteBinaryCommand({ bash, filesystem, command, cwd: "/workspace", root: "/workspace", binaryIO, signal, executionLimits: { maxLiveBytes: 2 * 1024 * 1024, maxInputBytes: 16 * 1024 * 1024 } });
      if (result) return result;
      fallbackCount++;
      return execute();
    },
  });
  command = "cat left.bin right.bin > joined.bin && sha256sum joined.bin";
  const result = await runtime.tool.handler({ cmd: command }, context());
  if (fail) {
    assert.equal(result.exit_code, 1);
    assert.match(result.output, /synthetic range write failure/);
    assert.equal(fallbackCount, 0, "a requested write must never be retried by the interpreter");
    assert.equal(trace.filter(({ operation }) => operation === "truncate").length, 1);
    assert.equal(trace.filter(({ operation }) => operation === "range-write").length, 1);
  } else {
    assert.equal(result.exit_code, 0, result.output);
    assert.equal(result.output, `${sha(expected)}  joined.bin\n`);
    assert.deepEqual(await readFile(join(directory, "joined.bin")), expected);
    command = "sha256sum left.bin right.bin joined.bin";
    const hashes = await runtime.tool.handler({ cmd: command }, context());
    assert.equal(hashes.output, `${sha(left)}  left.bin\n${sha(right)}  right.bin\n${sha(expected)}  joined.bin\n`);
    assert.ok(trace.every(({ operation, length }) => !operation.startsWith("whole-") && (length ?? 0) <= 1024 * 1024));
    assert.equal(fallbackCount, 0);
    const aborted = new AbortController();
    aborted.abort(new Error("synthetic cancellation"));
    const before = trace.length;
    const cancelled = await runtime.tool.handler({ cmd: command }, context(aborted.signal));
    assert.equal(cancelled.exit_code, 124);
    assert.equal(trace.length, before);
    // Empty and padding-boundary files exercise actual shell hashing, not
    // internal hash methods. All lengths cross SHA-256's 56/64-byte boundary.
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128]) {
      const bytes = pattern(length, 3);
      await writeFile(join(directory, "edge.bin"), bytes);
      command = "sha256sum edge.bin";
      const edge = await runtime.tool.handler({ cmd: command }, context());
      assert.equal(edge.output, `${sha(bytes)}  edge.bin\n`, `length=${length}`);
    }
  }
  console.log(JSON.stringify({ passed: true, journey: fail ? "range-failure" : "ranges", command: "cat left.bin right.bin > joined.bin && sha256sum joined.bin", bytes: expected.byteLength, observed: result, fallbackCount, trace }));
}
