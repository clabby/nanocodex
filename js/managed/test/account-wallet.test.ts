import { expect, it, vi } from "vitest";
import { accountInfo, projectAccountInfo } from "../src/account-info";
import { accountWalletMetadata } from "../src/account-wallet";
const address = `0x${"1".repeat(40)}`;
const token = "0x20c000000000000000000000f37de3740adec032";
const wallet = { address, created_at: 1, privateKey: "synthetic-secret" };
const balance = { account: address, balance: "12345678", decimals: 6, symbol: "MACH", token, secret: "synthetic-secret" };
it("discovers only public wallet fields and fences owner snapshots from delegated grants", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).endsWith("/balance") ? balance : String(input).endsWith("/wallet") ? wallet : String(input).endsWith("/connectors") ? { connectors: {} } : { vault: [] }));
  const info = await accountInfo({ fetch }, "user", { enabled: true });
  expect(info.wallet).toEqual({ status: "ready", address, created_at: 1, chain: "tempo", chain_id: 4217, balance: { status: "ready", amount: "12345678", decimals: 6, symbol: "MACH", token } });
  expect(info.identity).toEqual({ tempoAddress: address });
  expect(info.stablecoins).toEqual([{ token, symbol: "MACH", balance: "12345678", decimals: 6 }]);
  expect(projectAccountInfo(info, [])).toMatchObject({ identity: {}, stablecoins: [] });
  expect(JSON.stringify(info)).not.toContain("synthetic-secret");
  expect(projectAccountInfo(info, []).wallet).toEqual({ status: "disabled" });
  fetch.mockClear();
  expect((await accountInfo({ fetch }, "user", { enabled: true, allowedConnectors: [] })).wallet).toEqual({ status: "disabled" });
  expect(fetch.mock.calls.some(([url]) => String(url).includes("/wallet"))).toBe(false);
});
it("distinguishes an absent wallet from a failed read", async () => {
  expect(await accountWalletMetadata({ fetch: async () => Response.json({ error: "wallet_not_configured" }, { status: 404 }) }, "user")).toEqual({ status: "not_configured" });
  expect(await accountWalletMetadata({ fetch: async () => new Response(null, { status: 404 }) }, "user")).toEqual({ status: "unavailable" });
  expect(await accountWalletMetadata({ fetch: async () => Response.json({ error: "not_found" }, { status: 404 }) }, "user")).toEqual({ status: "unavailable" });
  expect(await accountWalletMetadata({ fetch: async () => new Response(null, { status: 503 }) }, "user")).toEqual({ status: "unavailable" });
});
it("retains address and connectors when balance fails validation or availability", async () => {
  for (const response of [new Response(null, { status: 503 }), Response.json({ ...balance, account: `0x${"2".repeat(40)}` })]) {
    const info = await accountInfo({ fetch: async input => String(input).endsWith("/balance") ? response : Response.json(String(input).endsWith("/wallet") ? wallet : String(input).endsWith("/connectors") ? { connectors: { github: { connected: true, label: "example" } } } : { vault: [] }) }, "user", { enabled: true });
    expect(info).toMatchObject({ status: "ready", authenticated: ["github"], wallet: { status: "ready", address, balance: { status: "unavailable" } } });
  }
});
it("bounds a transport that ignores cancellation and preserves caller cancellation", async () => {
  vi.useFakeTimers();
  try {
    const pending = accountWalletMetadata({ fetch: () => new Promise<Response>(() => {}) }, "user");
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual({ status: "unavailable" });
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const cancelled = accountWalletMetadata({ fetch: () => new Promise<Response>(() => {}) }, "user", controller.signal);
    const assertion = expect(cancelled).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
  } finally { vi.useRealTimers(); }
});
