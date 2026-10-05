import { expect, test } from "@playwright/test";

test("signed-in approval has no duplicate session round trip under StrictMode", async ({ context, page }, info) => {
  await context.request.post("/v1/fixture/session", { data: { state: "persistent" } });
  const calls: { path: string; at: number }[] = [];
  const start = Date.now();
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/v1/")) calls.push({ path, at: Date.now() - start });
  });
  // A slow connection makes sequential round trips visible in the evidence.
  await page.route("**/v1/**", async route => {
    await new Promise(resolve => setTimeout(resolve, 150));
    await route.continue();
  });
  await page.goto("/?strict=1");
  const allow = page.getByRole("button", { name: "Allow access", exact: true });
  await expect(allow).toBeEnabled();
  const readyAt = Date.now() - start;
  expect(calls.map(call => call.path)).toEqual(["/v1/me"]);
  expect(await page.evaluate(() => (window as any).__hostReceipt)).toBeUndefined();
  await allow.click();
  await expect(page.getByRole("status")).toHaveText("Request approved");
  expect(calls.map(call => call.path)).toEqual([
    "/v1/me", "/v1/connect/hosted-authorization/authorize", "/v1/hosted-authorizations",
  ]);
  await info.attach("approval-latency.json", { contentType: "application/json", body: JSON.stringify({
    injectedDelayPerRequestMs: 150, readyAt, approvedAt: Date.now() - start, calls,
  }, null, 2) });
});
