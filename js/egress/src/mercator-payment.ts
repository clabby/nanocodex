import { decodeFunctionData, parseAbi } from "viem";
import { Abis } from "viem/tempo";
import { Challenge } from "mppx";
import { tempo as paymentTempo } from "mppx/client";
import type { Provider } from "accounts";

const USDC = "0x20c000000000000000000000b9537d11c60e8b50";
const MACH = "0x20c000000000000000000000f37de3740adec032";
const SWAP = "0xf72e5107c32c655ffa7539a3c8e97b7c3ce16a3f";
const SWAP_ABI = parseAbi(["function swapTo(address inputToken,uint256 amount,address targetToken,address recipient,bytes32 memo)"]);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const MAX_UINT256 = (1n << 256n) - 1n;
interface Store { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<unknown>; }
interface Options { store: Store; wallet: ReturnType<typeof Provider.create>; signal?: AbortSignal; }
type RecordState = { fingerprint: string; challenge: string; credential?: string; status: "reserved" | "signed" | "rejected" };

export class MercatorPaymentInputError extends Error {
  readonly code: "invalid_mercator_payment_request" | "mercator_idempotency_conflict" | "mercator_prepayment_rejected" | "mercator_outcome_unknown";
  readonly status: 400 | 409 | 422 | 503;
  constructor(code: MercatorPaymentInputError["code"], status: MercatorPaymentInputError["status"]) {
    super(code); this.code = code; this.status = status;
  }
}

/** Signs only a live Mercator MCP tempo/charge challenge for one exact create_job
 * invocation. The broker never sends the credential to Mercator: the MCP SDK
 * retries the original tool call in-band with the credential metadata. A durable
 * key prevents a retry or a changed challenge from authorizing a second charge.
 */
