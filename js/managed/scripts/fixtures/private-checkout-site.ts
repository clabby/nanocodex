/** Public synthetic merchant fixture. No real accounts, payments, cookies or secrets. */
import { DurableObject } from 'cloudflare:workers';

interface Env { FIXTURE: DurableObjectNamespace<PrivateCheckoutFixture> }
export class PrivateCheckoutFixture extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (value: unknown) => Response.json(value, { headers: { 'cache-control': 'no-store' } });
    if (url.pathname === '/evidence' && request.method === 'GET') return json({
      credentialGetLeaks: (await this.ctx.storage.get<number>('credentialGetLeaks')) ?? 0,
      directGetAttempts: (await this.ctx.storage.get<number>('directGetAttempts')) ?? 0,
    });
    if (url.pathname === '/direct-get-attempt' && request.method === 'POST') {
      await this.ctx.storage.transaction(async storage => {
        await storage.put('directGetAttempts', ((await storage.get<number>('directGetAttempts')) ?? 0) + 1);
      });
      return json({ ok: true });
    }
    // Persist only a count, never submitted fields. This witnesses actual network
    // arrival even if Chromium refuses to show the resulting document.
    if (request.method === 'GET' && (url.searchParams.has('email') || url.searchParams.has('password'))) {
      await this.ctx.storage.transaction(async storage => {
        await storage.put('credentialGetLeaks', ((await storage.get<number>('credentialGetLeaks')) ?? 0) + 1);
      });
      return new Response('<!doctype html><h1>Checkout</h1><p>Unsafe GET reached fixture</p><button disabled>Pay</button>',
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/redirect') return Response.redirect('https://example.com/', 302);
    if (url.pathname === '/verify' && request.method === 'POST') {
      const input = await request.json() as { username?: unknown; password?: unknown; trusted?: unknown };
      return json({ ok: input.username === 'fixture-user@example.test' && input.password === 'fixture-password-synthetic-42' && input.trusted === true });
    }
    if (!['/normal', '/echo', '/get', '/direct-get', '/challenge'].includes(url.pathname)) return new Response('Synthetic private checkout fixture', { status: 404 });
    const mode = url.pathname.slice(1);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic merchant fixture</title></head><body>
      <h1>Synthetic checkout</h1><p>No real purchase is possible.</p>
      <form><label>Email <input type="email" name="email" autocomplete="off"></label>
      <label>Password <input type="password" name="password" autocomplete="off"></label>
      <input type="hidden" name="probe"><button type="submit">Sign in</button></form><div id="result"></div>
      <script>
      const mode=${JSON.stringify(mode)};
      const probe=new URL(location.href).searchParams.get('probe') || 'shared';
      document.querySelector('input[name=probe]').value=probe;
      if(mode==='direct-get')document.querySelector('form').addEventListener('submit',async event=>{
        event.preventDefault();
        const form=event.currentTarget;
        // Native submit bypasses submit-event guards, including after async work.
        await fetch('/direct-get-attempt?probe='+encodeURIComponent(probe),{method:'POST'});
        HTMLFormElement.prototype.submit.call(form);
      });
      else if(mode!=='get')document.querySelector('form').addEventListener('submit',async event=>{
        event.preventDefault();
        const username=document.querySelector('input[type=email]').value;
        const password=document.querySelector('input[type=password]').value;
        const response=await fetch('/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password,trusted:event.isTrusted})});
        if(!(await response.json()).ok){document.querySelector('#result').textContent='Sign-in failed';return;}
        if(mode==='challenge'){document.body.innerHTML='<h1>Verification required</h1><input autocomplete="one-time-code" aria-label="Verification code"><button>Verify</button>';return;}
        document.body.innerHTML='<h1>Checkout</h1><p>Subtotal $38.00</p><p>Processing fees $1.44</p><p>Total $39.44 USD</p><button disabled>Pay</button>';
        if(mode==='echo'){const leak=document.createElement('p');leak.textContent=username+' '+password+' '+btoa(password);document.body.append(leak);}
      });
      </script></body></html>`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
}
export default { fetch(request: Request, env: Env) {
  const probe = new URL(request.url).searchParams.get('probe') ?? 'shared';
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(probe)) return new Response('Invalid probe', { status: 400 });
  return env.FIXTURE.getByName(probe).fetch(request);
} };
