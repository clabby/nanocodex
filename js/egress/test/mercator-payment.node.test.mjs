import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Provider, secp256k1, Storage } from "accounts";
import { custom, decodeFunctionData, parseAbi } from "viem";
import { Transaction, Abis } from "viem/tempo";
import { tempo } from "viem/tempo/chains";
import { Challenge, Credential } from "mppx";
import { createMercatorMcpCredential, MercatorPaymentInputError } from "../src/mercator-payment.ts";
// Protocol failures: quote drift, token/chain/recipient escalation, redirects,
// duplicate/concurrent submission, and lost response after signing. The positive
// scenario uses the actual Accounts signer; only merchant/RPC transport is fake.
const payee = "0x0000000000000000000000000000000000000002";
const input = { idempotency_key: "synthetic-lookup-1", approved_total: "0.05", plan: { nodes: [{ id: "one", serviceId: "synthetic", method: "GET", path: "/lookup", input: {} }] } };
function fixture(patch = {}, loseResponse = false, challengePatch = {}) {
    const rows = new Map();
    const store = { async get(key) { return rows.get(key); }, async put(key, value) { rows.set(key, value); } };
    const wallet = Provider.create({ adapter: secp256k1({ privateKey: `0x${"12".repeat(32)}` }), storage: Storage.memory(), chains: [tempo], mpp: false,
        transports: { [tempo.id]: custom({ async request({ method, params }) {
                    if (method === "eth_call" && params?.[0]?.calls) return "0x";
                    if (method === "eth_chainId")
                        return "0x1079";
                    if (method === "eth_call") {
                        if (params?.[0]?.data?.startsWith("0x70a08231")) return `0x${"0".repeat(58)}ffffff`;
                        if (params?.[0]?.data === "0x313ce567") return `0x${"0".repeat(63)}6`;
                        return `0x${"0".repeat(64)}`;
                    }
                    if (method === "eth_estimateGas")
                        return "0x186a0";
                    if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas")
                        return "0x1";
                    if (method === "eth_getTransactionCount")
                        return "0x0";
                    if (method === "eth_getBlockByNumber")
                        return { number: "0x1", timestamp: "0x1", baseFeePerGas: "0x1", gasLimit: "0x1000000", gasUsed: "0x0" };
                    throw new Error(`Unexpected RPC ${method}`);
                } }) } });
    let submissions = 0;
    let credential;
    const fetcher = async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)), { idempotencyKey: input.idempotency_key, plan: input.plan });
        const headers = new Headers(init?.headers);
        if (headers.has("authorization")) {
            submissions++;
            credential = Credential.deserialize(headers.get("authorization"));
            if (loseResponse)
                throw new Error("lost response");
            return Response.json({ id: "synthetic-job", status: "pending" }, { status: 201 });
        }
        return new Response(null, { status: 402, headers: { "www-authenticate": Challenge.serialize(Challenge.from({
                    id: "synthetic-challenge", realm: "mercator.sh", method: "tempo", intent: "charge",
                    expires: new Date(Date.now() + 60_000).toISOString(), ...challengePatch,
                    request: { amount: "50000", currency: "0x20c000000000000000000000b9537d11c60e8b50", recipient: payee, methodDetails: { chainId: 4217, feePayer: true, supportedModes: ["pull"], machineTokenEnabled: true }, ...patch },
                })) } });
    };
    return { store, wallet, fetcher, submissions: () => submissions, credential: () => credential };
}

