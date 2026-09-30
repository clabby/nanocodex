/** Account-owner-bound, metadata-only READ of existing Gmail watch config.
 * Never registers a subject, enables/reconfigures a watch, or reads mail/history.
 * Configured is NOT proof of caught-up or complete ingestion; INBOX scope only.
 */
import { connectorConnectionId } from "./connector-status";
import { fetchResponseWithDeadline } from "./deadline";
const json = (body:unknown,status=200) => Response.json(body,{status,headers:{"cache-control":"no-store","x-content-type-options":"nosniff"}});
const scope = { labels:["INBOX"], archived_excluded:true, complete:false };
const unknown = (reason:string) => ({status:"unknown",health:"unknown",enabled:null,pending:null,expiration:null,error:reason,scope});
async function boundedJSON(response:Response):Promise<Record<string,unknown>> {
  const reader=response.body?.getReader();if(!reader)throw new Error("empty");
  const chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16_384)throw new Error("oversize");chunks.push(part.value);}}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  const data:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes));
  if(!data || typeof data!=="object" || Array.isArray(data))throw new Error("invalid");return data as Record<string,unknown>;
}
/** UserAccount supplies ownerID from its stored account, not URL/body/headers. */
export async function readTodoSourceHealth(request:Request,binding:Fetcher|undefined,ownerID:string):Promise<Response> {
  const url=new URL(request.url);
  if(request.method!=="GET")return json({error:"method_not_allowed"},405);
  if([...url.searchParams.keys()].some(key=>key!=="connection_id") || url.searchParams.getAll("connection_id").length!==1
    || !connectorConnectionId(url.searchParams.get("connection_id")))return json({error:"invalid_request"},400);
  if(!binding)return json(unknown("source_health_unavailable"));
  const connection=url.searchParams.get("connection_id")!;
  try {
    const result=await fetchResponseWithDeadline(binding,
      `https://egress.internal/users/${encodeURIComponent(ownerID)}/gmail-push/${encodeURIComponent(connection)}`,
      {method:"GET",redirect:"manual"},5000,"todo source health",async response=>{
        if(!response.ok)return unknown(response.status===403?"mailbox_not_allowed":response.status===404?"watch_status_not_found":"source_health_unavailable");
        const data=await boundedJSON(response);
        if(typeof data.enabled!=="boolean")return unknown("source_health_invalid");
        if(!data.enabled)return {status:"partial",health:"disabled",enabled:false,pending:null,expiration:null,error:null,scope};
        if(typeof data.pending!=="boolean" || typeof data.expiration!=="string" || !/^[0-9]{1,16}$/.test(data.expiration)
          || !Number.isSafeInteger(Number(data.expiration)))return unknown("source_health_invalid");
        const error=data.lastError==null?null:data.lastError==="gmail_or_wake_retry"?"gmail_or_wake_retry":"unrecognized_provider_error";
        const renewal=data.renewalError==null?null:data.renewalError==="gmail_watch_retry"?"gmail_watch_retry":"unrecognized_provider_error";
        return {status:"partial",health:Number(data.expiration)<=Date.now()?"expired":error||renewal?"retrying":data.pending?"pending":"configured",
          enabled:true,pending:data.pending,expiration:data.expiration,error:error??renewal,scope};
      });
    return json(result);
  } catch {return json(unknown("source_health_unavailable"));}
}
