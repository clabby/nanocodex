import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: [
    { find: "nanocodex-tools/hosted", replacement: fileURLToPath(new URL("../nanocodex-tools/src/hosted/index.ts", import.meta.url)) },
    { find: /^nanocodex\/cloudflare\/(.+)$/, replacement: fileURLToPath(new URL("../nanocodex/cloudflare/", import.meta.url)) + "$1.mjs" },
  ] },
  plugins: [cloudflareTest({
    main: "./test/hosted-tools-worker.ts",
    miniflare: {
      compatibilityDate: "2026-07-29",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public", "enable_request_signal"],
      durableObjects: { NANOCODEX_ACCOUNT_TOOLS: { className: "AccountHostedTools", useSQLite: true } },
      outboundService: () => new Response("Unexpected hosted tools test network request", { status: 502 }),
    },
  })],
  test: {
    include: ["test/account-hosted-tools.test.ts", "test/hosted-tools-broker.test.ts", "test/hosted-tools-protocol.test.ts"],
    fileParallelism: false,
  },
});
