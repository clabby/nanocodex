import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    main: "./test/prompt-apps-worker.ts",
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      bindings: { CRM_MIGRATIONS: await readD1Migrations("./migrations") },
      outboundService: () => new Response("Unexpected external request", { status: 502 }),
    },
  })],
  test: {
    include: ["test/prompt-apps.test.ts"],
    deps: { optimizer: { ssr: { enabled: true, include: ["cron-parser"] } } },
  },
}));
