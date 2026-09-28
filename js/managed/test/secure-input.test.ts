import { jsonSchema, tool } from 'ai';
import type { BrowserRuntime } from 'agents/browser/ai';
import { describe, expect, it, vi } from 'vitest';
import { PrivateBrowserCdp } from '../src/browser-vault';
import { createManagedBrowserRuntime } from '../src/browser-runtime';

// Failure cases defined before implementation: destination/session/document changes,
// expiration, replay/concurrent submission, unauthorized request, injected provider
// errors, restart, and ordinary observations after secret entry must fail closed.
describe('one-time browser password boundary', () => {
  async function fixture() {
    const stored = new Map<string, unknown>();
    let loader = 'document-1', session = 'browser-1', fail = false, race = false, storageFailure = false;
    const ordinary = vi.fn(async () => 'ordinary');
    const close = vi.fn(async () => {});
    const inject = vi.fn(async () => { if (fail) throw new Error('synthetic-password'); return { result: { value: true } }; });
    const send = vi.fn(async (method: string, params?: {arguments?: {value: unknown}[]}) => {
      if (method === 'Target.getTargetInfo') return { targetInfo: { type: 'page', url: 'https://login.example/' } };
      if (method === 'Target.attachToTarget') return { sessionId: 'attached' };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top', loaderId: loader, url: 'https://login.example/' } } };
      if (method === 'Page.createIsolatedWorld') { if (race) loader = 'replacement-during-world'; return { executionContextId: 7 }; }
      if (params?.arguments?.[1]?.value === 'snapshot') return {result:{value:{status:'unknown',flags:[false,false,false],snapshot_id:params?.arguments?.[2]?.value,title:'synthetic-password',text:'Welcome synthetic-password',elements:[]}}};
      if (params?.arguments?.[6]?.value === true) return {result:{value:true}};
      return inject();
    });
    const spy = vi.spyOn(PrivateBrowserCdp, 'connect').mockResolvedValue({ send, close() {} } as unknown as PrivateBrowserCdp);
    const create = () => createManagedBrowserRuntime({
      ctx: { storage: { get: async (k: string) => stored.get(k), put: async (k: string, v: unknown) => { if (storageFailure && k.startsWith('browser-vault-quarantine')) throw new Error('storage unavailable'); stored.set(k,v); }, delete: async (k: string) => stored.delete(k) } } as unknown as DurableObjectState,
      env: { BROWSER: { fetch: vi.fn() }, LOADER: {} as WorkerLoader }, sessionId: 'agent-private', authorizeVaultAccess() {},
      createRuntime: () => ({ connector: { sessionInfo: async () => ({ sessionId: session }), closeSession: close },
        tools: { browser_execute: tool({ inputSchema: jsonSchema({ type: 'object' }), execute: ordinary }) }, runtime: {} }) as unknown as BrowserRuntime,
    });
    const context = { callId: 'input', sessionId: 'root', parentCallId: 'root', model: 'test', signal: new AbortController().signal };
    const runtime = await create();
    const request = () => runtime.tools.find(t => t.name === 'request_secure_input')!.handler({ target_id: 'tab', expected_origin: 'https://login.example', password_selector: '#pass', submit: true }, context) as Promise<{request_id: string}>;
    return { runtime, request, create, context, stored, inject, spy, close, setLoader: () => { loader = 'changed'; }, setSession: () => { session = 'changed'; }, fail: () => { fail = true; }, race: () => { race = true; }, failStorage: () => { storageFailure = true; } };
  }
  it('injects only once, persists no password, and gates observation across restart', async () => {
    const f = await fixture();
    try {
      const r = await f.request();
      const input = { request_id: r.request_id, value: 'synthetic-password' };
      const results = await Promise.allSettled([f.runtime.submitSecureInput(input, f.context.signal), f.runtime.submitSecureInput(input, f.context.signal)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(f.inject).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([...f.stored.values()])).not.toContain(input.value);
      expect(JSON.stringify(results)).not.toContain(input.value);
      const safe = await f.runtime.tools.find(t => t.name === 'secure_input_snapshot')!.handler({request_id:r.request_id},f.context);
      expect(JSON.stringify(safe)).not.toContain(input.value);
      expect(JSON.stringify(safe)).toContain('Welcome');
      await expect(f.runtime.tools.find(t => t.name === 'secure_input_action')!.handler({request_id:r.request_id,action:'navigate',url:'https://evil.example/'},f.context)).rejects.toThrow();
      const restored = await f.create();
      await expect(restored.tools.find(t => t.name === 'secure_input_snapshot')!.handler({request_id:r.request_id},f.context)).rejects.toThrow();
      await expect(restored.tools.find(t => t.name === 'browser_execute')!.handler({code:'1'}, f.context)).rejects.toThrow('isolated');
    } finally { f.spy.mockRestore(); }
  });
  it('cancels without injection, accepts 4096 characters, and closes private continuation on cancellation', async () => {
    const f = await fixture();
    try {
      const r = await f.request();
      expect(await f.runtime.submitSecureInput({request_id:r.request_id,action:'cancel'},f.context.signal)).toEqual({type:'secure_input_receipt',request_id:r.request_id,status:'cancelled'});
      await expect(f.runtime.submitSecureInput({request_id:r.request_id,value:'secret'},f.context.signal)).rejects.toThrow();
      expect(f.inject).not.toHaveBeenCalled();
      const next = await f.request();
      expect(await f.runtime.submitSecureInput({request_id:next.request_id,value:'x'.repeat(4096)},f.context.signal)).toEqual({type:'secure_input_receipt',request_id:next.request_id,status:'submitted'});
      f.setSession();
      expect(await f.runtime.submitSecureInput({request_id:next.request_id,action:'cancel'},f.context.signal)).toMatchObject({status:'cancelled'});
      expect(f.close).not.toHaveBeenCalled();
      await expect(f.runtime.tools.find(t => t.name === 'secure_input_snapshot')!.handler({request_id:next.request_id},f.context)).rejects.toThrow();
    } finally { f.spy.mockRestore(); }
  });
  it.each(['document','session','expiry','ambiguous','world-race','storage'] as const)('fails closed on %s and never replays', async mode => {
    const f = await fixture();
    try {
      const r = await f.request();
      if (mode === 'document') f.setLoader();
      if (mode === 'session') f.setSession();
      if (mode === 'expiry') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 301000); }
      if (mode === 'ambiguous') f.fail();
      if (mode === 'world-race') f.race();
      if (mode === 'storage') f.failStorage();
      const input = {request_id:r.request_id,value:'synthetic-password'};
      const result = await Promise.allSettled([f.runtime.submitSecureInput(input,f.context.signal)]);
      expect(JSON.stringify(result)).not.toContain(input.value);
      if (mode !== 'ambiguous') { expect(result[0].status).toBe('rejected'); expect(f.inject).not.toHaveBeenCalled(); }
      else expect(result[0]).toMatchObject({status:'fulfilled',value:{status:'outcome_unknown'}});
      await expect(f.runtime.submitSecureInput(input,f.context.signal)).rejects.toThrow();
    } finally { f.spy.mockRestore(); vi.useRealTimers(); }
  });
});
