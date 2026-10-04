/** The public API accepts a mailbox address and explicit optional CRM opt-in; identity comes from the session. */
export async function gmailPushConfig(request: Request): Promise<{email:string;crm?:boolean;archive_non_actionable?:boolean} | Response> {
  const reader = request.body?.getReader();
  if (!reader) return Response.json({error:"invalid_request"},{status:400});
  try {
    let length=0, text="";
    const decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:false});
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      length+=value.byteLength;
      if(length>2048) { void reader.cancel().catch(()=>{}); return Response.json({error:"request_too_large"},{status:413}); }
      text+=decoder.decode(value,{stream:true});
    }
    const value:unknown=JSON.parse(text+decoder.decode());
    if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error();
    const body=value as Record<string,unknown>;
    if(Object.keys(body).some(key=>key!=="email"&&key!=="crm"&&key!=="archive_non_actionable") || (body.archive_non_actionable!==undefined && typeof body.archive_non_actionable!=="boolean") || (body.crm!==undefined && typeof body.crm!=="boolean") || typeof body.email!=="string" || body.email.length>320
      || !/^[^\s@]+@[^\s@]+$/.test(body.email)) throw new Error();
    return {email:body.email,...(body.archive_non_actionable===undefined?{}:{archive_non_actionable:body.archive_non_actionable as boolean}),...(body.crm===undefined?{}:{crm:body.crm as boolean})};
  } catch { return Response.json({error:"invalid_request"},{status:400}); }
  finally { reader.releaseLock(); }
}
