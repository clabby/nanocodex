/** Temporary synthetic merchant. No real accounts or payment integration. */
import { DurableObject } from 'cloudflare:workers';
interface Env { FIXTURE: DurableObjectNamespace<PrivateBrowserFixture> }
const counters = ['loginPosts','bookingPosts','profilePosts','checkoutPosts','publicAuthenticated','credentialGetLeaks','takeoverInputs'] as const;
export class PrivateBrowserFixture extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (value: unknown) => Response.json(value,{headers:{'cache-control':'no-store'}});
    const increment = async (key:string) => this.ctx.storage.transaction(async store => store.put(key,((await store.get<number>(key))??0)+1));
    if (url.pathname === '/secure-evidence') return json({loginPosts:(await this.ctx.storage.get<number>('loginPosts'))??0,securePosts:(await this.ctx.storage.get<number>('securePosts'))??0,credentialGetLeaks:(await this.ctx.storage.get<number>('credentialGetLeaks'))??0});
    if (url.pathname === '/secure-form') {
      if (!request.headers.get('cookie')?.includes('synthetic_private=authenticated')) return new Response('Sign in first',{status:401});
      return new Response(securePage(url.searchParams.get('probe')??'shared'),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
    }
    if (url.pathname === '/evidence') return json(Object.fromEntries(await Promise.all(counters.map(async key=>[key,(await this.ctx.storage.get<number>(key))??0]))));
    if (request.method === 'GET' && (url.searchParams.has('password') || url.searchParams.has('email'))) await increment('credentialGetLeaks');
    if (url.pathname === '/takeover') return new Response(`<!doctype html><title>Synthetic private takeover</title><h1>Private typing test</h1><input autofocus aria-label="Private test field" id="private-field"><p id="echo"></p><script>document.querySelector('input').addEventListener('input',async event=>{document.querySelector('#echo').textContent=event.target.value;await fetch('/takeover-input?probe='+encodeURIComponent(new URL(location.href).searchParams.get('probe')),{method:'POST'});});</script>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
    if (request.method === 'POST') {
      if(url.pathname === '/takeover-input'){await increment('takeoverInputs');return json({ok:true});}
      if(url.pathname === '/login') {
        const input = await request.json() as {username?:string;password?:string};
        const ok=input.username==='generic-fixture@example.test'&&input.password==='generic-synthetic-password-42';
        if(ok)await increment('loginPosts');
        return new Response(JSON.stringify({ok}),{headers:{'content-type':'application/json','set-cookie':ok?'synthetic_private=authenticated; Path=/; Secure; HttpOnly; SameSite=Lax':'synthetic_private=; Max-Age=0; Path=/'}});
      }
      if (!request.headers.get('cookie')?.includes('synthetic_private=authenticated')) return json({ok:false});
      if(url.pathname==='/secure-submit'){const data=await request.json() as {privateValue?:string};if(typeof data.privateValue!=='string'||!/^[a-zA-Z0-9]{32}$/.test(data.privateValue))return json({ok:false});await increment('securePosts');return json({ok:true});}
      const key=({'/book':'bookingPosts','/profile':'profilePosts','/checkout':'checkoutPosts'} as Record<string,string>)[url.pathname];
      if(!key)return new Response('Unknown action',{status:404});
      if(url.pathname==='/profile') {
        const data=await request.json() as {name:string;notes:string;plan:string;updates:boolean};
        if(data.name!=='Taylor Synthetic'||data.notes!=='Aisle seat please'||data.plan!=='evening'||data.updates!==true)return json({ok:false});
      }
      await increment(key);return json({ok:true});
    }
    if(url.pathname==='/public') {
      const authenticated=!!request.headers.get('cookie')?.includes('synthetic_private=authenticated');
      if(authenticated)await increment('publicAuthenticated');
      return new Response(`<!doctype html><title>Public isolation</title><p>${authenticated?'PRIVATE SESSION LEAK':'PUBLIC ANONYMOUS'}</p>`,{headers:{'content-type':'text/html'}});
    }
    if(url.pathname==='/cross-origin')return Response.redirect('https://example.com/',302);
    if(url.pathname!=='/merchant')return new Response('Unknown fixture',{status:404});
    return new Response(page(url.searchParams.get('probe')??'shared'),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  }
}
export default {fetch(request:Request,env:Env){const probe=new URL(request.url).searchParams.get('probe')??'shared';if(!/^[a-zA-Z0-9-]{1,64}$/.test(probe))return new Response('Invalid probe',{status:400});return env.FIXTURE.getByName(probe).fetch(request);}};
function page(probe:string):string{return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic private merchant</title></head><body>
<h1>Synthetic merchant</h1><p>Every action is a test; no real reservation or charge occurs.</p>
<form method="post" action="/login"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form><div id="notice"></div>
<script>
const probe=${JSON.stringify(probe)};
const endpoint=path=>path+'?probe='+encodeURIComponent(probe);
const post=async(path,data)=>{const r=await fetch(endpoint(path),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});return (await r.json()).ok;};
document.querySelector('form').addEventListener('submit',async event=>{
 event.preventDefault();const username=document.querySelector('[name=email]').value,password=document.querySelector('[name=password]').value;
 if(!await post('/login',{username,password})){document.querySelector('#notice').textContent='Login rejected';return;}
 sessionStorage.setItem('synthetic-private-marker','private-only');
 document.body.innerHTML='<h1>Signed in synthetic account</h1><p id="echo"></p><button type="button" id="book">Book synthetic class</button><p id="booking"></p><form method="post" action="/profile"><label>Display name <input name="displayName" type="text"></label><label>Notes <textarea name="notes"></textarea></label><label>Class time <select name="plan"><option value="morning">Morning</option><option value="evening">Evening</option></select></label><label><input type="checkbox" name="updates"> Send updates</label><button type="submit">Save profile</button></form><p id="profile"></p><p>Stored synthetic method ending in TEST. Total USD 1.00. No real charge.</p><button type="button" id="checkout">Confirm synthetic purchase</button><p id="purchase"></p><a href="https://example.com/">Unapproved external link</a>';
 document.querySelector('#echo').textContent=username+' '+password+' '+btoa(password)+' '+encodeURIComponent(username);
 document.querySelector('#book').addEventListener('click',async()=>{if(await post('/book',{}))document.querySelector('#booking').textContent='Synthetic booking confirmed';});
 document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();if(await post('/profile',{name:document.querySelector('[name=displayName]').value,notes:document.querySelector('[name=notes]').value,plan:document.querySelector('[name=plan]').value,updates:document.querySelector('[name=updates]').checked}))document.querySelector('#profile').textContent='Synthetic profile saved';});
 document.querySelector('#checkout').addEventListener('click',async()=>{if(await post('/checkout',{}))document.querySelector('#purchase').textContent='Synthetic purchase confirmed';});
});
</script></body></html>`;}

function securePage(probe:string):string{return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic secure form</title></head><body>
<h1>Authenticated synthetic secure form</h1><form method="post" action="/secure-submit"><label>Private reference <input type="text" name="privateValue" autocomplete="off"></label><button type="submit">Submit synthetic private reference</button></form><p id="echo"></p><p id="confirmation"></p>
<script>
const field=document.querySelector('[name=privateValue]');
field.addEventListener('input',()=>{document.querySelector('#echo').textContent='Private echo: '+field.value+' '+btoa(field.value);});
document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const response=await fetch('/secure-submit?probe='+encodeURIComponent(${JSON.stringify(probe)}),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({privateValue:field.value})});if((await response.json()).ok)document.querySelector('#confirmation').textContent='Synthetic private reference accepted';});
</script></body></html>`;}
