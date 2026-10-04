import { classifyInboxCleanup } from "./gmail-firehose-cleanup";
import { classifyReplyRequest, classifyActionReviewRequest, classifyBookingRequest, gmailActionReviewCategory, gmailBookingCandidate, GMAIL_ACTION_REVIEW_POLICY, GMAIL_BOOKING_REVIEW_POLICY, GMAIL_DECISION_POLICY } from "./gmail-firehose-decisions";
import type { RoutingAi } from "./thread-model-routing";
import type { Principal } from "./account-auth";

/** Explicit gateway ID makes Jev calls inspectable in AI Gateway logs. No key is passed here. */
export function jevGatewayBinding(ai: RoutingAi, id = "default"): RoutingAi {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("invalid_jev_gateway_id");
  return {run: (model, input) => (ai as RoutingAi & {run(model: string, input: unknown,
    options: {gateway:{id:string;collectLog:boolean;skipCache:boolean}}):Promise<unknown>}).run(model,input,{gateway:{id,collectLog:false,skipCache:true}})};
}
export function enabledGmailDecisionOwner(env: {NANOCODEX_FIREHOSE_DECISIONS_OWNER_ID?:string;
  NANOCODEX_FIREHOSE_DECISIONS_ADMIN_ENABLED?:string; NANOCODEX_ADMIN_USER_ID?:string}): string | undefined {
  return env.NANOCODEX_FIREHOSE_DECISIONS_OWNER_ID
    ?? (env.NANOCODEX_FIREHOSE_DECISIONS_ADMIN_ENABLED === "true" ? env.NANOCODEX_ADMIN_USER_ID : undefined);
}
const thresholds = [0.65, 0.75, 0.85, 0.9, 0.95] as const;
const reply = (data: unknown, status = 200) => Response.json(data,{status,headers:{"cache-control":"no-store"}});
type Sample = {id:string;expected:"reply"|"no_reply"|"action_review"|"archive"|"keep";from:string;subject:string;body:string};
function validSample(value: unknown): value is Sample {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sample = value as Record<string,unknown>;
  return Object.keys(sample).sort().join(",") === "body,expected,from,id,subject"
    && typeof sample.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sample.id)
    && (sample.expected === "reply" || sample.expected === "no_reply" || sample.expected === "action_review" || sample.expected === "archive" || sample.expected === "keep")
    && typeof sample.from === "string" && sample.from.length > 0 && sample.from.length <= 256
    && typeof sample.subject === "string" && sample.subject.length <= 256
    && typeof sample.body === "string" && sample.body.trim().length > 0
    && new TextEncoder().encode(sample.body).length <= 8000;
}
async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body || request.headers.get("content-type")?.split(";")[0] !== "application/json") return null;
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      length += value.byteLength; if (length > 32768) return null;
      chunks.push(value);
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes = new Uint8Array(length);let offset=0;
  for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try {return JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes));} catch {return null;}
}
/** Private, non-persistent labeled fixture runner; no actual Gmail content is fetched. */
export async function routeGmailDecisionBacktest(request: Request, ai: RoutingAi | undefined,
  principal: Principal | null | undefined, enabledOwnerId: string | undefined): Promise<Response> {
  const url = new URL(request.url);
  if (!principal) return reply({error:"unauthorized"},401);
  if (principal.connectGrant || !["api_key","account_session"].includes(principal.kind)
    || !principal.capabilities.includes("agents:write") || !enabledOwnerId || principal.userId !== enabledOwnerId)
    return reply({error:"forbidden"},403);
  if (principal.kind === "account_session" && request.headers.get("origin") !== url.origin)
    return reply({error:"forbidden_origin"},403);
  if (request.method !== "POST" || url.search) return reply({error:"invalid_request"},400);
  if (!ai) return reply({error:"jev_unavailable"},503);
  const raw = await boundedJson(request);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key=>!["samples","lane"].includes(key)))
    return reply({error:"invalid_fixtures"},400);
  const lane = (raw as {lane?:unknown}).lane ?? "reply";
  if (lane !== "reply" && lane !== "auto" && lane !== "cleanup") return reply({error:"invalid_fixtures"},400);
  const samples = (raw as {samples?:unknown}).samples;
  if (!Array.isArray(samples) || !samples.length || samples.length > 5 || !samples.every(validSample)
    || new Set(samples.map(sample => sample.id)).size !== samples.length
    || lane === "reply" && samples.some(sample=>!["reply","no_reply"].includes(sample.expected))
    || lane === "auto" && samples.some(sample=>!["reply","no_reply","action_review"].includes(sample.expected))
    || lane === "cleanup" && samples.some(sample=>!["archive","keep"].includes(sample.expected)))
    return reply({error:"invalid_fixtures"},400);
  if(lane === "cleanup") {
    const rows=[];
    for(const sample of samples as Sample[]) {
      try {rows.push({id:sample.id,expected:sample.expected,...await classifyInboxCleanup(ai,[{from:sample.from,subject:sample.subject,body_text:sample.body}])});}
      catch {rows.push({id:sample.id,expected:sample.expected,outcome:"unavailable",choice:null,confidence:null});}
    }
    return reply({lane,policy_version:"gmail-inbox-cleanup-v1",rows,metrics:{correct:rows.filter(r=>r.outcome===r.expected).length,incorrect:rows.filter(r=>r.outcome!=="unavailable" && r.outcome!==r.expected).length,abstained:rows.filter(r=>r.outcome==="unavailable").length},note:"Read-only fixtures, no mail modified. Complete production threads and watch opt-in are additionally required before archiving."});
  }
  const rows = [];
  for (const sample of samples as Sample[]) {
    const message = {id:sample.id,status:"ok",headers:{from:sample.from,subject:sample.subject},body:sample.body};
    const booking = lane === "auto" && gmailBookingCandidate(message);
    const action = lane === "auto" && !booking && gmailActionReviewCategory(message);
    const result = booking ? await classifyBookingRequest(ai,message) : action ? await classifyActionReviewRequest(ai,message) : await classifyReplyRequest(ai,message);
    const policy = booking ? GMAIL_BOOKING_REVIEW_POLICY : action ? GMAIL_ACTION_REVIEW_POLICY : GMAIL_DECISION_POLICY;
    rows.push({policy_version:policy,id:sample.id,expected:sample.expected,choice:result.choice,outcome:result.outcome,
      reason:result.reason,classifier_outcome:result.classifier_outcome,confidence:result.confidence,
      reply_probability:result.reply_probability,duration_ms:result.duration_ms});
  }
  const byThreshold: Record<string,Record<string,number>> = {};
  for (const threshold of thresholds) {
    const metrics = {true_positive:0,true_negative:0,false_positive:0,false_negative:0,abstained:0};
    for (const row of rows) {
      if (row.choice === null || row.confidence === null || row.confidence < threshold) {metrics.abstained++;continue;}
      const predicted = row.choice === "reply_requested" ? "reply" : "no_reply";
      const key = predicted === "reply" ? row.expected === "reply" ? "true_positive" : "false_positive"
        : row.expected === "reply" ? "false_negative" : "true_negative";
      metrics[key]++;
    }
    byThreshold[String(threshold)] = metrics;
  }
  return reply({lane,policy_version:lane === "auto" ? "gmail-production-lanes-v1" : GMAIL_DECISION_POLICY,model:"typesafe/jev",rows,...(lane === "reply" ? {thresholds:byThreshold} : {metrics:{correct:rows.filter(row=>row.outcome===row.expected).length,incorrect:rows.filter(row=>row.outcome!=="unavailable" && row.outcome!==row.expected).length,abstained:rows.filter(row=>row.outcome==="unavailable").length}}),
    note:"User-supplied labels are independent ground truth; Jev confidence is not calibrated accuracy. No fixtures are stored."});
}
