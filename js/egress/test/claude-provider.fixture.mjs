// Synthetic provider boundary only. Production broker, vault, worker and Rust
// lifecycle are never stubbed. These fixed tokens are intentional test data.
const calls = new Map();
function bump(key, kind) { const row = calls.get(key) ?? {}; row[kind] = (row[kind] ?? 0) + 1; calls.set(key, row); }
export async function claudeProvider(request) {
  const url = new URL(request.url);
  if (url.hostname === 'claude-fixture.invalid' && url.pathname === '/trace') {
    return Response.json(calls.get(url.searchParams.get('scenario')) ?? {});
  }
  if (url.href === 'https://platform.claude.com/v1/oauth/token/revoke' && request.method === 'POST') {
    const body = await request.json(); const key = String(body.token).replace(/^synthetic-refresh-/, '');
    bump(key, 'revoke'); return new Response(null, {status:200});
  }
  if (url.href === 'https://platform.claude.com/v1/oauth/token' && request.method === 'POST') {
    const body = await request.json();
    const refresh = body.grant_type === 'refresh_token';
    const key = refresh ? String(body.refresh_token).replace(/^synthetic-refresh-/, '') : body.code;
    bump(key, refresh ? 'refresh' : 'exchange');
    if (body.client_id !== '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
      || (!refresh && (body.redirect_uri !== 'https://platform.claude.com/oauth/code/callback'
        || !/^[A-Za-z0-9_-]{43}$/.test(body.code_verifier ?? '')))) return Response.json({error:'invalid_grant'}, {status:400});
    if (key === 'uncertain' || (refresh && key === 'refresh-uncertain')) return Response.json({error:'synthetic_failure'}, {status:503});
    if (key === 'redirect') return Response.redirect('https://untrusted.invalid/token', 307);
    if (key === 'oversized') return new Response('x'.repeat(65537));
    return Response.json({ access_token: `synthetic-claude-${key}${refresh ? '-refreshed' : ''}`,
      refresh_token: `synthetic-refresh-${key}`, expires_in: 3600,
      scope:'user:profile user:inference', token_type:'Bearer',
      account:{uuid:`account-${key}`}, organization:{uuid:`organization-${key}`}});
  }
  if (url.href === 'https://api.anthropic.com/api/oauth/profile' && request.method === 'GET') {
    const auth = request.headers.get('authorization') ?? '';
    const key = auth.replace(/^Bearer synthetic-claude-/, '').replace(/-refreshed$/, '');
    bump(key, 'profile');
    if ((key === 'profile-uncertain' || key === 'profile-metadata-reopen') && calls.get(key).profile === 1
      || key === 'profile-polling' && calls.get(key).profile <= 2) return Response.json({error:'synthetic_unavailable'}, {status:503});
    if (!auth.startsWith('Bearer synthetic-claude-')) return new Response(null, {status:401});
    return Response.json({account:{uuid:`account-${key}`},organization:{uuid:`organization-${key}`}});
  }
  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/models' && request.method === 'GET') {
    const auth = request.headers.get('authorization') ?? '';
    const key = auth.replace(/^Bearer synthetic-claude-/, '').replace(/-refreshed$/, '');
    bump(key, 'models');
    if (!auth.startsWith('Bearer synthetic-claude-')) return new Response(null, {status:401});
    if (request.headers.get('anthropic-version') !== '2023-06-01' || request.headers.get('anthropic-beta') !== 'oauth-2025-04-20'
      || request.headers.get('accept') !== 'application/json' || request.headers.has('x-api-key')) return new Response(null,{status:400});
    if (key === 'catalog-unsupported') return new Response(null,{status:403});
    if (url.searchParams.has('limit') && url.searchParams.get('limit') !== '100') return new Response(null,{status:400});
    const cursor = url.searchParams.get('after_id');
    if (key.startsWith('catalog-')) {
      if (key === 'catalog-pages' || key === 'catalog-later-failure' || key === 'catalog-refresh' || key === 'catalog-repeat-401' || key === 'catalog-reflection') {
        if (cursor === null) return Response.json({data:[{id:'claude-synthetic-a',display_name:key === 'catalog-reflection' ? 'synthetic-claude-catalog-reflection-refreshed' : 'Synthetic A'}],has_more:true,last_id:'claude-synthetic-a'});
        if (cursor !== 'claude-synthetic-a') return new Response(null,{status:400});
        if (key === 'catalog-later-failure') return new Response(null,{status:503});
        if (((key === 'catalog-refresh' || key === 'catalog-reflection') && !auth.endsWith('-refreshed')) || key === 'catalog-repeat-401') return new Response(null,{status:401});
        return Response.json({data:[{id:'claude-synthetic-a',display_name:'Duplicate'}, {id:'claude-sonnet-4-6',display_name:'Entitled Sonnet'}],has_more:false});
      }
      if (key === 'catalog-deadline') {
        await new Promise(resolve=>setTimeout(resolve,8000));
        return Response.json(cursor === null ? {data:[{id:'claude-synthetic-a'}],has_more:true,last_id:'claude-synthetic-a'} : {data:[{id:'claude-sonnet-4-6'}],has_more:false});
      }
      if (key === 'catalog-missing-cursor') return Response.json({data:[{id:'claude-synthetic-a'}],has_more:true});
      if (key === 'catalog-repeat-cursor') return Response.json({data:[{id:'claude-synthetic-a'}],has_more:true,last_id:'claude-synthetic-a'});
      if (key === 'catalog-wrong-cursor') return Response.json({data:[{id:'claude-synthetic-a'}],has_more:true,last_id:'claude-not-last'});
      if (key === 'catalog-nonboolean') return Response.json({data:[{id:'claude-synthetic-a'}],has_more:'true'});
      if (key === 'catalog-limit') {
        const id='claude-page-'+calls.get(key).models;
        return Response.json({data:[{id}],has_more:true,last_id:id});
      }
      if (key === 'catalog-large-body') return new Response('x'.repeat(1024*1024+1));
      if (key === 'catalog-rich') return Response.json({data:Array.from({length:100},(_,i)=>({id:'claude-rich-'+i,capabilities:{description:'x'.repeat(1000)}})),has_more:false});
      if (key === 'catalog-large-page') return Response.json({data:Array.from({length:101},(_,i)=>({id:'claude-row-'+i})),has_more:false});
    }

    return Response.json({data:[{id:'claude-synthetic-a',display_name:'Synthetic A'}, {id:'claude-synthetic-b',display_name:'Synthetic B'}],has_more:false});
  }
  if (url.href === 'https://api.anthropic.com/v1/messages?beta=true' && request.method === 'POST') {
    const auth = request.headers.get('authorization') ?? '';
    const key = auth.replace(/^Bearer synthetic-claude-/, '').replace(/-refreshed$/, '');
    bump(key, 'messages');
    if (!auth.startsWith('Bearer synthetic-claude-') || request.headers.get('anthropic-version') !== '2023-06-01'
      || !request.headers.get('anthropic-beta')?.split(',').includes('oauth-2025-04-20')) return new Response(null, {status:401});
    for (const name of ['x-nanocodex-subject','x-nanocodex-session-model-owner','x-private','x-api-key','cookie']) {
      if (request.headers.has(name)) return Response.json({error:'private_header_leak'},{status:400});
    }
    if ((key === 'refresh' || key === 'refresh-uncertain') && !auth.endsWith('-refreshed')) return Response.json({error:'unauthorized'}, {status:401});
    if (key === 'message-uncertain') return Response.json({error:'synthetic overload'}, {status:503});
    if (request.headers.get('x-app') !== 'cli' || request.headers.has('x-claude-code-request-class')
      || request.headers.get('anthropic-dangerous-direct-browser-access') !== 'true'
      || !/^claude-cli\/2\.1\.280 \(external, cli\)$/.test(request.headers.get('user-agent') ?? '')) return new Response(null,{status:400});
    if (key === 'features') {
      const betas = request.headers.get('anthropic-beta').split(',');
      if (betas.filter(beta => beta === 'oauth-2025-04-20').length !== 1
        || !betas.includes('context-management-2025-06-27') || !betas.includes('effort-2025-11-24')) return new Response(null,{status:400});
    }
    const body = await request.json();
    if (key === 'unicode') {
      const hold = auth.slice(7).length - 1;
      const bytes = new TextEncoder().encode('data: abc😀' + 'x'.repeat(hold - 1));
      return new Response(new ReadableStream({start(controller) {
        // The first boundary splits UTF-8 bytes; the second exercises the
        // redaction tail precisely between JS surrogate halves.
        controller.enqueue(bytes.slice(0,11)); controller.enqueue(bytes.slice(11));
        controller.enqueue(new TextEncoder().encode('\n\n')); controller.close();
      }}), {headers:{'content-type':'text/event-stream'}});
    }
    if (key === 'reflection') {
      const token = auth.slice(7); const half = Math.floor(token.length / 2);
      return new Response(new ReadableStream({start(controller) {
        const encoder = new TextEncoder(); controller.enqueue(encoder.encode('data: '+token.slice(0,half)));
        controller.enqueue(encoder.encode(token.slice(half)+'\n\n')); controller.close();
      }}), {headers:{'content-type':'text/event-stream'}});
    }
    return Response.json({id:'msg_synthetic',type:'message',role:'assistant',content:[{type:'text',text:'Synthetic Claude'}],
      model:body.model,stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:2}},
      {headers:{authorization:auth,'set-cookie':'synthetic-private','x-api-key':auth,'request-id':'fixture-safe'}});
  }
  return undefined;
}
