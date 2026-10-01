import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.images.test.jsonc" },
    miniflare: { outboundService: () => new Response("Unexpected test network request", { status: 502 }) } })],
  test: { include: ["test/managed-image-journey.test.ts"] },
});
