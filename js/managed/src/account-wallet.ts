import type { CloudflareAccountMetadataBinding } from "nanocodex/cloudflare/egress";

export type AccountWallet = Readonly<
  | { status: "disabled" | "not_configured" | "unavailable" }
  | { status: "ready"; address: string; created_at: number; chain: "tempo"; chain_id: 4217;
      balance: Readonly<{ status: "unavailable" } | { status: "ready"; amount: string; decimals: 6; symbol: "MACH"; token: string }> }
>;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN = "0x20c000000000000000000000f37de3740adec032";

/** Read-only owner metadata. A single deadline bounds fetch and body consumption,
 * even when a transport ignores abort. Never copy broker objects into context. */
export async function accountWalletMetadata(
  binding: CloudflareAccountMetadataBinding, userId: string, signal?: AbortSignal,
): Promise<AccountWallet> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let rejectDeadline!: (reason: unknown) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const abort = () => { controller.abort(signal?.reason); rejectDeadline(signal?.reason); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    const reason = new Error("wallet metadata deadline");
    controller.abort(reason); rejectDeadline(reason);
  }, 1500);
  const read = async (suffix: string): Promise<{ status: number; value: unknown }> => {
    const response = await binding.fetch(`https://broker.internal/users/${encodeURIComponent(userId)}/wallet${suffix}`, { signal: controller.signal });
    try { return { status: response.status, value: response.ok || response.status === 404 ? await response.json() : undefined }; }
    finally { if (response.body && !response.bodyUsed) await response.body.cancel(); }
  };
  try {
    const metadata = await Promise.race([read(""), deadline]);
    const value = metadata.value;
    if (metadata.status === 404 && isRecord(value) && value.error === "wallet_not_configured") return { status: "not_configured" };
    if (metadata.status !== 200 || !isRecord(value) || typeof value.address !== "string" || !ADDRESS.test(value.address)
      || typeof value.created_at !== "number" || !Number.isSafeInteger(value.created_at) || value.created_at < 0) return { status: "unavailable" };
    const base = { status: "ready", address: value.address, created_at: value.created_at, chain: "tempo", chain_id: 4217 } as const;
    try {
      const result = await Promise.race([read("/balance"), deadline]);
      const b = result.value;
      if (result.status === 200 && isRecord(b) && typeof b.account === "string" && b.account.toLowerCase() === base.address.toLowerCase()
        && typeof b.balance === "string" && /^(0|[1-9][0-9]{0,77})$/.test(b.balance)
        && b.decimals === 6 && b.symbol === "MACH" && typeof b.token === "string" && b.token.toLowerCase() === TOKEN) {
        return { ...base, balance: { status: "ready", amount: b.balance, decimals: 6, symbol: "MACH", token: TOKEN } };
      }
    } catch { signal?.throwIfAborted(); }
    return { ...base, balance: { status: "unavailable" } };
  } catch {
    signal?.throwIfAborted();
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
