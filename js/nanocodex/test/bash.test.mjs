import assert from "node:assert/strict";
import test from "node:test";

import { createJustBashRuntime, justBash } from "../tools/bash.mjs";
import { Bash } from "nanocodex-tools/just-bash/browser";

test("ordinary sequence commands work with host-managed interpreter limits", async () => {
  const runtime = await justBash({ filesystem: memoryWorkspace() });
  const result = await runtime.tool.handler({
    cmd: "for i in $(seq 1 12); do echo tick$i; done > progress.txt; tail -n 1 progress.txt",
  }, context());
  assert.equal(result.exit_code, 0, result.output);
  assert.equal(result.output, "tick12\n");
  assert.equal(new TextDecoder().decode(await runtime.filesystem.readFile("progress.txt")),
    Array.from({ length: 12 }, (_, index) => `tick${index + 1}\n`).join(""));
});

test("ordinary file commands preserve literal text through write, search, edit, and reopen", async (t) => {
  const workspace = memoryWorkspace();
  const runtime = await justBash({ filesystem: workspace });
  const literal = "price=$42; substitution=$(touch unexpected); ticks=`touch unexpected-too`; path=C:\\notes";
  const run = async (shell, cmd, expected, exit = 0) => {
    const observed = await shell.tool.handler({ cmd }, context());
    assert.equal(observed.exit_code, exit, observed.output);
    assert.equal(observed.output, expected);
    t.diagnostic(JSON.stringify({ cmd, expected, observed }));
  };
  await run(runtime, "mkdir -p notes\ncat > notes/example.txt <<'TEXT'\nheading\n" + literal + "\nstatus=old\nTEXT", "");
  await run(runtime, "cat notes/example.txt", "heading\n" + literal + "\nstatus=old\n");
  await run(runtime, "sed -n '2,3p' notes/example.txt", literal + "\nstatus=old\n");
  await run(runtime, "rg --files notes", "notes/example.txt\n");
  await run(runtime, "rg -n -F 'status=old' notes", "notes/example.txt:3:status=old\n");
  await run(runtime, "sed -i 's/status=old/status=new/g' notes/example.txt", "");
  const reopened = await justBash({ filesystem: workspace });
  await run(reopened, "cat notes/example.txt", "heading\n" + literal + "\nstatus=new\n");
  await run(reopened, "rg -n -F 'status=old' notes", "", 1);
  await run(reopened, "rg --files", "notes/example.txt\n");
});

test("buffer compatibility preserves host overrides without disabling other resource ceilings", async () => {
  for (const executionLimits of [
    { maxOutputSize: 8 },
    { maxStringLength: 8 },
    { maxOutputSize: Infinity, maxStringLength: Infinity },
  ]) {
    const filesystem = new Bash().fs;
    await filesystem.mkdir("/workspace", { recursive: true });
    const runtime = await createJustBashRuntime({
      filesystem,
      cwd: "/workspace",
      executionLimits,
    });
    const small = await runtime.tool.handler({ cmd: "seq 1 3" }, context());
    assert.equal(small.exit_code, 0, small.output);
    assert.equal(small.output, "1\n2\n3\n");
    const larger = await runtime.tool.handler({ cmd: "seq 1 12" }, context());
    if (Object.values(executionLimits).includes(8)) {
      assert.notEqual(larger.exit_code, 0);
      assert.match(larger.output, /output size limit exceeded/);
      for (const [key, value] of Object.entries(executionLimits)) assert.equal(runtime.descriptor.limits[key], value);
      assert.ok(runtime.descriptor.limits.maxInputBytes < Number.MAX_SAFE_INTEGER);
    } else {
      assert.equal(larger.exit_code, 0, larger.output);
      assert.equal(larger.output, Array.from({ length: 12 }, (_, index) => `${index + 1}\n`).join(""));
      assert.equal(runtime.descriptor.limits.maxOutputSize, undefined);
      assert.equal(runtime.descriptor.limits.maxStringLength, undefined);
      assert.ok(runtime.descriptor.limits.maxInputBytes < Number.MAX_SAFE_INTEGER);
    }
  }
});

