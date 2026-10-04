import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../../../../output/connect-full-page/results",
  reporter: [["list"], ["json", { outputFile: fileURLToPath(new URL("../../../../output/connect-full-page/report.json", import.meta.url)) }]],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://modal.nanocodex.localhost:4198",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ["--host-resolver-rules=MAP *.nanocodex.localhost 127.0.0.1"] },
    trace: "on",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --config test/browser/vite.config.ts",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: "http://127.0.0.1:4198",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
