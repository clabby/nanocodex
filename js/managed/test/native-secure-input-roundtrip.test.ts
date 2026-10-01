import { describe, expect, it } from 'vitest';
import { NativeSecureInput } from '../src/native-secure-input';

// Real wire crypto, not a claim of root installation or live PAM authentication.
const encoder = new TextEncoder();
const b64 = (value: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(value)));
const rawKey = async (key: CryptoKey) => {
  const bytes = await crypto.subtle.exportKey('raw', key);
  if (!(bytes instanceof ArrayBuffer)) throw new Error('Invalid public key export');
  return b64(bytes);
};
const unb64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const sign = async (key: CryptoKey, value: string) => b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(value)));
const digest = async (value: unknown) => b64(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))));
const pair = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
type Review = { request_id: string; machine_id: string; command_digest: string; public_key: string; expires_at: number; uid: number; executable: string; arguments: string[]; cwd: string };
async function keyFor(privateKey: CryptoKey, publicKey: CryptoKey, requestID: string, usage: 'encrypt' | 'decrypt') {
  const algorithm = { name: 'ECDH', public: publicKey };
  const shared = await crypto.subtle.deriveBits(algorithm, privateKey, 256);
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode(requestID) }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
async function encryptForClient(review: Review, syntheticValue: string) {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const recipient = await crypto.subtle.importKey('raw', unb64(review.public_key), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await keyFor(ephemeral.privateKey, recipient, review.request_id, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify({ request_id: review.request_id, command_digest: review.command_digest, value: syntheticValue }))));
  const combined = new Uint8Array(iv.length + sealed.length); combined.set(iv); combined.set(sealed, 12);
  return { request_id: review.request_id, ephemeral_public_key: await rawKey(ephemeral.publicKey), ciphertext: b64(combined) };
}
async function fixture(uid: number) {
  const helperIdentity = await pair(), approval = await pair();
  const storage = new Map<string, unknown>(), calls: unknown[] = [];
  const pending = new Map<string, { recipient: CryptoKeyPair; ticket: Review }>();
  let executions = 0, sawExpectedSyntheticValue = false;
  const syntheticValue = 'BOUNDARY_SYNTHETIC_ONLY_20260930';
  const handler = async (input: any) => {
    calls.push(input);
    if (input.operation === 'prepare') {
      const recipient = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
      const command = { executable: input.executable, arguments: input.arguments, cwd: input.cwd };
      const ticket: Review = { request_id: crypto.randomUUID(), machine_id: 'linux-fixture', ...command, uid, expires_at: Date.now() + 300000, command_digest: await digest({ arguments: command.arguments, cwd: command.cwd, executable: command.executable, uid }), public_key: await rawKey(recipient.publicKey) };
      pending.set(ticket.request_id, { recipient, ticket });
      const helper_signature = await sign(helperIdentity.privateKey, ['nanocodex-secure-sudo-ticket-v1', ticket.request_id, ticket.command_digest, ticket.public_key, String(ticket.expires_at), String(uid)].join('\n'));
      const { machine_id: _, ...raw } = ticket;
      return { ...raw, command, helper_signature };
    }
    if (input.operation === 'cancel') { pending.delete(input.request_id); return { request_id: input.request_id, status: 'cancelled' }; }
    const item = pending.get(input.request_id);
    if (!item) return { status: 'rejected' };
    const approved = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, approval.publicKey, unb64(input.signature), encoder.encode(['nanocodex-secure-sudo-v1', input.request_id, input.ephemeral_public_key, input.ciphertext].join('\n')));
    if (!approved) return { status: 'rejected' };
    pending.delete(input.request_id);
    try {
      const ephemeral = await crypto.subtle.importKey('raw', unb64(input.ephemeral_public_key), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const key = await keyFor(item.recipient.privateKey, ephemeral, input.request_id, 'decrypt');
      const sealed = unb64(input.ciphertext);
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, key, sealed.slice(12));
      const decoded = JSON.parse(new TextDecoder().decode(plaintext));
      if (decoded.request_id !== item.ticket.request_id || decoded.command_digest !== item.ticket.command_digest) return { status: 'rejected' };
      sawExpectedSyntheticValue = decoded.value === syntheticValue;
      executions++;
      return { request_id: input.request_id, status: 'completed', exit_code: 0, untrusted_extra: 'untrusted-helper-output' };
    } catch { return { status: 'rejected' }; }
  };
  const runtime = new NativeSecureInput({ get: async (k: string) => storage.get(k), put: async (k: string, v: unknown) => { storage.set(k, v); }, delete: async (k: string) => storage.delete(k) } as any, 'agent', JSON.stringify(await crypto.subtle.exportKey('jwk', approval.privateKey)), () => ({ routeToken: 'linux-route', handler }), JSON.stringify({ 'linux-fixture': await rawKey(helperIdentity.publicKey) }));
  const prepare = () => runtime.prepare({ machine_id: 'linux-fixture', executable: '/usr/bin/id', arguments: ['--user'], cwd: '/' }, { sessionId: 'agent', callId: crypto.randomUUID() });
  return { runtime, prepare, storage, calls, syntheticValue, stats: () => ({ executions, sawExpectedSyntheticValue, pending: pending.size }) };
}
describe('mobile/TUI-compatible encrypted Linux approval wire', () => {
  it.each([998, 1000])('binds encryption and review to actual peer uid %s without plaintext in RPC or storage', async uid => {
    const f = await fixture(uid), hint = await f.prepare();
    const review = await f.runtime.submit({ action: 'describe', request_id: hint.request_id }) as Review;
    expect(review.uid).toBe(uid);
    const envelope = await encryptForClient(review, f.syntheticValue);
    const receipt = await f.runtime.submit(envelope);
    expect(receipt).toEqual({ type: 'secure_input_receipt', request_id: hint.request_id, status: 'completed' });
    expect(f.stats()).toEqual({ executions: 1, sawExpectedSyntheticValue: true, pending: 0 });
    expect(JSON.stringify({ hint, review, envelope, receipt, calls: f.calls, storage: [...f.storage] })).not.toContain(f.syntheticValue);
    expect(JSON.stringify(receipt)).not.toContain('untrusted-helper-output');
    await expect(f.runtime.submit(envelope)).rejects.toThrow('Native secure input unavailable');
    expect(f.stats().executions).toBe(1);
  });
  it('a valid approval signature cannot repair substituted ciphertext/recipient', async () => {
    const f = await fixture(1000), first = await f.prepare(), second = await f.prepare();
    const otherReview = await f.runtime.submit({ action: 'describe', request_id: second.request_id }) as Review;
    const forOther = await encryptForClient(otherReview, f.syntheticValue);
    const envelope = { ...forOther, request_id: first.request_id };
    expect(await f.runtime.submit(envelope)).toEqual({ type: 'secure_input_receipt', request_id: first.request_id, status: 'outcome_unknown' });
    expect(f.stats().executions).toBe(0);
    await expect(f.runtime.submit(envelope)).rejects.toThrow();
    await f.runtime.submit({ action: 'cancel', request_id: second.request_id });
    expect(f.stats().pending).toBe(0);
    expect(JSON.stringify({ calls: f.calls, storage: [...f.storage] })).not.toContain(f.syntheticValue);
  });
});