test("Just Bash mounts one persistent workspace without a process sandbox", async () => {
  const workspace = memoryWorkspace();
  const first = await justBash({ filesystem: workspace });
  const written = await first.tool.handler({
    cmd: "mkdir -p notes && printf 'forty two\\n' > notes/answer.txt && cat notes/answer.txt",
    justification: "advisory for a host that supports approvals",
    login: true,
    yield_time_ms: 10_000,
    prefix_rule: ["mkdir"],
  }, context());

  assert.equal(written.exit_code, 0);
  assert.equal(written.output, "forty two\n");
  assert.equal(
    new TextDecoder().decode(await first.filesystem.readFile("/workspace/notes/answer.txt")),
    "forty two\n",
  );

  const reopened = await justBash({ filesystem: workspace });
  const persisted = await reopened.tool.handler({ cmd: "cat notes/answer.txt" }, context());
  assert.equal(persisted.output, "forty two\n");
});

test("rg --files traverses a large mounted workspace without escaping or stalling", async () => {
  const workspace = memoryWorkspace();
  const expected = [];
  for (let index = 0; index < 6_000; index += 1) {
    const path = `/workspace/package-${index}/source-${index}.ts`;
    expected.push(`package-${index}/source-${index}.ts`);
    await workspace.writeFile(path, "export {};\n");
  }

  const runtime = await justBash({ filesystem: workspace, maxOutputTokens: 100_000 });
  const startedAt = performance.now();
  const result = await runtime.tool.handler({ cmd: "rg --files" }, context());
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.exit_code, 0);
  assert.deepEqual(result.output.trim().split("\n"), expected.sort());
  assert.ok(elapsedMs < 3_000, `rg --files took ${Math.round(elapsedMs)}ms`);
  assert.doesNotMatch(result.output, /invalid bounded allocation count|path escapes/);
});

test("the returned filesystem is the authoritative bounded mutation handle", async () => {
  const source = memoryWorkspace();
  const runtime = await justBash({ filesystem: source });
  assert.notEqual(runtime.filesystem, source);
  await runtime.filesystem.writeFile("/workspace/from-rust.txt", "shared boundary\n");

  const result = await runtime.tool.handler({ cmd: "cat from-rust.txt" }, context());
  assert.equal(result.exit_code, 0);
  assert.equal(result.output, "shared boundary\n");
  await assert.rejects(
    runtime.filesystem.writeFile("/tmp/escape.txt", "no"),
    /escapes \/workspace/,
  );
});

test("copying a directory into itself fails without losing its contents", async () => {
  const runtime = await justBash({ filesystem: memoryWorkspace() });
  await runtime.tool.handler({ cmd: "mkdir data && echo keep > data/file" }, context());
  for (const command of ["cp -r data data/child", "mv data data/child"]) {
    const result = await runtime.tool.handler({ cmd: command }, context());
    assert.notEqual(result.exit_code, 0);
    assert.equal(new TextDecoder().decode(await runtime.filesystem.readFile("data/file")), "keep\n");
  }
});

test("workspace paths cannot escape the mounted root", async () => {
  const source = memoryWorkspace();
  const runtime = await justBash({ filesystem: source });

  await assert.rejects(
    runtime.tool.handler({ cmd: "pwd", workdir: "/tmp" }, context()),
    /path escapes \/workspace/,
  );
  await assert.rejects(
    runtime.filesystem.writeFile("../outside.txt", "no"),
    /path escapes \/workspace/,
  );
  await assert.rejects(source.readFile("/outside.txt"), { code: "ENOENT" });
});

