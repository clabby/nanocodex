import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

async function session(context: BrowserContext, state: string) {
  const response = await context.request.post("/v1/fixture/session", { data: { state } });
  expect(response.ok()).toBe(true);
}

function observe(page: Page, info: TestInfo) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/v1/")) requests.push({ path, method: request.method(), body: request.postDataJSON() });
  });
  return {
    requests,
    async evidence() {
      expect(errors).toEqual([]);
      await info.attach("session-journey.json", { contentType: "application/json", body: JSON.stringify({
        requests, errors, receipt: await page.evaluate(() => (window as any).__hostReceipt),
      }, null, 2) });
      await info.attach("session-screen", { contentType: "image/png", body: await page.screenshot() });
    },
  };
}

async function consent(page: Page) {
  await expect(page.getByRole("heading", { name: /Connect to / })).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow access", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Mobile number" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__hostReceipt)).toBeUndefined();
}

async function signIn(page: Page) {
  await page.getByRole("textbox", { name: "Mobile number" }).fill("+12025550100");
  await page.getByRole("button", { name: "Text me a code" }).click();
  await page.getByRole("textbox", { name: "6-digit code" }).fill("123456");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

for (const presentation of ["dialog", "wizard"]) {
  test(`persistent session opens ${presentation} consent without SMS or automatic authorization`, async ({ context, page }, info) => {
    await session(context, "persistent");
    await page.setViewportSize({ width: 390, height: 844 });
    const observed = observe(page, info);
    await page.goto(presentation === "wizard" ? "/?wizard=1" : "/");
    await consent(page);
    expect(observed.requests.map(request => request.path)).toEqual(["/v1/me"]);
    if (presentation === "wizard") {
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Request cancelled");
      expect(observed.requests.filter(request => request.method === "POST")).toEqual([]);
      await page.reload();
      await consent(page);
      observed.requests.splice(0, observed.requests.length - 1);
    }
    await page.setViewportSize({ width: 320, height: 360 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const footer = page.locator(".dialog-actions, .wizard-actions");
    const footerBox = await footer.boundingBox();
    expect(footerBox!.y + footerBox!.height).toBe(360);
    const buttons = footer.getByRole("button");
    for (const button of await buttons.all()) {
      const box = await button.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      await expect(button).toBeInViewport();
    }
    await observed.evidence();
    await page.getByRole("button", { name: "Allow access", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Request approved");
    expect(observed.requests.map(request => request.path)).toEqual([
      "/v1/me", "/v1/connect/hosted-authorization/authorize", "/v1/hosted-authorizations",
    ]);
    expect(await page.evaluate(() => (window as any).__hostReceipt.result.accounts[0])).toEqual({
      address: "0x1111111111111111111111111111111111111111",
      capabilities: { auth: { approval_id: "a".repeat(43), mode: "hosted" } },
    });
    await observed.evidence();
  });
}

test("persistent SDK popup requires consent, supports cancellation and missing connectors", async ({ context, page }, info) => {
  await session(context, "persistent");
  await page.goto("/launcher.html");
  let opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect account" }).click();
  let popup = await opened;
  const cancelled = observe(popup, info);
  await consent(popup);
  await popup.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(popup.getByRole("status")).toHaveText("Request cancelled");
  expect(cancelled.requests.filter(request => request.method === "POST")).toEqual([]);
  await cancelled.evidence();
  await popup.close();

  // A new popup must independently read the server session.
  opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect account" }).click();
  popup = await opened;
  const observed = observe(popup, info);
  await consent(popup);
  await popup.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Allow access", exact: true })).toBeDisabled();
  const providerOpened = popup.waitForEvent("popup");
  await popup.getByRole("button", { name: /Google Workspace.*Connect/ }).click();
  const provider = await providerOpened;
  await provider.getByRole("button", { name: "Approve Gmail and Calendar" }).click();
  await expect(popup.getByRole("button", { name: "Allow access", exact: true })).toBeEnabled();
  expect(await popup.evaluate(() => (window as any).__hostReceipt)).toBeUndefined();
  await popup.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(popup.getByRole("status")).toHaveText("Request approved");
  expect(observed.requests.some(request => request.path.includes("/sms/"))).toBe(false);
  await observed.evidence();
});

test("expired session falls back to SMS and still requires consent after recovery", async ({ context, page }, info) => {
  await session(context, "expired");
  const observed = observe(page, info);
  await page.goto("/");
  await expect(page.getByText("Your session expired. Sign in again.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Mobile number" })).toBeFocused();
  await signIn(page);
  await consent(page);
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Request approved");
  expect(observed.requests.filter(request => request.path.includes("/sms/")).map(request => request.path)).toEqual([
    "/v1/auth/sms/start", "/v1/auth/sms/verify",
  ]);
  await observed.evidence();
});

for (const expiry of ["before-consent", "during-authorization"]) {
  test(`session expires ${expiry}: fallback is cancellable and never returns a grant`, async ({ context, page }, info) => {
    await session(context, expiry === "before-consent" ? "persistent" : "expire-on-authorization");
    const observed = observe(page, info);
    await page.goto("/");
    await consent(page);
    if (expiry === "before-consent") await session(context, "expired");
    await page.getByRole("button", { name: "Allow access", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Mobile number" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("session expired");
    expect(observed.requests.some(request => request.path === "/v1/hosted-authorizations")).toBe(false);
    expect(await page.evaluate(() => (window as any).__hostReceipt)).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("status")).toHaveText("Request cancelled");
    await observed.evidence();
  });
}

for (const state of ["anonymous", "missing-address"]) {
  test(`${state} session cannot use hosted account reuse`, async ({ context, page }, info) => {
    await session(context, state);
    const observed = observe(page, info);
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "Mobile number" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow access", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Request cancelled");
    expect(observed.requests.filter(request => request.method === "POST")).toEqual([]);
    await observed.evidence();
  });
}

for (const policy of ["spending", "fresh-auth"]) {
  test(`${policy} retains fresh authentication with a persistent session`, async ({ context, page }, info) => {
    await session(context, "persistent");
    const observed = observe(page, info);
    await page.goto(`/?${policy}=1`);
    await expect(page.getByRole("textbox", { name: "Mobile number" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow access", exact: true })).toHaveCount(0);
    expect(observed.requests.filter(request => request.method === "POST")).toEqual([]);
    await observed.evidence();
  });
}

test("unavailable session checks can retry without starting SMS", async ({ context, page }, info) => {
  await session(context, "unavailable");
  const observed = observe(page, info);
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("unavailable");
  await expect(page.getByRole("textbox", { name: "Mobile number" })).toHaveCount(0);
  await session(context, "persistent");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await consent(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Request cancelled");
  expect(observed.requests.map(request => request.path)).toEqual(["/v1/me", "/v1/me"]);
  await observed.evidence();
});

test("signed-in consent has only the requested decision actions and cancellation never authorizes", async ({ context, page }, info) => {
  await session(context, "persistent");
  const observed = observe(page, info);
  await page.goto("/");
  await consent(page);
  await expect(page.getByRole("button", { name: "Use a different account", exact: true })).toHaveCount(0);
  await expect(page.locator(".dialog-actions button")).toHaveCount(2);
  expect(observed.requests.filter(request => request.method === "POST")).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Request cancelled");
  await observed.evidence();
});

for (const stage of ["authorization", "exchange"]) {
  test(`replacing a request during hosted ${stage} cannot settle the new request`, async ({ context, page }, info) => {
    await session(context, `delayed-${stage}`);
    const observed = observe(page, info);
    await page.goto("/?replace-request=1");
    await consent(page);
    const path = stage === "authorization" ? "/v1/connect/hosted-authorization/authorize" : "/v1/hosted-authorizations";
    const started = page.waitForRequest(request => new URL(request.url()).pathname === path);
    const finished = page.waitForResponse(response => new URL(response.url()).pathname === path);
    const allow = page.getByRole("button", { name: "Allow access", exact: true });
    const before = await allow.boundingBox();
    await allow.click();
    await started;
    const connecting = page.getByRole("button", { name: "Connecting…", exact: true });
    await expect(connecting).toBeDisabled();
    await expect(connecting).toHaveAttribute("aria-busy", "true");
    expect(await connecting.boundingBox()).toEqual(before);
    await page.getByRole("button", { name: "Replace request", exact: true }).click();
    await (await finished).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await consent(page);
    expect(observed.requests.filter(request => request.path === "/v1/hosted-authorizations")).toHaveLength(stage === "authorization" ? 0 : 1);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Request cancelled");
    await observed.evidence();
  });
}

test("focused session consent displays every requested provider and app permission", async ({ context, page }, info) => {
  await session(context, "persistent");
  const observed = observe(page, info);
  await page.goto("/?connections=1&focused=1");
  await consent(page);
  await expect(page.getByRole("button", { name: /GitHub/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Google Workspace/ })).toBeVisible();
  for (const permission of ["Run agents", "Read replies", "View tool calls"]) {
    await expect(page.getByRole("button", { name: new RegExp(permission) })).toBeVisible();
  }
  expect(observed.requests.filter(request => request.method === "POST")).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Request cancelled");
  await observed.evidence();
});

test("account changed in another tab requires new consent with the new account label", async ({ context, page }, info) => {
  await session(context, "persistent");
  const observed = observe(page, info);
  await page.goto("/");
  await consent(page);
  const previousLabel = await page.locator(".consent-account").textContent();
  await session(context, "persistent-other");
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("account changed");
  await consent(page);
  await expect(page.locator(".consent-account")).not.toHaveText(previousLabel!);
  await expect(page.locator(".consent-account")).toContainText("2222");
  expect(observed.requests.filter(request => request.method === "POST").map(request => request.path)).toEqual(["/v1/connect/hosted-authorization/authorize"]);
  expect(await page.evaluate(() => (window as any).__hostReceipt)).toBeUndefined();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Request approved");
  expect(await page.evaluate(() => (window as any).__hostReceipt.result.accounts[0].address)).toBe("0x2222222222222222222222222222222222222222");
  expect(observed.requests.some(request => request.path.includes("/sms/"))).toBe(false);
  await observed.evidence();
});

for (const stage of ["authorization", "exchange"]) {
  test(`closing Connect during hosted ${stage} prevents late approval`, async ({ context, page }, info) => {
    await session(context, `delayed-${stage}`);
    const observed = observe(page, info);
    await page.goto("/?unmount=1");
    await consent(page);
    const path = stage === "authorization" ? "/v1/connect/hosted-authorization/authorize" : "/v1/hosted-authorizations";
    const started = page.waitForRequest(request => new URL(request.url()).pathname === path);
    const finished = page.waitForResponse(response => new URL(response.url()).pathname === path);
    await page.getByRole("button", { name: "Allow access", exact: true }).click();
    await started;
    await page.getByRole("button", { name: "Close Connect", exact: true }).click();
    await (await finished).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.getByRole("status")).toHaveText("Connect closed");
    expect(await page.evaluate(() => (window as any).__hostReceipt)).toBeUndefined();
    expect(observed.requests.filter(request => request.path === "/v1/hosted-authorizations")).toHaveLength(stage === "authorization" ? 0 : 1);
    await observed.evidence();
  });
}

test("StrictMode session consent remains usable after effect cleanup and replay", async ({ context, page }, info) => {
  await session(context, "persistent");
  const observed = observe(page, info);
  await page.goto("/?strict=1");
  await consent(page);
  expect(observed.requests.filter(request => request.method === "POST")).toEqual([]);
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Request approved");
  expect(observed.requests.filter(request => request.path === "/v1/hosted-authorizations")).toHaveLength(1);
  await observed.evidence();
});