export async function createMercatorMcpCredential(value: unknown, { store, wallet, signal: callerSignal }: Options): Promise<string> {
  if (!record(value) || Object.keys(value).some(k => !["plan", "approved_total", "idempotency_key", "id", "challenge"].includes(k))
    || !record(value.plan) || !Array.isArray(value.plan.nodes) || value.plan.nodes.length < 1
    || typeof value.idempotency_key !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(value.idempotency_key)
    || typeof value.approved_total !== "string" || !/^\d{1,72}(?:\.\d{1,6})?$/.test(value.approved_total)
    || (value.id !== undefined && (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)))) {
    throw new MercatorPaymentInputError("invalid_mercator_payment_request", 400);
  }
  const [whole, fraction = ""] = value.approved_total.split(".");
  const amount = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount <= 0n || amount > MAX_UINT256) throw new MercatorPaymentInputError("invalid_mercator_payment_request", 400);
  const planBody = canonical({ plan: value.plan, approved_total: value.approved_total, id: value.id });
  if (new TextEncoder().encode(planBody).length > 64 * 1024) throw new MercatorPaymentInputError("invalid_mercator_payment_request", 400);
  let challenge: ReturnType<typeof Challenge.Schema.parse>;
  try { challenge = Challenge.Schema.parse(value.challenge); }
  catch { throw new MercatorPaymentInputError("invalid_mercator_payment_request", 400); }
  const request = challenge.request;
  const details = request.methodDetails;
  if (challenge.method !== "tempo" || challenge.intent !== "charge" || challenge.realm !== "mercator.sh"
    || typeof challenge.expires !== "string" || !Number.isFinite(Date.parse(challenge.expires))
    || Date.parse(challenge.expires) > Date.now() + 10 * 60_000
    || typeof request.amount !== "string" || !/^\d{1,78}$/.test(request.amount) || BigInt(request.amount) !== amount
    || typeof request.currency !== "string" || ![USDC, MACH].includes(request.currency.toLowerCase())
    || typeof request.recipient !== "string" || !ADDRESS.test(request.recipient) || /^0x0{40}$/i.test(request.recipient)
    || !record(details) || details.chainId !== 4217 || details.feePayer !== true
    || details.splits !== undefined || !Array.isArray(details.supportedModes) || !details.supportedModes.includes("pull")
    || (request.currency.toLowerCase() !== MACH && details.machineTokenEnabled !== true)) {
    throw new MercatorPaymentInputError("invalid_mercator_payment_request", 400);
  }
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(callerSignal ? [callerSignal] : [])]);
  signal.throwIfAborted();
  const fingerprint = await digest(planBody);
  const challengeBody = canonical(challenge);
  const key = `mercator-mcp-payment:${value.idempotency_key}`;
  const previous = await store.get<RecordState>(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new MercatorPaymentInputError("mercator_idempotency_conflict", 409);
    if (previous.status === "signed" && previous.credential) {
      // A credential is challenge-bound. Never present it for a new challenge,
      // and never authorize a second one for an uncertain paid job.
      if (previous.challenge === challengeBody && Date.parse(challenge.expires) > Date.now()) return previous.credential;
      throw new MercatorPaymentInputError("mercator_outcome_unknown", 503);
    }
    if (previous.status !== "rejected") throw new MercatorPaymentInputError("mercator_outcome_unknown", 503);
    // A known pre-sign failure produced no payment credential. Reuse the key
    // after funding or RPC recovery even when a new challenge was issued.
  }
  if (Date.parse(challenge.expires) <= Date.now()) {
    throw new MercatorPaymentInputError("invalid_mercator_payment_request", 400);
  }
  signal.throwIfAborted();
  // Durable before invoking the signer; a lost reply never signs a second
  // challenge under the same operation key. Pull mode leaves broadcast to MCP.
  await store.put(key, { fingerprint, challenge: challengeBody, status: "reserved" } satisfies RecordState);
  let credentialProduced = false;
  try {
    signal.throwIfAborted();
    await abortable(wallet.request({ method: "wallet_connect", params: [{ chainId: "0x1079", capabilities: { method: "login" } }] } as never), signal);
    const parameters = wallet.getMppxParameters();
    const method = paymentTempo.charge({ ...parameters, mode: "pull", autoSwap: false, expectedChainId: 4217,
      async resolveAccount(info) {
        if (info.chainId !== 4217 || info.operation.kind !== "executeCalls") throw new Error("Unsupported settlement operation");
        validateSettlement(info.operation.calls, amount, request.currency as string, request.recipient as string);
        return parameters.resolveAccount(info);
      },
    });
    const credential = await abortable(method.createCredential({ challenge: challenge as never, context: {} }), signal);
    credentialProduced = true;
    signal.throwIfAborted();
    await store.put(key, { fingerprint, challenge: challengeBody, credential, status: "signed" } satisfies RecordState);
    return credential;
  } catch {
    if (!credentialProduced) {
      try {
        await store.put(key, { fingerprint, challenge: challengeBody, status: "rejected" } satisfies RecordState);
        throw new MercatorPaymentInputError("mercator_prepayment_rejected", 422);
      } catch (error) {
        if (error instanceof MercatorPaymentInputError) throw error;
      }
    }
    // An interrupted or unpersisted signed credential is uncertain; retain
    // the reservation instead of authorizing another signature.
    throw new MercatorPaymentInputError("mercator_outcome_unknown", 503);
  }
}
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function canonical(value: any): string { return JSON.stringify(value, (_key, entry) => record(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry); }
async function digest(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join(""); }
function validateSettlement(calls: unknown, amount: bigint, currency: string, recipient: string): void {
  if (!Array.isArray(calls) || calls.length !== 2 || calls.some(c => !record(c) || (c.value !== undefined && BigInt(c.value) !== 0n))) throw new Error("Only canonical MACH settlement is authorized");
  const [approval, swap] = calls;
  if (approval.to?.toLowerCase() !== MACH || swap.to?.toLowerCase() !== SWAP) throw new Error("Unsupported MACH route");
  const a = decodeFunctionData({ abi: Abis.tip20, data: approval.data });
  const b = decodeFunctionData({ abi: SWAP_ABI, data: swap.data });
  if (a.functionName !== "approve" || String(a.args[0]).toLowerCase() !== SWAP || a.args[1] !== amount
    || b.functionName !== "swapTo" || b.args[0].toLowerCase() !== MACH || b.args[1] !== amount
    || b.args[2].toLowerCase() !== currency.toLowerCase() || b.args[3].toLowerCase() !== recipient.toLowerCase()) throw new Error("Settlement exceeds approved calls");
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Mercator operation interrupted"));
    if (signal.aborted) { pending.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
