import { createHash } from "node:crypto";

export const MEETING_AUDIO_PART_BYTES = 8 * 1024 * 1024;
export const MAX_MEETING_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (value: unknown) => Response.json(value, { headers });
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
class AudioFailure extends Error { constructor(public status: number, message: string) { super(message); } }
type Manifest = { size: number; sha256: string; part_size: number; count: number };
type MeetingState = { deleted: number } | null;
export async function meetingAudioKey(scope: string[], id: string): Promise<string> {
  return `account-meeting-audio/${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}/${id}/`;
}
export async function deleteMeetingAudio(bucket: R2Bucket, prefix: string): Promise<void> {
  // Each capture has at most 256 parts plus two small manifests. Repeat from the
  // beginning while deleting, avoiding cursors invalidated by deletion.
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (!page.objects.length) return;
    await bucket.delete(page.objects.map(object => object.key));
  }
}
async function manifest(bucket: R2Bucket, key: string): Promise<Manifest | null> {
  const object = await bucket.get(key + "manifest.json");
  return object ? object.json<Manifest>() : null;
}
const partKey = (key: string, number: number) => key + "parts/" + String(number).padStart(3, "0");
const partSize = (m: Manifest, number: number) => Math.min(m.part_size, m.size - (number - 1) * m.part_size);
const same = (a: Manifest, b: Manifest) => a.size === b.size && a.sha256 === b.sha256;
/** Auth, mutation origin and capture UUID validation live in the meeting router. */
export async function meetingAudio(request: Request, bucket: R2Bucket | undefined, key: string,
  read: () => Promise<MeetingState>, action = ""): Promise<Response> {
  if (!bucket) return fail("meeting_audio_unavailable", 503);
  const alive = async () => (await read())?.deleted === 0;
  const row = await read();
  if (!row || row.deleted) return fail(row?.deleted && request.method !== "GET" ? "meeting_deleted" : "not_found", row?.deleted && request.method !== "GET" ? 410 : 404);
  if (request.method === "POST" && !action) {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return fail("unsupported_media_type", 415);
    if (!request.body) return fail("invalid_request", 400);
    let raw = ""; const reader = request.body.getReader(); let size = 0;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
      for (;;) { const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>1024)return fail("request_too_large",413); raw+=decoder.decode(value,{stream:true}); }
      raw+=decoder.decode();
    } catch { return fail("invalid_request",400); }
    finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    let input: { size?: unknown; sha256?: unknown };
    try { input = JSON.parse(raw); } catch { return fail("invalid_request", 400); }
    if (!input || Object.keys(input).sort().join(",") !== "sha256,size" || !Number.isSafeInteger(input.size) || Number(input.size)<8
      || typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)) return fail("invalid_request",400);
    if (Number(input.size)>MAX_MEETING_AUDIO_BYTES) return fail("audio_too_large",413);
    const next: Manifest = {size:Number(input.size),sha256:input.sha256,part_size:MEETING_AUDIO_PART_BYTES,count:Math.ceil(Number(input.size)/MEETING_AUDIO_PART_BYTES)};
    await bucket.put(key+"manifest.json",JSON.stringify(next),{onlyIf:{etagDoesNotMatch:"*"},httpMetadata:{contentType:"application/json"}});
    if (!await alive()) { await deleteMeetingAudio(bucket,key); return fail("meeting_deleted",410); }
    const saved=await manifest(bucket,key); if (!saved || !same(saved,next)) return fail("audio_conflict",409);
    const parts=await bucket.list({prefix:key+"parts/",limit:1000});
    return json({audio:saved,uploaded_parts:parts.objects.map(object=>Number(object.key.split("/").at(-1))),complete:!!await bucket.head(key+"complete.json")});
  }
  const saved=await manifest(bucket,key); if(!saved)return fail("not_found",404);
  if (action.startsWith("parts/")) {
    const number=Number(action.slice(6));
    if (!/^[1-9]\d*$/.test(action.slice(6)) || !Number.isSafeInteger(number) || number>saved.count) return fail("invalid_audio_part",400);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/octet-stream") return fail("unsupported_media_type",415);
    const length=request.headers.get("content-length");if(!length)return fail("length_required",411);
    if (!/^[1-9]\d*$/.test(length) || Number(length)!==partSize(saved,number)) return fail("invalid_audio_size",Number(length)>MEETING_AUDIO_PART_BYTES?413:400);
    const digest=request.headers.get("x-content-sha256")??"";if(!/^[0-9a-f]{64}$/.test(digest))return fail("invalid_audio_checksum",400);
    const receipt=(object:R2Object|null)=>object?.size===Number(length)&&object.customMetadata?.sha256===digest
      ?json({part:number,size:Number(length),sha256:digest}):fail("audio_conflict",409);
    const target=partKey(key,number), existing=await bucket.head(target);
    if(existing){
      // Finish consuming a bounded replay before returning its receipt. Early
      // responses while a native client is still sending can reset HTTP/1.1.
      if(!request.body)return fail("invalid_audio",400);
      const reader=request.body.getReader(),hash=createHash("sha256");let count=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>Number(length))return fail("audio_too_large",413);hash.update(value);}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(count!==Number(length)||hash.digest("hex")!==digest)return fail("invalid_audio_checksum",400);
      return await alive()?receipt(existing):fail("meeting_deleted",410);
    }
    try {
      const object=await putPart(request,bucket,target,Number(length),digest,number===1);
      if(!await alive()){await bucket.delete(target);return fail("meeting_deleted",410);}
      return receipt(object??await bucket.head(target));
    } catch(error){return error instanceof AudioFailure?fail(error.message,error.status):fail("meeting_audio_unavailable",503);}
  }
  if(action==="complete") {
    const completed=await bucket.head(key+"complete.json");
    if(!completed){
      // Verify every committed byte once before publishing the immutable receipt.
      // Incomplete/rejected parts remain resumable without changing the manifest.
      const digest=createHash("sha256");
      for(let number=1;number<=saved.count;number++){
        const part=await bucket.get(partKey(key,number));
        if(!part)return fail("audio_incomplete",409);
        if(part.size!==partSize(saved,number)){await part.body.cancel();return fail("invalid_audio_size",400);}
        const reader=part.body.getReader();
        try{for(;;){const {done,value}=await reader.read();if(done)break;digest.update(value);}}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      }
      if(digest.digest("hex")!==saved.sha256)return fail("invalid_audio_checksum",400);
      await bucket.put(key+"complete.json",JSON.stringify(saved),{onlyIf:{etagDoesNotMatch:"*"},httpMetadata:{contentType:"application/json"}});
    }
    if(!await alive()){await deleteMeetingAudio(bucket,key);return fail("meeting_deleted",410);}
    return json({audio:saved,complete:true});
  }
  if(!await bucket.head(key+"complete.json"))return fail("not_found",404);
  if(!await alive())return fail("not_found",404);
  let number=1, reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const body=new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        for(;;){
          if(!reader){
            if(number>saved.count){controller.close();return;}
            const part=await bucket.get(partKey(key,number++));
            if(!part)throw new Error("meeting audio removed");
            reader=part.body.getReader();
          }
          const {done,value}=await reader.read();
          if(done){reader.releaseLock();reader=undefined;continue;}
          controller.enqueue(value);return;
        }
      }catch(error){await reader?.cancel().catch(()=>{});controller.error(error);}
    },
    async cancel(){await reader?.cancel();}
  });
  return new Response(body.pipeThrough(new FixedLengthStream(saved.size)),{headers:{...headers,"content-type":"application/x-caf","content-length":String(saved.size),
    "x-content-sha256":saved.sha256,"content-disposition":`attachment; filename="${key.split("/").at(-2)}.caf"`}});
}

