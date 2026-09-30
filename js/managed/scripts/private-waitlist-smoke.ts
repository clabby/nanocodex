/** Local-only HTTP harness: real managed tool, durable journal, remote Chromium. */
import { createManagedBrowserRuntime, type ManagedBrowserEnv } from '../src/browser-runtime';
import type { PrivateWaitlistInput } from '../src/browser-private-waitlist';
import type { ToolContext } from 'nanocodex';

export async function waitlistJourney(request: Request, ctx: DurableObjectState, env: ManagedBrowserEnv & { FIXTURE_ORIGIN: string }): Promise<Response> {
  const input = await request.json() as {
    probe: string; path: string; tool: Omit<PrivateWaitlistInput, 'url'>;
    deny?: boolean; wrongOrigin?: boolean; closeAfterVault?: boolean; queryVariant?: string;
  };
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(input.probe ?? '')
    || !['pure', 'zero', 'paid', 'policy', 'lost', 'echo', 'native', 'hidden-confirmation', 'hidden-identity', 'family', 'myself', 'unrelated', 'split-form', 'redirect'].includes(input.path)) return Response.json({error:'Invalid fixture request'}, {status:400});
  const fixtureUrl = new URL(input.path === 'redirect' ? '/redirect' : '/checkout/waitlist/' + input.path, env.FIXTURE_ORIGIN);
  fixtureUrl.searchParams.set('probe', input.probe);
  if (input.queryVariant) fixtureUrl.searchParams.set('variant',input.queryVariant);
  let vaultReads = 0;
  let runtimeClosed = false;
  let vaultReached!: () => void;
  let releaseVault!: () => void;
  const vaultReady = new Promise<void>(resolve => { vaultReached = resolve; });
  const vaultGate = new Promise<void>(resolve => { releaseVault = resolve; });
  const vaultCountKey = 'journey-vault-reads:' + input.probe;
  const runtime = await createManagedBrowserRuntime({ctx,env,sessionId:'synthetic-private-waitlist',
    authorizeVaultAccess:()=>{if(input.deny)throw new Error('Synthetic unauthorized caller');},
    resolveVaultLogin:async request=>{
      vaultReads++;
      await ctx.storage.transaction(async storage => {
        await storage.put(vaultCountKey, ((await storage.get<number>(vaultCountKey)) ?? 0) + 1);
      });
      if(input.wrongOrigin || request.expected_origin !== env.FIXTURE_ORIGIN) throw new Error('Synthetic origin rejection');
      vaultReached();
      if(input.closeAfterVault)await vaultGate;
      return {username:'fixture-user@example.test',password:'fixture-password-synthetic-42'};
    },
  });
  let result: unknown;
  let rejected = false;
  try {
    const tool = runtime.tools.find(tool=>tool.name==='browser_private_waitlist');
    if(!tool)throw new Error('Waitlist tool missing');
    const pending = Promise.resolve(tool.handler({...input.tool,url:fixtureUrl.href},
      {callId:crypto.randomUUID(),signal:AbortSignal.timeout(90000)} as ToolContext));
    if(input.closeAfterVault){
      const reached = await Promise.race([vaultReady.then(()=>true),pending.then(()=>false)]);
      if(!reached)throw new Error('Waitlist ended before close checkpoint');
      const closing = runtime.close();
      releaseVault();
      await closing;
      runtimeClosed = true;
    }
    result = await pending;
  } catch { rejected = true; }
  finally { releaseVault(); await runtime.close(); }
  const response = await fetch(new URL('/evidence?probe='+input.probe,env.FIXTURE_ORIGIN),{cache:'no-store'});
  if(!response.ok)throw new Error('Fixture evidence unavailable');
  return Response.json({...(rejected ? {error:'Private waitlist rejected'} : {result}),vaultReads,
    totalVaultReads:(await ctx.storage.get<number>(vaultCountKey)) ?? 0,runtimeClosed,evidence:await response.json()}, {status:rejected ? 400 : 200});
}
