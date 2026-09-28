/** Native plaintext never enters this module. Only authenticated private HTTP may call submit. */
type Context = {sessionId:string;callId:string;signal?:AbortSignal};
type Host = {routeToken?:string;handler(input:unknown,context:Context):Promise<unknown>};
type Resolve = (machine:string,context:Context)=>Host|undefined;
type Ticket = {request_id:string;machine_id:string;executable:string;arguments:string[];cwd:string;uid:number;command_digest:string;public_key:string;expires_at:number};
type Pending = {ticket:Ticket;route:string};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = () => new Error('Native secure input unavailable');
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail();
  return value as Record<string,unknown>;
}
function hostResult(value:unknown):Record<string,unknown> {
  const result=object(value) as Record<PropertyKey,unknown>;
  if(result[Symbol.for('nanocodex.toolResult')]===true){
    if(result.success!==true)throw fail();
    return object(result.structuredResult);
  }
  return result as Record<string,unknown>;
}
function bytes(value:unknown,min:number,max=min):string {
  if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw fail();
  const decoded=atob(value);if(decoded.length<min||decoded.length>max||btoa(decoded)!==value)throw fail();return value;
}
export function parseNativeSecureInput(value:unknown):Record<string,unknown> {
  const v=object(value);
  if(typeof v.request_id!=='string'||!uuid.test(v.request_id))throw fail();
  if(Object.keys(v).length===2 && (v.action==='describe'||v.action==='cancel'))return {request_id:v.request_id,action:v.action};
  if(Object.keys(v).length!==3||!('ephemeral_public_key' in v)||!('ciphertext' in v))throw fail();
  const key=bytes(v.ephemeral_public_key,65);if(atob(key).charCodeAt(0)!==4)throw fail();
  return {request_id:v.request_id,ephemeral_public_key:key,ciphertext:bytes(v.ciphertext,29,20000)};
}
export class NativeSecureInput {
  #tail:Promise<unknown>=Promise.resolve();
  constructor(readonly storage:Pick<DurableObjectStorage,'get'|'put'|'delete'>,readonly agent:string,readonly signingKey:string|undefined,readonly resolve:Resolve,readonly helperPins:string|undefined){}
  async #key():Promise<CryptoKey> {
    if(!this.signingKey)throw fail();
    try{return await crypto.subtle.importKey('jwk',JSON.parse(this.signingKey),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);}catch{throw fail();}
  }
  async prepare(input:unknown,context:Context) {
    await this.#key();
    const v=object(input);
    if(Object.keys(v).length!==4||typeof v.machine_id!=='string'||!v.machine_id||v.machine_id.length>256
      ||typeof v.executable!=='string'||!v.executable.startsWith('/')||v.executable.length>4096||/[\x00-\x1f\x7f]/.test(v.executable)
      ||typeof v.cwd!=='string'||!v.cwd.startsWith('/')||v.cwd.length>4096||/[\x00-\x1f\x7f]/.test(v.cwd)
      ||!Array.isArray(v.arguments)||v.arguments.length>128||v.arguments.some(a=>typeof a!=='string'||a.length>4096||a.includes('\0')))throw fail();
    let helperKey:CryptoKey;
    try {
      const pin=bytes(object(JSON.parse(this.helperPins ?? '{}'))[v.machine_id],65);
      helperKey=await crypto.subtle.importKey('raw',Uint8Array.from(atob(pin),c=>c.charCodeAt(0)),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    } catch {throw fail();}
    const host=this.resolve(v.machine_id,context);if(!host?.routeToken)throw fail();
    let r:Record<string,unknown>;
    try{r=hostResult(await host.handler({operation:'prepare',executable:v.executable,arguments:v.arguments,cwd:v.cwd},context));}catch{throw fail();}
    if(typeof r.request_id!=='string'||!uuid.test(r.request_id)||typeof r.expires_at!=='number'||!Number.isSafeInteger(r.expires_at)||r.expires_at<=Date.now()||r.expires_at>Date.now()+301000)throw fail();
    const ticket:Ticket={request_id:r.request_id,machine_id:v.machine_id,executable:v.executable,arguments:v.arguments as string[],cwd:v.cwd,uid:r.uid as number,command_digest:bytes(r.command_digest,32),public_key:bytes(r.public_key,65),expires_at:r.expires_at};
    if(atob(ticket.public_key).charCodeAt(0)!==4)throw fail();
    if(typeof r.uid!=='number'||!Number.isSafeInteger(r.uid)||r.uid<0)throw fail();
    const canonical=JSON.stringify({arguments:v.arguments,cwd:v.cwd,executable:v.executable,uid:r.uid});
    const digest=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)))));
    if(digest!==ticket.command_digest)throw fail();
    const message=['nanocodex-secure-sudo-ticket-v1',ticket.request_id,ticket.command_digest,ticket.public_key,String(ticket.expires_at),String(r.uid)].join('\n');
    const signature=Uint8Array.from(atob(bytes(r.helper_signature,64)),c=>c.charCodeAt(0));
    if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},helperKey,signature,new TextEncoder().encode(message)))throw fail();
    const key=`native-secure-input:${ticket.request_id}`;
    if(await this.storage.get(key))throw fail();
    await this.storage.put(key,{ticket,route:host.routeToken} satisfies Pending);
    return {type:'secure_input',status:'input_required',kind:'native_sudo',request_id:ticket.request_id,agent_id:this.agent,machine_id:ticket.machine_id,expires_at:ticket.expires_at};
  }
  submit(input:unknown,context:Context={sessionId:this.agent,callId:crypto.randomUUID()},resolve=this.resolve):Promise<unknown> {
    const operation=this.#tail.then(async()=>{
      const v=parseNativeSecureInput(input), key=`native-secure-input:${v.request_id}`;
      const pending=await this.storage.get<Pending>(key);if(!pending)throw fail();
      if(pending.ticket.expires_at<=Date.now()){await this.storage.delete(key);throw fail();}
      if(v.action==='describe')return pending.ticket;
      const host=resolve(pending.ticket.machine_id,context);
      if(!host||host.routeToken!==pending.route){await this.storage.delete(key);throw fail();}
      const signingKey=await this.#key();
      // Consume before any possibly ambiguous dispatch. Restart cannot replay it.
      await this.storage.delete(key);
      if(v.action==='cancel'){
        try{const result=hostResult(await host.handler({operation:'cancel',request_id:v.request_id},context));if(result.status!=='cancelled'||result.request_id!==v.request_id)throw fail();}catch{throw fail();}
        return {type:'secure_input_receipt',request_id:v.request_id,status:'cancelled'};
      }
      const message=new TextEncoder().encode(['nanocodex-secure-sudo-v1',v.request_id,v.ephemeral_public_key,v.ciphertext].join('\n'));
      const signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signingKey,message))));
      let status='outcome_unknown';
      try{const result=hostResult(await host.handler({operation:'submit',...v,signature},context));if(result.request_id===v.request_id && result.status==='completed' && typeof result.exit_code==='number' && Number.isInteger(result.exit_code) && result.exit_code>=0 && result.exit_code<=255)status=result.exit_code===0?'completed':'failed';}catch{}
      return {type:'secure_input_receipt',request_id:v.request_id,status};
    });
    this.#tail=operation.catch(()=>{});return operation;
  }
}
