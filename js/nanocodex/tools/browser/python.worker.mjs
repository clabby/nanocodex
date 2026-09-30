/// <reference lib="webworker" />
import { installBrowserEgressFetch } from "./browserEgress.mjs";
const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.5/full/";
// The interpreter, stdlib, and packages already stream from this pinned CDN
// release. Loading its ESM loader from the same URL keeps loader and runtime
// versions identical and keeps the 13 MB npm distribution out of installs.
// The specifier is a variable so bundlers leave the cross-origin import alone.
const PYODIDE_LOADER_URL = `${PYODIDE_INDEX_URL}pyodide.mjs`;
async function loadPyodide(options) {
    let module;
    try {
        module = await import(/* @vite-ignore */ /* webpackIgnore: true */ PYODIDE_LOADER_URL);
    }
    catch (error) {
        throw new Error(`Failed to load the Pyodide runtime from ${PYODIDE_LOADER_URL}. `
            + "Browser python needs network access to cdn.jsdelivr.net and a Content-Security-Policy "
            + "that allows scripts from it.", { cause: error });
    }
    return module.loadPyodide(options);
}
let workspaceRoot;
let egress;
let runtimePromise;
self.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "initialize") {
        workspaceRoot = message.workspaceRoot;
        egress = message.egress;
        return;
    }
    if (message.type !== "execute" || typeof message.id !== "number")
        return;
    void execute(message.id, message.input);
});
async function execute(id, input) {
    try {
        const parsed = input;
        const { pyodide, nativeFs } = await runtime();
        await nativeFs.syncfs();
        let stdout = "";
        let stderr = "";
        let stdinOffset = 0;
        pyodide.setStdout({ batched: (line) => stdout += `${line}\n` });
        pyodide.setStderr({ batched: (line) => stderr += `${line}\n` });
        pyodide.setStdin({
            stdin: () => {
                if (stdinOffset >= input.stdin.length)
                    return null;
                const newline = input.stdin.indexOf("\n", stdinOffset);
                const end = newline < 0 ? input.stdin.length : newline + 1;
                const chunk = input.stdin.slice(stdinOffset, end);
                stdinOffset = end;
                return chunk;
            },
            autoEOF: true,
        });
        const globals = pyodide.toPy({
            argv: parsed.argv,
            cwd: input.cwd,
            source: parsed.source ?? "",
            hasSource: parsed.source !== null,
            filename: parsed.filename,
            moduleName: parsed.moduleName ?? "",
            hasModule: parsed.moduleName !== null,
        });
        try {
            await pyodide.runPythonAsync(PYTHON_LAUNCHER, { globals });
            await nativeFs.syncfs();
            self.postMessage({ id, result: { stdout, stderr, exitCode: 0 } });
        }
        catch (error) {
            await nativeFs.syncfs().catch(() => undefined);
            self.postMessage({
                id,
                result: {
                    stdout,
                    stderr: `${stderr}${formatPythonError(error)}\n`,
                    exitCode: pythonExitCode(error),
                },
            });
        }
        finally {
            globals.destroy();
        }
    }
    catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
}
async function runtime() {
    if (!runtimePromise) {
        runtimePromise = (async () => {
            if (!workspaceRoot)
                throw new Error("Python worker was not initialized");
            if (!egress)
                throw new Error("Python worker egress was not initialized");
            installBrowserEgressFetch({
                ...egress,
                fetch: globalThis.fetch,
            });
            const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
            const nativeFs = await pyodide.mountNativeFS("/workspace", workspaceRoot);
            return { pyodide, nativeFs };
        })();
    }
    return runtimePromise;
}
function formatPythonError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.trim() || "Python execution failed";
}
function pythonExitCode(error) {
    const match = /SystemExit:\s*(\d+)/.exec(error instanceof Error ? error.message : String(error));
    return match ? Number(match[1]) : 1;
}
const PYTHON_LAUNCHER = `
import os
import runpy
import sys

os.chdir(cwd)
sys.argv = list(argv)
if hasModule:
    runpy.run_module(moduleName, run_name="__main__", alter_sys=True)
elif hasSource:
    scope = {"__name__": "__main__", "__file__": filename}
    exec(compile(source, filename, "exec"), scope, scope)
else:
    runpy.run_path(filename, run_name="__main__")
`;