test("network access is absent by default and an empty allow-list denies egress", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("test must not reach host fetch");
  };
  try {
    const disabled = await justBash({ filesystem: memoryWorkspace() });
    const unavailable = await disabled.tool.handler({
      cmd: "curl https://example.invalid",
    }, context());
    assert.equal(unavailable.exit_code, 127);
    assert.match(unavailable.output, /curl: command not found/);

    const restricted = await justBash({
      filesystem: memoryWorkspace(),
      network: { allowedUrlPrefixes: [] },
    });
    const denied = await restricted.tool.handler({
      cmd: "curl -sS https://example.invalid",
    }, context());
    assert.equal(denied.exit_code, 7);
    assert.match(denied.output, /Network access denied: URL not in allow-list/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the host can inject one secure fetch boundary and app-owned commands", async () => {
  const secureFetch = async (url) => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/plain" },
    body: new TextEncoder().encode(`fetched ${url}`),
    url,
  });
  const runtime = await justBash({
    filesystem: memoryWorkspace(),
    fetch: secureFetch,
    customCommands: [{
      name: "mock-tool",
      trusted: true,
      async execute(args) {
        return { stdout: `${args.join("|")}\n`, stderr: "", exitCode: 0 };
      },
    }],
  });
  assert.equal(runtime.descriptor.network.enabled, true);
  assert.equal(runtime.descriptor.network.mode, "host-fetch");
  assert(runtime.descriptor.commands.includes("curl"));
  assert(runtime.descriptor.commands.includes("mock-tool"));
  assert.deepEqual(runtime.descriptor.customCommands, ["mock-tool"]);

  const custom = await runtime.tool.handler({ cmd: "mock-tool one two" }, context());
  assert.equal(custom.exit_code, 0);
  assert.equal(custom.output, "one|two\n");
  assert.equal(typeof custom.wall_time_seconds, "number");
  const fetched = await runtime.tool.handler({ cmd: "curl -s https://example.com/data" }, context());
  assert.equal(fetched.exit_code, 0);
  assert.equal(fetched.output, "fetched https://example.com/data");
});

test("caller cancellation and the runtime deadline stop execution", async () => {
  const cancellable = await justBash({
    filesystem: memoryWorkspace(),
    executionTimeoutMs: 1_000,
  });
  const cancellation = new AbortController();
  const cancelled = cancellable.tool.handler(
    { cmd: "sleep 10" },
    { sessionId: "test", signal: cancellation.signal },
  );
  queueMicrotask(() => cancellation.abort(new Error("caller cancelled")));
  const cancelledResult = await cancelled;
  assert.equal(cancelledResult.exit_code, 124);
  assert.match(cancelledResult.output, /execution aborted/);

  const timed = await justBash({
    filesystem: memoryWorkspace(),
    executionTimeoutMs: 5,
  });
  const timedResult = await timed.tool.handler({ cmd: "sleep 10" }, context());
  assert.equal(timedResult.exit_code, 124);
  assert.match(timedResult.output, /execution (?:aborted|deadline)/);
  assert.ok(timedResult.wall_time_seconds < 1);
});

test("shared workspace startup defers listing and each command sees external changes", async () => {
  let scans = 0;
  const source = memoryWorkspace({ onList() { scans++; } });
  await source.writeFile("/workspace/existing", new TextEncoder().encode("before"));
  const runtime = await justBash({ filesystem: source, refreshFilesystemBeforeExec: true });
  assert.equal(scans, 0);
  assert.equal(new TextDecoder().decode(await runtime.filesystem.readFile("existing")), "before");
  const first = await runtime.tool.handler({ cmd: "cat existing" }, context());
  assert.equal(first.output, "before");
  assert.equal(first.exit_code, 0);
  assert.equal(scans, 1);
  await source.writeFile("/workspace/external", new TextEncoder().encode("after"));
  const second = await runtime.tool.handler({ cmd: "cat external" }, context());
  assert.equal(second.output, "after");
  assert.equal(second.exit_code, 0);
  assert.equal(scans, 2);
});

test("deferred workspace mutations load existing entries before enforcing capacity", async () => {
  let scans = 0;
  const source = memoryWorkspace({ onList() { scans++; } });
  await source.writeFile("/workspace/existing", new Uint8Array());
  const runtime = await justBash({ filesystem: source, refreshFilesystemBeforeExec: true, maxEntries: 1 });
  assert.equal(scans, 0);
  await assert.rejects(runtime.filesystem.writeFile("new", new Uint8Array()), /workspace exceeds 1 entries/);
  assert.equal(scans, 1);
  await runtime.filesystem.remove("existing");
  await runtime.filesystem.writeFile("new", new TextEncoder().encode("ok"));
  assert.equal((await runtime.tool.handler({ cmd: "cat new" }, context())).output, "ok");
});

