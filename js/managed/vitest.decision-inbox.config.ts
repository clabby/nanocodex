import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Real workerd account storage, no main Worker or generated QuickJS artifacts.
// Unexpected outbound calls fail closed; all fixtures must remain synthetic.
export default defineConfig(async () => ({
  resolve: { alias: [
    { find: "nanocodex-tools/hosted", replacement: fileURLToPath(new URL("../nanocodex-tools/src/hosted/index.ts", import.meta.url)) },
    { find: /^nanocodex\/cloudflare\/(.+)$/, replacement: fileURLToPath(new URL("../nanocodex/cloudflare/", import.meta.url)) + "$1.mjs" },
  ] },
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.decision-inbox.test.jsonc" },
    miniflare: {
      bindings: { CRM_MIGRATIONS: await readD1Migrations("./migrations") },
      outboundService: () => new Response("Unexpected decision inbox test network request", { status: 502 }),
    },
  })],
  test: {
    include: ["test/todo-text-proposal.test.ts", "test/todo-source-health.test.ts", "test/todo-inbox.test.ts", "test/todo-preparation.test.ts", "test/account-auth.test.ts", "test/todo-calendar-briefings.test.ts", "test/gmail-firehose-decisions.test.ts", "test/gmail-firehose-backtest.test.ts"],
    fileParallelism: false,
  },
}));
