import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Exercise the actual account broker and CUA namespace without loading unrelated
// agent WASM. Native display/input is the only external dependency in these journeys.
export default defineConfig({
  plugins: [cloudflareTest({ miniflare: {
    compatibilityDate: "2026-07-29",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    durableObjects: { NANOCODEX_ACCOUNT_TOOLS: { className: "AccountHostedTools", useSQLite: true } },
    outboundService: () => new Response("Unexpected Hand transport test network request", { status: 502 }),
  }, main: "./test/sandbox-enrollment-worker.ts" })],
  test: { include: ["test/hand-remote-agent.test.ts"] },
});