test("deferred workspace listing failures retry without executing the command", async () => {
  let fail = true;
  const source = memoryWorkspace({ onList() { if (fail) throw new Error("storage unavailable"); } });
  const runtime = await justBash({ filesystem: source, refreshFilesystemBeforeExec: true });
  await assert.rejects(runtime.tool.handler({ cmd: "echo unsafe > created" }, context()), /storage unavailable/);
  await assert.rejects(source.readFile("/workspace/created"), { code: "ENOENT" });
  fail = false;
  assert.equal((await runtime.tool.handler({ cmd: "echo safe" }, context())).output, "safe\n");
});

test("lazy interpreter descriptor matches the eager registry with and without network", async () => {
  const command = {
    name: "mock-tool",
    async execute() { return { stdout: "lazy\n", stderr: "", exitCode: 0 }; },
  };
  const fetch = async () => ({
    status: 200, statusText: "OK", headers: {}, body: new Uint8Array(), url: "https://example.com",
  });
  for (const network of [false, true]) {
    const options = {
      filesystem: memoryWorkspace(),
      customCommands: [command],
      ...(network ? { fetch } : {}),
    };
    const eager = await justBash(options);
    const lazy = await justBash({ ...options, filesystem: memoryWorkspace(), lazyInitialize: true });
    assert.deepEqual(lazy.descriptor, eager.descriptor);
    assert.equal(lazy.instructions, eager.instructions);
    assert.deepEqual(lazy.descriptor.commands,
      [...new Bash({ ...(network ? { fetch } : {}), customCommands: [command] }).commands.keys()].sort());
    const result = await lazy.tool.handler({ cmd: "mock-tool" }, context());
    assert.equal(result.exit_code, 0, result.output);
    assert.equal(result.output, "lazy\n");
  }
});

test("lazy first command initializes once and preserves serialized refreshes", async () => {
  let scans = 0;
  const source = memoryWorkspace({ onList() { scans++; } });
  const runtime = await justBash({
    filesystem: source,
    refreshFilesystemBeforeExec: true,
    lazyInitialize: true,
  });
  assert.equal(scans, 0);
  assert.equal(runtime.descriptor.cwd, "/workspace");
  const [first, second] = await Promise.all([
    runtime.tool.handler({ cmd: "echo first > first" }, context()),
    runtime.tool.handler({ cmd: "cat first" }, context()),
  ]);
  assert.equal(first.exit_code, 0, first.output);
  assert.equal(second.output, "first\n");
  assert.equal(scans, 2);
  assert.equal((await runtime.tool.handler({ cmd: "cat first" }, context())).output, "first\n");
  assert.equal(scans, 3);
});

test("lazy interpreter retries after an initial import failure", async () => {
  let attempts = 0;
  const runtime = await justBash({
    filesystem: memoryWorkspace(),
    lazyInitialize: true,
    loadInterpreter: () => ++attempts === 1
      ? Promise.reject(new Error("interpreter unavailable"))
      : import("nanocodex-tools/just-bash/browser"),
  });
  await assert.rejects(runtime.tool.handler({ cmd: "echo first" }, context()), /interpreter unavailable/);
  assert.equal((await runtime.tool.handler({ cmd: "echo retried" }, context())).output, "retried\n");
  assert.equal(attempts, 2);
});

test("initial metadata, mutations, and returned output stay within configured bounds", async () => {
  let defaultScan;
  await justBash({
    filesystem: memoryWorkspace({
      onList(path, options) {
        defaultScan = { path, options };
      },
    }),
  });
  assert.deepEqual(defaultScan, {
    path: ".",
    options: { recursive: true },
  });

  let initialScan;
  const source = memoryWorkspace({
    onList(path, options) {
      initialScan = { path, options };
    },
  });
  const bounded = await justBash({ filesystem: source, maxEntries: 2, maxOutputTokens: 100 });
  assert.deepEqual(initialScan, {
    path: ".",
    options: { recursive: true, maxEntries: 2 },
  });

  const entryResult = await bounded.tool.handler({ cmd: "touch one two three" }, context());
  assert.equal(entryResult.exit_code, 1);
  assert.match(entryResult.output, /workspace exceeds 2 entries/);
  assert.equal((await source.readFile("/workspace/two")).byteLength, 0);
  await assert.rejects(source.readFile("/workspace/three"), { code: "ENOENT" });

  const outputResult = await bounded.tool.handler({
    cmd: "printf 1234567890123456789012345678901234567890123456789012345678901234567890",
    max_output_tokens: 16,
  }, context());
  assert.equal(outputResult.exit_code, 0);
  assert.equal(outputResult.output.length, 64);
  assert.match(outputResult.output, /\n\[output truncated by exec_command\]$/);
  assert.equal(outputResult.original_token_count, 18);
});

