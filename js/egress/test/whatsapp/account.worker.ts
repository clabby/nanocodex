import { WhatsAppAccount } from '../../src/whatsapp-account';
import type { WhatsAppTransportCallbacks, WhatsAppTransportFactory } from '../../src/whatsapp-transport';
export class FixtureAccount extends WhatsAppAccount {
  private sessions: WhatsAppTransportCallbacks[] = [];
  private pairingRequests = 0;
  protected transportFactory(): WhatsAppTransportFactory {
    return { connect: async callbacks => {
      this.sessions.push(callbacks);
      return {
        requestPairingCode: async () => { this.pairingRequests++; return 'TEST-1234'; },
        close: async () => {}, logout: async () => {},
        requestHistory: async request => { await callbacks.onEvents([{type: 'message', message: { id: 'history-old', chat_id: request.chat_id, timestamp: request.before - 1, text: 'history fixture' }}, {type:'history',complete:true,oldest_timestamp:request.before - 1}]); },
      };
    }};
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/fixture/')) return super.fetch(request);
    const input: any = request.method === 'POST' ? await request.json() : {};
    const callback = this.sessions[input.session ?? this.sessions.length - 1];
    if (path === '/fixture/stats') return Response.json({pairingRequests:this.pairingRequests, sessions:this.sessions.length});
    if (path === '/fixture/events') await callback.onEvents(input.events);
    if (path === '/fixture/connection') await callback.onConnection(input.update);
    if (path === '/fixture/register') await callback.auth.saveCredentials({registered:true, noiseKey:{private:new Uint8Array([0,1,127,255])}});
    if (path === '/fixture/keys' || path === '/fixture/keys-read') {
      if (path === '/fixture/keys') await callback.auth.setKeys({'session':{'synthetic-key':{key:new Uint8Array([0,1,127,255]), marker:'synthetic-key-plaintext'}}});
      const keys: any = await callback.auth.getKeys('session',['synthetic-key']);
      const raw = [...(await this.ctx.storage.list({prefix:'secret:'})).values()];
      return Response.json({bytes:[...keys['synthetic-key'].key],typed:keys['synthetic-key'].key instanceof Uint8Array, raw});
    }
    if (path === '/fixture/expire') {
      // Narrow clock seam: production expire() still performs all state transitions.
      (this as any).meta.attempt.expires_at = Date.now() - 1;
    }
    if (path === '/fixture/alarm') await this.alarm();
    return Response.json({ok:true});
  }
}
export default { fetch(request: Request, env: any) {
  const url = new URL(request.url); const account = url.pathname.split('/')[1];
  url.pathname = '/' + url.pathname.split('/').slice(2).join('/');
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(account)).fetch(new Request(url,request));
}};