async function paymentInput(f, patch = {}, top = {}) {
  const quote = await f.fetcher(null, { body: JSON.stringify({ idempotencyKey: input.idempotency_key, plan: input.plan }) });
  const challenge = Challenge.deserialize(quote.headers.get("www-authenticate"));
  return { ...input, challenge: { ...challenge, ...top, request: { ...challenge.request, ...patch } } };
}
const sign = (f, v, extra = {}) => createMercatorMcpCredential(v, { store: f.store, wallet: f.wallet, ...extra });
describe("Mercator MCP payment", () => {
  it("signs a sponsored MACH pull credential once and replays it", async () => {
    const f = fixture(), v = await paymentInput(f);
    const encoded = await sign(f, v), c = Credential.deserialize(encoded);
    assert.equal(c.payload.type, "transaction");
    const tx = Transaction.deserialize(c.payload.signature);
    assert.equal(tx.chainId, 4217); assert.equal(tx.feePayerSignature, null);
    assert.equal(tx.calls.length, 2);
    const approve = decodeFunctionData({ abi: Abis.tip20, data: tx.calls[0].data });
    assert.equal(approve.functionName, "approve"); assert.equal(approve.args[1], 50000n);
    const swap = decodeFunctionData({ abi: parseAbi(["function swapTo(address inputToken,uint256 amount,address targetToken,address recipient,bytes32 memo)"]), data: tx.calls[1].data });
    assert.equal(swap.functionName, "swapTo"); assert.equal(swap.args[1], 50000n);
    assert.equal(swap.args[3].toLowerCase(), payee);
    assert.equal(await sign(f, v), encoded);
    await assert.rejects(sign(f, { ...v, plan: { nodes: [{ id: "changed" }] } }), e => e instanceof MercatorPaymentInputError && e.status === 409);
    await assert.rejects(sign(f, { ...v, challenge: { ...v.challenge, id: "new" } }),
      e => e instanceof MercatorPaymentInputError && e.status === 503);
  });
  it("signs a Mercator-quoted total above the removed Nanocodex price ceiling", async () => {
    const f = fixture(), v = await paymentInput(f, { amount: "60000" });
    const encoded = await sign(f, { ...v, approved_total: "0.06" });
    const tx = Transaction.deserialize(Credential.deserialize(encoded).payload.signature);
    const approve = decodeFunctionData({ abi: Abis.tip20, data: tx.calls[0].data });
    assert.equal(approve.args[1], 60000n);
  });
  it("never re-signs a fresh challenge after the original signed credential expires", async () => {
    const f = fixture(), v = await paymentInput(f);
    await sign(f, v);
    const key = `mercator-mcp-payment:${input.idempotency_key}`;
    const previous = await f.store.get(key);
    await f.store.put(key, { ...previous, challenge: JSON.stringify({ ...v.challenge, expires: new Date(0).toISOString() }) });
    await assert.rejects(sign(f, { ...v, challenge: { ...v.challenge, id: "new" } }),
      e => e instanceof MercatorPaymentInputError && e.status === 503);
    assert.equal((await f.store.get(key)).status, "signed");
  });
  it("rejects foreign, changed or unsupported charge terms before reservation", async () => {
    for (const [patch, top] of [[{ amount: "50001" }, {}], [{ currency: payee }, {}], [{ recipient: "bad" }, {}],
      [{ methodDetails: { chainId: 1, feePayer: true, supportedModes: ["pull"] } }, {}], [{}, { expires: new Date(0).toISOString() }],
      [{}, { realm: "foreign.example" }], [{ methodDetails: { chainId: 4217, feePayer: true, supportedModes: ["push"] } }, {}]]) {
      const f = fixture(), v = await paymentInput(f, patch, top);
      await assert.rejects(sign(f, v), e => e instanceof MercatorPaymentInputError && e.status === 400);
      assert.equal(await f.store.get(`mercator-mcp-payment:${input.idempotency_key}`), undefined);
    }
    const f = fixture(), v = await paymentInput(f);
    await assert.rejects(sign(f, { ...v, approved_total: "0.050001" }), e => e instanceof MercatorPaymentInputError && e.status === 400);
  });
  it("retries the same key after a known pre-sign failure without risking a second paid submission", async () => {
    const f = fixture(), v = await paymentInput(f), original = f.wallet.request.bind(f.wallet);
    let fail = true;
    f.wallet.request = (...args) => { if (fail) { fail = false; throw Error("temporary RPC failure"); } return original(...args); };
    await assert.rejects(sign(f, v), e => e instanceof MercatorPaymentInputError && e.status === 422);
    assert.equal((await f.store.get(`mercator-mcp-payment:${input.idempotency_key}`)).status, "rejected");
    const next = { ...v, challenge: { ...v.challenge, id: "new" } };
    assert.equal(Credential.deserialize(await sign(f, next)).payload.type, "transaction");
  });
  it("does not reserve canceled requests or re-sign uncertain outcomes", async () => {
    const f = fixture(), v = await paymentInput(f), controller = new AbortController(); controller.abort();
    await assert.rejects(sign(f, v, { signal: controller.signal }));
    assert.equal(await f.store.get(`mercator-mcp-payment:${input.idempotency_key}`), undefined);
    let writes = 0; const put = f.store.put;
    f.store.put = async (key, value) => { if (++writes === 2) throw Error("storage interrupted"); return put(key, value); };
    await assert.rejects(sign(f, v), e => e instanceof MercatorPaymentInputError && e.status === 503);
    await assert.rejects(sign(f, v), e => e instanceof MercatorPaymentInputError && e.status === 503);
    assert.equal(writes, 2);
  });
});
