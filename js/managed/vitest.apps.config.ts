import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    main: "./test/prompt-apps-worker.ts",
    miniflare: {
      compatibilityDate: "2026-07-29",
      compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
      d1Databases: { NANOCODEX_CRM: "nanocodex-apps-test" },
      bindings: { CRM_MIGRATIONS: await readD1Migrations("./migrations") },
      outboundService: () => new Response("Unexpected external request", { status: 502 }),
    },
  })],
  test: {
    include: ["test/prompt-apps.test.ts"],
  },
}));
