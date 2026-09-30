/** Opt-in HTTP journey harness; uses real remote Chromium and synthetic Vault data. */
import { DurableObject } from 'cloudflare:workers';
import { createManagedBrowserRuntime, type ManagedBrowserEnv } from '../src/browser-runtime';
import type { ToolContext } from 'nanocodex';
interface Env extends ManagedBrowserEnv { PROBE: DurableObjectNamespace<PrivateCheckoutSmoke>; FIXTURE_ORIGIN: string }
export class PrivateCheckoutSmoke extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { path?: string; deny?: boolean; wrongOrigin?: boolean; closeAfterVault?: boolean };
    if (!['/normal','/echo','/get','/direct-get','/challenge','/redirect'].includes(input.path ?? '')) return Response.json({error:'Invalid fixture path'}, {status:400});
    let vaultReads = 0;
    let runtimeClosed = false;
    let vaultReached!: () => void;
    let releaseVault!: () => void;
    const vaultReady = new Promise<void>(resolve => { vaultReached = resolve; });
    const vaultGate = new Promise<void>(resolve => { releaseVault = resolve; });
    const probe = crypto.randomUUID();
    const fixtureUrl = new URL(input.path!, this.env.FIXTURE_ORIGIN);
    fixtureUrl.searchParams.set('probe', probe);
    const runtime = await createManagedBrowserRuntime({ctx:this.ctx,env:this.env,sessionId:'synthetic-private-checkout',
      authorizeVaultAccess:()=>{if(input.deny)throw new Error('Synthetic unauthorized caller');},
      resolveVaultLogin:async request=>{
        vaultReads++;
        if(input.wrongOrigin || request.expected_origin !== this.env.FIXTURE_ORIGIN) throw new Error('Synthetic origin rejection');
        vaultReached();
        if (input.closeAfterVault) await vaultGate;
        return {username:'fixture-user@example.test',password:'fixture-password-synthetic-42'};
      },
    });
    try {
      const tool=runtime.tools.find(t=>t.name==='browser_private_checkout_inspect');
      if(!tool)throw new Error('Private inspection tool missing');
      const pending=Promise.resolve(tool.handler({vault_id:'synthetic-vault-item-123456',url:fixtureUrl.href},
        {callId:crypto.randomUUID(),signal:AbortSignal.timeout(90000)} as ToolContext));
      if (input.closeAfterVault) {
        const reached = await Promise.race([vaultReady.then(() => true), pending.then(() => false)]);
        if (!reached) throw new Error('Inspection ended before close checkpoint');
        // Start close while the resolver is suspended, then let it return. The
        // runtime must abort and await this operation before close resolves.
        const closing = runtime.close();
        releaseVault();
        await closing;
        runtimeClosed = true;
      }
      const result=await pending;
      const evidenceResponse=await fetch(new URL('/evidence?probe='+probe,this.env.FIXTURE_ORIGIN),{cache:'no-store'});
      if (!evidenceResponse.ok) throw new Error('Fixture evidence unavailable');
      const evidence=await evidenceResponse.json();
      return Response.json({result,vaultReads,runtimeClosed,evidence});
    } catch {return Response.json({error:'Private inspection rejected',vaultReads,runtimeClosed},{status:400});}
    finally{releaseVault();await runtime.close();}
  }
}
export default {fetch(request:Request,env:Env){
  if(request.method!=='POST'||new URL(request.url).pathname!=='/inspect')return new Response('Use POST /inspect',{status:404});
  return env.PROBE.getByName('private-checkout-smoke').fetch(request);
}};
export {CodemodeRuntime} from '@cloudflare/codemode';
