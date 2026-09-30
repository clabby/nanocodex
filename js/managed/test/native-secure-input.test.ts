import { describe, expect, it, vi } from 'vitest';
import { NativeSecureInput } from '../src/native-secure-input';

// Protocol failures specified before implementation: plaintext admission, replay,
// expiry, substituted routes, missing signing authority, ambiguous dispatch, and
// host output echo must fail closed without recording or returning private input.
describe('native secure input authority', () => {
  async function fixture(options:{missingPin?:boolean;missingSigner?:boolean;signedMismatch?:boolean;cancelRejected?:boolean;exitCode?:number;hostFailure?:boolean;responseMismatch?:boolean;responseFailure?:boolean;uid?:number}={}) {
    const keys = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']) as CryptoKeyPair;
    const key = JSON.stringify(await crypto.subtle.exportKey('jwk',keys.privateKey));
    const values = new Map<string, unknown>();
    const calls: any[] = [];
    let route = 'route-1', fail = false, substituted = false;
    const rawHost = { handler: async (input: any) => {
      calls.push(input);
      if (input.operation === 'prepare') {
        const command={executable:input.executable,arguments:input.arguments,cwd:input.cwd};
        const canonical=JSON.stringify({arguments:input.arguments,cwd:input.cwd,executable:options.signedMismatch?'/usr/bin/false':input.executable,uid:options.uid??501});
        const command_digest=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)))));
        const ticket={request_id:crypto.randomUUID(),command_digest,public_key:btoa('\x04'+'p'.repeat(64)),expires_at:Date.now()+300000,uid:options.uid??501,command};
        const message=['nanocodex-secure-sudo-ticket-v1',ticket.request_id,ticket.command_digest,ticket.public_key,String(ticket.expires_at),String(ticket.uid)].join('\n');
        const helper_signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(message)))));
        return {...ticket,helper_signature, ...(substituted?{public_key:btoa('\x04'+'s'.repeat(64))}:{})};
      }
      if(input.operation==='cancel')return {request_id:options.responseMismatch?crypto.randomUUID():input.request_id,status:options.cancelRejected?'rejected':'cancelled'};
      if (fail) throw new Error('host-private-echo');
      return {request_id:options.responseMismatch?crypto.randomUUID():input.request_id,status:'completed',exit_code:options.exitCode??0,extra:'host-private-echo'};
    }};
    // Real HostedToolsBroker/AccountHostedTools handlers return this branded shape.
    const host={handler:async(input:unknown)=>({[Symbol.for('nanocodex.toolResult')]:true,
      success:!options.hostFailure && !(options.responseFailure && (input as {operation:string}).operation!=='prepare'),structuredResult:await rawHost.handler(input),output:'untrusted-host-output',value:null,metadata:{}})};
    const runtime = new NativeSecureInput({get:async (k:string)=>values.get(k),put:async(k:string,v:unknown)=>{values.set(k,v)},delete:async(k:string)=>values.delete(k)} as any, 'agent', options.missingSigner?undefined:key,
      () => ({...host,routeToken:route}), options.missingPin?undefined:JSON.stringify({hand:btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey) as ArrayBuffer)))}));
    const request = () => runtime.prepare({machine_id:'hand',executable:'/usr/bin/id',arguments:[],cwd:'/tmp'}, {sessionId:'agent',callId:crypto.randomUUID()});
    const envelope = (request_id:string) => ({request_id,ephemeral_public_key:btoa('\x04'+'q'.repeat(64)),ciphertext:btoa('c'.repeat(48))});
    return {runtime,request,envelope,values,calls,keys,substitute:()=>{substituted=true},changeRoute:()=>{route='route-2'},fail:()=>{fail=true}};
  }
  it.each(['missingPin','missingSigner','signedMismatch','hostFailure'] as const)('rejects %s before durable admission',async mode=>{const f=await fixture({[mode]:true});await expect(f.request()).rejects.toThrow();expect(f.values.size).toBe(0)});
  it.each([0,-1,1.5,4294967296])('rejects invalid sudo peer uid %s',async uid=>{const f=await fixture({uid});await expect(f.request()).rejects.toThrow('Native secure input unavailable');expect(f.values.size).toBe(0)});
  it.each([998,1000,4294967295])('retains exact Linux peer uid %s in private review',async uid=>{const f=await fixture({uid}),request=await f.request();const review=await f.runtime.submit({request_id:request.request_id,action:'describe'});expect(review).toMatchObject({uid,machine_id:'hand',executable:'/usr/bin/id',arguments:[],cwd:'/tmp'});expect(request).not.toHaveProperty('uid');expect(request).not.toHaveProperty('public_key')});
  it('rejects a substituted recipient key before exposing a request',async()=>{const f=await fixture();f.substitute();await expect(f.request()).rejects.toThrow();expect(f.values.size).toBe(0)});
  it('does not confirm helper cancellation that was rejected',async()=>{
    const f=await fixture({cancelRejected:true}),ticket=await f.request();
    await expect(f.runtime.submit({request_id:ticket.request_id,action:'cancel'})).rejects.toThrow();
    await expect(f.runtime.submit(f.envelope(ticket.request_id))).rejects.toThrow();
  });
  it.each(['responseMismatch','responseFailure'] as const)('does not attribute %s cancellation or completion',async mode=>{
    const f=await fixture({[mode]:true}),cancel=await f.request();
    await expect(f.runtime.submit({request_id:cancel.request_id,action:'cancel'})).rejects.toThrow('Native secure input unavailable');
    await expect(f.runtime.submit(f.envelope(cancel.request_id))).rejects.toThrow();
    const submit=await f.request();
    expect(await f.runtime.submit(f.envelope(submit.request_id))).toEqual({type:'secure_input_receipt',request_id:submit.request_id,status:'outcome_unknown'});
    await expect(f.runtime.submit(f.envelope(submit.request_id))).rejects.toThrow();
  });
  it.each([[0,'completed'],[1,'failed'],[126,'failed']] as const)('reports command exit %s as %s',async(exitCode,status)=>{
    const f=await fixture({exitCode}),ticket=await f.request();
    expect(await f.runtime.submit(f.envelope(ticket.request_id))).toEqual({type:'secure_input_receipt',request_id:ticket.request_id,status});
  });
  it('signs ciphertext once, records metadata only, and returns a fixed receipt', async()=>{
    const f=await fixture(), ticket=await f.request(), input=f.envelope(ticket.request_id);
    const results=await Promise.allSettled([f.runtime.submit(input),f.runtime.submit(input)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain('host-private-echo');
    const sent=f.calls.find(c=>c.operation==='submit');
    expect(sent).toBeDefined();
    expect(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},f.keys.publicKey,Uint8Array.from(atob(sent.signature),c=>c.charCodeAt(0)),new TextEncoder().encode(['nanocodex-secure-sudo-v1',input.request_id,input.ephemeral_public_key,input.ciphertext].join('\n')))).toBe(true);
    expect(JSON.stringify([...f.values])).not.toContain(input.ciphertext);
  });
  it.each(['plaintext','route','expired','ambiguous'] as const)('rejects %s without replay',async mode=>{
    const f=await fixture(), ticket=await f.request();
    if(mode==='route')f.changeRoute();
    if(mode==='expired') vi.spyOn(Date,'now').mockReturnValue(Date.now()+301000);
    if(mode==='ambiguous')f.fail();
    const input=mode==='plaintext'?{request_id:ticket.request_id,value:'secret'}:f.envelope(ticket.request_id);
    const results=await Promise.allSettled([f.runtime.submit(input)]);
    expect(JSON.stringify(results)).not.toContain('host-private-echo');
    if(mode!=='ambiguous')expect(results[0].status).toBe('rejected');
    else expect(results[0]).toMatchObject({status:'fulfilled',value:{status:'outcome_unknown'}});
    if(mode!=='plaintext')await expect(f.runtime.submit(f.envelope(ticket.request_id))).rejects.toThrow();
    expect(f.calls.filter(c=>c.operation==='submit')).toHaveLength(mode==='ambiguous'?1:0);
    vi.restoreAllMocks();
  });
});