function context() {
  return { sessionId: "test", signal: new AbortController().signal };
}

function memoryWorkspace({ onList } = {}) {
  const files = new Map();
  const directories = new Set(["/workspace"]);
  return {
    root: "/workspace",
    async list(path, options) {
      onList?.(path, options);
      return [
        ...[...directories].filter((path) => path !== "/workspace")
          .map((path) => ({ kind: "directory", path })),
        ...[...files].map(([path, contents]) => ({ kind: "file", path, size: contents.byteLength })),
      ];
    },
    async readFile(path) {
      const contents = files.get(path);
      if (!contents) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return contents;
    },
    async writeFile(path, contents) {
      files.set(path, toBytes(contents));
      const segments = path.split("/").slice(1, -1);
      let current = "";
      for (const segment of segments) {
        current += `/${segment}`;
        directories.add(current);
      }
    },
    async remove(path, options = {}) {
      files.delete(path);
      if (options.recursive) {
        for (const candidate of files.keys()) {
          if (candidate.startsWith(`${path}/`)) files.delete(candidate);
        }
        for (const candidate of directories) {
          if (candidate === path || candidate.startsWith(`${path}/`)) directories.delete(candidate);
        }
      }
    },
    async mkdir(path) {
      const segments = path.split("/").slice(1);
      let current = "";
      for (const segment of segments) {
        current += `/${segment}`;
        directories.add(current);
      }
    },
  };
}

function toBytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

test("cp and mv admit a missing destination using filesystem ENOENT identity", async () => {
  const workspace = memoryWorkspace();
  const runtime = await justBash({ filesystem: workspace });
  const result = await runtime.tool.handler({
    cmd: "printf COPY_PROOF > source && mkdir -p target && cp source target/copied && mv target/copied target/moved && cat target/moved",
  }, context());
  assert.equal(result.exit_code, 0, result.output);
  assert.equal(result.output, "COPY_PROOF");
  assert.equal(new TextDecoder().decode(await runtime.filesystem.readFile("source")), "COPY_PROOF");
  assert.equal(new TextDecoder().decode(await runtime.filesystem.readFile("target/moved")), "COPY_PROOF");
  await assert.rejects(runtime.filesystem.readFile("target/copied"));
});

test("filesystem missing-path compatibility does not weaken copy or move alias safety", async () => {
  const workspace = memoryWorkspace();
  const runtime = await justBash({ filesystem: workspace });
  assert.equal((await runtime.tool.handler({ cmd: "mkdir -p original && printf RETAINED > original/value" }, context())).exit_code, 0);
  const reference = new Bash({ cwd: "/workspace" });
  assert.equal((await reference.exec("mkdir -p original && printf RETAINED > original/value")).exitCode, 0);
  for (const cmd of ["cp original/value original/./value", "mv original/value original/../original/value", "cp -r original original/child"]) {
    // Upstream mv intentionally accepts a same-file alias as a no-op. Keep
    // its exit contract AND assert preservation; cp/subtree copies refuse.
    const expected = await reference.exec(cmd);
    const result = await runtime.tool.handler({ cmd }, context());
    assert.equal(result.exit_code, expected.exitCode, cmd);
    assert.equal(new TextDecoder().decode(await runtime.filesystem.readFile("original/value")), "RETAINED");
  }
  await assert.rejects(runtime.filesystem.readFile("original/child/value"));
  const healthy = await runtime.tool.handler({ cmd: "printf HEALTHY" }, context());
  assert.equal(healthy.exit_code, 0); assert.equal(healthy.output, "HEALTHY");
});