async function putPart(request:Request,bucket:R2Bucket,key:string,size:number,digest:string,first:boolean):Promise<R2Object|null>{
  if(!request.body)throw new AudioFailure(400,"invalid_audio");
  const stream=new FixedLengthStream(size),writer=stream.writable.getWriter(),reader=request.body.getReader();let failure:unknown;
  const stored=bucket.put(key,stream.readable,{onlyIf:{etagDoesNotMatch:"*"},sha256:digest,httpMetadata:{contentType:"application/octet-stream"},customMetadata:{sha256:digest}})
    .then(async object=>{if(!object)await writer.abort().catch(()=>{});return object;})
    .catch(async error=>{failure??=error;await writer.abort(error).catch(()=>{});throw error;});
  const pump=(async()=>{
    let count=0,prefix=new Uint8Array(0);const hash=createHash("sha256");
    try{
      for(;;){
        const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>size)throw new AudioFailure(413,"audio_too_large");hash.update(value);
        if(first&&prefix.length<8){
          const combined=new Uint8Array(prefix.length+value.length);combined.set(prefix);combined.set(value,prefix.length);
          if(combined.length<8){prefix=combined;continue;}
          if(combined[0]!==99||combined[1]!==97||combined[2]!==102||combined[3]!==102||combined[4]!==0||combined[5]!==1)throw new AudioFailure(400,"invalid_audio");
          prefix=combined.slice(0,8);await writer.write(combined);
        }else await writer.write(value);
      }
      if(count!==size)throw new AudioFailure(400,"invalid_audio_size");
      if(hash.digest("hex")!==digest)throw new AudioFailure(400,"invalid_audio_checksum");await writer.close();
    }catch(error){
      failure??=error;
      // Consume the rest of an admitted bounded part before responding to a
      // content error; cancelling mid-upload can reset HTTP before its receipt.
      try{while(count<=size){const {done,value}=await reader.read();if(done)break;count+=value.length;}}catch{}
      await writer.abort(error).catch(()=>{});throw error;
    }
  })();
  try{
    const [transfer,result]=await Promise.allSettled([pump,stored]);
    if(result.status==="fulfilled"&&result.value===null)return null;
    if(transfer.status==="rejected"||result.status==="rejected")throw failure;
    return result.value;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();writer.releaseLock();}
}
