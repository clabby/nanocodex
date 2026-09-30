/** Durable at-most-once dispatch receipts, containing no page content or inputs. */
export async function privateBrowserOperation<T>(options: {
  storage: DurableObjectStorage;
  scope: string;
  operationId: unknown;
  input: unknown;
  run: () => Promise<T>;
}): Promise<T | {status:"outcome_unknown"; next_action:"inspect_before_retry"}> {
  if(typeof options.operationId!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.operationId))throw new Error("A stable operation_id UUID is required for private browser actions");
  const key=`private-browser-operation:${options.scope}:${options.operationId.toLowerCase()}`;
  const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(options.input)))),b=>b.toString(16).padStart(2,"0")).join("");
  type Receipt={fingerprint:string; state:"pending"|"done"; result?:T};
  const unknown={status:"outcome_unknown" as const,next_action:"inspect_before_retry" as const};
  const prior=await options.storage.transaction(async tx=>{
    const existing=await tx.get<Receipt>(key);
    if(!existing)await tx.put(key,{fingerprint,state:"pending"} satisfies Receipt);
    return existing;
  });
  if(prior){
    if(prior.fingerprint!==fingerprint)throw new Error("Private browser operation_id was already used with different arguments");
    return prior.state==="done" ? prior.result! : unknown;
  }
  try {
    const result=await options.run();
    await options.storage.put(key,{fingerprint,state:"done",result} satisfies Receipt);
    return result;
  }catch{
    // Preserve pending on all uncertain failures, including a lost durable write.
    // Never copy arbitrary browser/provider exception text into a receipt.
    return unknown;
  }
}

export function parsePrivateBrowserAction(input:Record<string,unknown>) {
  const modes:Record<string,string[]>={navigate:["url"],click:["snapshot_id","ref"],fill:["snapshot_id","ref","text"],select:["snapshot_id","ref","option_index"],check:["snapshot_id","ref","checked"]};
  const fields=modes[String(input.action)];
  if(!fields || ["url","snapshot_id","ref","text","option_index","checked"].some(k=>fields.includes(k) ? input[k]===undefined : input[k]!==undefined))throw new Error("Invalid private browser action");
  if(input.action==="navigate" ? typeof input.url!=="string" : typeof input.snapshot_id!=="string" || typeof input.ref!=="string")throw new Error("Invalid private browser action");
  if(input.action==="fill" && (typeof input.text!=="string" || input.text.length>4096))throw new Error("Invalid private text input");
  if(input.action==="select" && (!Number.isInteger(input.option_index) || Number(input.option_index)<0 || Number(input.option_index)>1000))throw new Error("Invalid private selection");
  if(input.action==="check" && typeof input.checked!=="boolean")throw new Error("Invalid private checkbox action");
  return Object.fromEntries(["action",...fields].map(k=>[k,input[k]]));
}
