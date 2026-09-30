/** Local HTTP tool transport with real remote Chromium and synthetic Vault resolution. */
import {DurableObject} from 'cloudflare:workers';
import {createManagedBrowserRuntime,type ManagedBrowserRuntime,type ManagedBrowserEnv} from '../src/browser-runtime';
import type {ToolContext} from 'nanocodex';
interface Env extends ManagedBrowserEnv {PROBE:DurableObjectNamespace<PrivateBrowserSmoke>;FIXTURE_ORIGIN:string}
export class PrivateBrowserSmoke extends DurableObject<Env> {
  runtime?:ManagedBrowserRuntime;
  retired:ManagedBrowserRuntime[]=[];
  denied=false;
  reads=0;
  // Host-only input fixture: generated here, never accepted from a tool request.
  secureSecret?:string;
  safeResponse(value:unknown){
    const body=JSON.stringify(value);
    if(this.secureSecret&&[this.secureSecret,encodeURIComponent(this.secureSecret),btoa(this.secureSecret)].some(secret=>body.includes(secret)))throw new Error('Synthetic private input escaped redaction');
    return Response.json(value);
  }
  async getRuntime(){return this.runtime??=await createManagedBrowserRuntime({ctx:this.ctx,env:this.env,sessionId:'synthetic-generic-private',
    authorizeVaultAccess:()=>{if(this.denied)throw new Error('Synthetic caller denied');},
    resolveVaultLogin:async request=>{this.reads++;if(request.expected_origin!==this.env.FIXTURE_ORIGIN||request.vault_id!=='synthetic-generic-vault-123456')throw new Error('Synthetic Vault binding rejected');return {username:'generic-fixture@example.test',password:'generic-synthetic-password-42'};},
  });}
  async fetch(request:Request):Promise<Response>{
    const input=await request.json() as {tool?:string;input?:unknown;deny?:boolean;control?:string;challenge_id?:string;request_id?:string;action?:'type'|'finish'};
    try{
      if(input.control==='secure-input'){const runtime=await this.getRuntime();this.secureSecret=crypto.randomUUID().replaceAll('-','');const result=await runtime.submitSecureInput({request_id:input.request_id,values:{private_reference:this.secureSecret}},AbortSignal.timeout(110000));return this.safeResponse({result});}
      if(input.control==='takeover'){const runtime=await this.getRuntime();const result=await runtime.submitVaultTakeover({challenge_id:input.challenge_id,action:input.action,...(input.action==='type'?{text:'TakeoverSyntheticSecretAlphaZeta'}:{})},AbortSignal.timeout(110000)) as {status:string};return Response.json({takeoverStatus:result.status});}
      if(input.control==='reconstruct'){if(this.runtime)this.retired.push(this.runtime);this.runtime=undefined;await this.getRuntime();return Response.json({reconstructed:true});}
      if(input.control==='close'){const runtime=await this.getRuntime();const close=runtime.tools.find(tool=>tool.name==='browser_vault_close');if(close)await close.handler({}, {callId:crypto.randomUUID(),signal:AbortSignal.timeout(110000)} as ToolContext);await Promise.all([...this.retired,...(this.runtime?[this.runtime]:[])].map(r=>r.close()));this.runtime=undefined;this.retired=[];return Response.json({closed:true});}
      this.denied=input.deny===true;
      const runtime=await this.getRuntime();
      const tool=runtime.tools.find(tool=>tool.name===input.tool);
      if(!tool)throw new Error('Requested tool unavailable');
      const before=this.reads;
      const result=await tool.handler(input.input,{callId:crypto.randomUUID(),signal:AbortSignal.timeout(110000)} as ToolContext);
      return this.safeResponse({result,vaultReads:this.reads-before});
    }catch(error){return Response.json({error:error instanceof Error?error.message:'Private tool rejected'},{status:400});}
    finally{this.denied=false;}
  }
}
export default {fetch(request:Request,env:Env){if(request.method!=='POST')return new Response('Use POST',{status:405});const run=new URL(request.url).searchParams.get('run');if(!run||!/^[a-zA-Z0-9-]{1,64}$/.test(run))return new Response('Invalid run',{status:400});return env.PROBE.getByName(run).fetch(request);}};
export {CodemodeRuntime} from '@cloudflare/codemode';
