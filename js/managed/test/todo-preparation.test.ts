import { prepareDecisionProposal } from "../src/todo-preparation-model";
import { gmailDecisionReceipts } from "../src/gmail-firehose-receipts";
import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { AccountAuthEnv } from "../src/account-auth";
import { handleTodoInbox, proposeTodoDecision } from "../src/todo-inbox";
import { handleTodoMail, todoMailContextFingerprint } from "../src/todo-mail";
import { backfillTodoPreparation, enqueueTodoPreparation, nextTodoPreparationAlarm, preparationView, runTodoPreparation } from "../src/todo-preparation";
import type { TodoMailSuggestionAI } from "../src/todo-mail-suggest";
const connection = "D".repeat(43);
const request = (path:string, body?:unknown, method = "POST") => new Request("https://user.internal/todo" + path, {method, headers:{"content-type":"application/json"}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
const response = (patch:Record<string,unknown> = {}) => ({response: JSON.stringify({status:"ready",context:"Owner-supplied context",recommendation:"Review the grounded proposal",proposal:"Review the supplied summary.",body_text:"Thanks for the supplied summary.",source_references:[`gmail:${connection}:mfixture`],missing_information:"",...patch})});
const ai = (fn:(input:any)=>Promise<any> = async () => response()) => ({run:async (_model:string,input:any) => fn(JSON.parse(input.messages[1].content))}) as unknown as TodoMailSuggestionAI;
const raw = (id = "mfixture", patch:Record<string,unknown> = {}) => ({id,threadId:"tfixture",internalDate:"1780000000000",labelIds:["INBOX","UNREAD"],payload:{mimeType:"text/plain",headers:[{name:"From",value:"Sender <sender@example.test>"},{name:"To",value:"owner@example.test"},{name:"Subject",value:"Supplied summary"},{name:"Message-ID",value:`<${id}@example.test>`}],body:{data:btoa("Here is the supplied summary.")}},...patch});
function broker() {
  let messages = [raw()], sends = 0, onConnectors: (()=>void) | undefined, onProfile: (()=>void) | undefined, beforeSend: (()=>void) | undefined;
  const binding = {fetch:async(input:Request | string) => {
    const r = input instanceof Request ? input : new Request(input), p = new URL(r.url).pathname;
    if (p.startsWith("/subjects/")) return new Response(null,{status:204});
    if (p.endsWith("/connectors")) {onConnectors?.();return Response.json({connectors:{gmail:{connected:true,connections:[{id:connection,label:"Synthetic inbox",capabilities:["gmail"],scopes:["https://www.googleapis.com/auth/gmail.modify"]}]}}});}
    if (p.endsWith("/threads/tfixture")) return Response.json({id:"tfixture",messages});
    if (p.endsWith("/profile")) {onProfile?.();return Response.json({emailAddress:"owner@example.test"});}
    if (p.endsWith("/messages/mfixture")) return Response.json(raw());
    if (p.endsWith("/messages/send")) {beforeSend?.();sends++;return Response.json({id:"sent_fixture",threadId:"tfixture"});}
    throw new Error("Unexpected synthetic route " + p);
  }} as unknown as Fetcher;
  return {binding,get sends(){return sends;},set messages(value:ReturnType<typeof raw>[]){messages=value;},get messages(){return messages;},set onConnectors(fn:(()=>void)|undefined){onConnectors=fn;},set onProfile(fn:(()=>void)|undefined){onProfile=fn;},set beforeSend(fn:(()=>void)|undefined){beforeSend=fn;}};
}
const seed = (storage:DurableObjectStorage, lane = "reply") => proposeTodoDecision(storage,{source_key:lane === "action" ? "gmail:gmail-action-review-triage-v1:fixture" : `gmail:fixture:${crypto.randomUUID()}`, title:"Review source", context:"Synthetic", source_label:"Gmail", source_url:"https://mail.google.com/", choices:[{id:"dismiss",title:"Dismiss"}], source_connection_id:connection,source_thread_id:"tfixture",source_message_id:"mfixture",prepare:true});
const withStorage = (fn:(storage:DurableObjectStorage)=>Promise<void>) => runInDurableObject((env as unknown as AccountAuthEnv).NANOCODEX_USERS.getByName(crypto.randomUUID()), async (_instance,state) => {try {await fn(state.storage);} finally {await state.storage.deleteAlarm();}});
describe("durable asynchronous decision preparation safety", () => {
  it("publishes a nested persisted snapshot; GET/detail runs no model; send requires exact version and source context", async () => withStorage(async storage => {
    const b=broker(), decision=seed(storage);let calls=0;
    await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai(async () => {calls++;return response();})});
    const ready=preparationView(storage,"decision",decision.id);expect(ready.status).toBe("ready");expect(ready.prepared_draft).toMatchObject({mode:"reply",thread_id:"tfixture",reply_message_id:"mfixture",to:["sender@example.test"],version:1,status:"draft"});
    for(let i=0;i<4;i++){const read=await handleTodoInbox(request(`/decisions/${decision.id}`,undefined,"GET"),storage);expect((await read.json() as any).decision.preparation.prepared_draft.id).toBe(ready.draft_id);}
    expect(calls).toBe(1);expect(b.sends).toBe(0);
    const send=async(version:number,op=crypto.randomUUID()) => handleTodoMail(request("/mail/send",{draft_id:ready.draft_id,version,operation_id:op}),storage,b.binding,"owner");
    expect((await send(99)).status).toBe(409);expect(b.sends).toBe(0);
    // Mark-read/benign labels must not invalidate content approval.
    b.messages=[raw("mfixture",{labelIds:["INBOX","Label_1"]})];const op=crypto.randomUUID();expect((await send(1,op)).status).toBe(200);expect(b.sends).toBe(1);
    expect((await send(1,op)).status).toBe(200);expect(b.sends).toBe(1);
  }));
  it.each(["new_message","body_changed","archived","spam","trash","draft"])("rejects changed mail applicability/content at send (%s), no provider send", async kind => withStorage(async storage => {
    const b=broker(), decision=seed(storage);await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai()});const ready=preparationView(storage,"decision",decision.id);
    if(kind==="new_message") b.messages=[raw(),raw("newer")];
    if(kind==="body_changed") b.messages=[raw("mfixture",{payload:{...raw().payload,body:{data:btoa("Updated facts")}}})];
    if(kind==="archived") b.messages=[raw("mfixture",{labelIds:[]})];
    if(["spam","trash","draft"].includes(kind)) b.messages=[raw("mfixture",{labelIds:["INBOX",kind.toUpperCase()]})];
    const sent=await handleTodoMail(request("/mail/send",{draft_id:ready.draft_id,version:1,operation_id:crypto.randomUUID()}),storage,b.binding,"owner");expect(sent.status).toBe(409);expect((await sent.json() as any).error).toBe("stale_source_context");expect(b.sends).toBe(0);expect(preparationView(storage,"decision",decision.id)).toMatchObject({status:"blocked",error:"stale_source_context",draft_id:null});
  }));
  it("rechecks source after inference, blocks changed content before generating a draft", async () => withStorage(async storage => {
    const b=broker(), decision=seed(storage);await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai(async () => {b.messages=[raw(),raw("newer")];return response();})});
    expect(preparationView(storage,"decision",decision.id)).toMatchObject({status:"blocked",error:"stale_source_context",draft_id:null});expect(storage.sql.exec("SELECT * FROM todo_mail_drafts").toArray()).toHaveLength(0);expect(b.sends).toBe(0);
  }));
  it("Change fences old drafts and Dismiss invalidates the current generation", async () => withStorage(async storage => {
    const b=broker(), decision=seed(storage);await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai()});const old=preparationView(storage,"decision",decision.id).prepared_draft!;
    expect((await handleTodoInbox(request(`/decisions/${decision.id}/prepare`,{version:1,text:"Change tone",operation_id:crypto.randomUUID()}),storage)).status).toBe(202);
    expect((await handleTodoMail(request("/mail/send",{draft_id:old.id,version:old.version,operation_id:crypto.randomUUID()}),storage,b.binding,"owner")).status).toBe(409);
    await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai()});const current=preparationView(storage,"decision",decision.id).prepared_draft!;expect(current.id).not.toBe(old.id);
    expect((await handleTodoInbox(request(`/decisions/${decision.id}/respond`,{version:2,choice_id:"dismiss",text:null,operation_id:crypto.randomUUID()}),storage)).status).toBe(200);
    expect((await handleTodoMail(request("/mail/send",{draft_id:current.id,version:current.version,operation_id:crypto.randomUUID()}),storage,b.binding,"owner")).status).toBe(409);expect(b.sends).toBe(0);
  }));
  it("reserving draft provenance before await leaves raced orphan unsendable", async () => withStorage(async storage => {
    const b=broker(), decision=seed(storage);let connectorReads=0;
    b.onConnectors=()=>{if(++connectorReads===3) enqueueTodoPreparation(storage,"decision",decision.id,1,"New generation");};
    await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai()});
    const links=storage.sql.exec<{draft_id:string}>("SELECT draft_id FROM todo_mail_decision_drafts").toArray();expect(links).toHaveLength(1);
    expect(preparationView(storage,"decision",decision.id).draft_id).toBeNull();
    const orphan=links[0]!.draft_id;expect((await handleTodoMail(request("/mail/send",{draft_id:orphan,version:1,operation_id:crypto.randomUUID()}),storage,b.binding,"owner")).status).toBe(409);expect(b.sends).toBe(0);
  }));
  it("attempt lease fencing prevents reclaimed model output from publishing over newer attempt", async () => withStorage(async storage => {
    const b=broker(), decision=seed(storage);let release!:()=>void, entered!:()=>void;const started=new Promise<void>(r=>entered=r), held=new Promise<void>(r=>release=r);
    const first=runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai(async()=>{entered();await held;return response({body_text:"Old attempt"});})});await started;
    storage.sql.exec("UPDATE todo_preparations SET due_at=0 WHERE target_id=?",decision.id);
    await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai(async()=>response({body_text:"Current attempt"}))});release();await first;
    expect(preparationView(storage,"decision",decision.id).prepared_draft?.body_text).toBe("Current attempt");expect(storage.sql.exec("SELECT * FROM todo_mail_drafts").toArray()).toHaveLength(1);expect(b.sends).toBe(0);
  }));
  it("transient inference failure retries durably with bounded attempts, malformed output does not retry", async () => withStorage(async storage => {
    const decision=seed(storage),b=broker();
    const deps={ownerID:"owner",binding:b.binding,ai:ai(async()=>{throw new Error("private provider text");})};
    for(let i=0;i<3;i++){await runTodoPreparation(storage,deps);if(i<2){expect(preparationView(storage,"decision",decision.id).status).toBe("pending");expect(nextTodoPreparationAlarm(storage)).toBeGreaterThan(Date.now());storage.sql.exec("UPDATE todo_preparations SET due_at=0 WHERE target_id=?",decision.id);}}
    expect(preparationView(storage,"decision",decision.id)).toMatchObject({status:"failed",error:"preparation_unavailable"});expect(nextTodoPreparationAlarm(storage)).toBeUndefined();
    const invalid=seed(storage);await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai(async()=>({response:'{"send":true}'}))});expect(preparationView(storage,"decision",invalid.id)).toMatchObject({status:"failed",error:"invalid_preparation"});
  }));
  it("complete/reopen cancels and requeues version-bound capture work; bounded backfill never resurrects completed targets", async () => withStorage(async storage => {
    const created=await handleTodoInbox(request("",{body:"Organize these notes: alpha then beta",operation_id:crypto.randomUUID()}),storage);const {item}=await created.json() as any;
    const complete=await handleTodoInbox(request(`/items/${item.id}`,{version:1,status:"done",operation_id:crypto.randomUUID()},"PATCH"),storage);expect(complete.status).toBe(200);expect(preparationView(storage,"capture",item.id)).toMatchObject({status:"blocked",error:"capture_completed"});backfillTodoPreparation(storage);expect(nextTodoPreparationAlarm(storage)).toBeUndefined();
    expect((await handleTodoInbox(request(`/items/${item.id}`,{version:2,status:"captured",operation_id:crypto.randomUUID()},"PATCH"),storage)).status).toBe(200);expect(preparationView(storage,"capture",item.id).status).toBe("pending");expect(storage.sql.exec<{target_version:number}>("SELECT target_version FROM todo_preparations WHERE target_id=?",item.id).toArray()[0]!.target_version).toBe(3);
    await runTodoPreparation(storage,{ownerID:"owner",ai:ai(async input=>response({body_text:"",source_references:[input.evidence[0].reference]}))});expect(preparationView(storage,"capture",item.id)).toMatchObject({status:"blocked",error:"complete_capture_proposal_unverified"});
  }));
  it("action_review produces complete grounded review and never a reply draft", async () => withStorage(async storage => {
    const b=broker(),decision=seed(storage,"action");await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai(async input=>{expect(input.kind).toBe("action_review");return response({body_text:""});})});expect(preparationView(storage,"decision",decision.id)).toMatchObject({status:"ready",draft_id:null});expect(storage.sql.exec("SELECT * FROM todo_mail_drafts").toArray()).toHaveLength(0);expect(b.sends).toBe(0);
  }));
  it("send rechecks generation after awaited profile reads and source identifiers cannot be edited into a new send context", async () => withStorage(async storage => {
    const b=broker(), decision=seed(storage);await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai()});const ready=preparationView(storage,"decision",decision.id).prepared_draft!;
    b.onProfile=()=>enqueueTodoPreparation(storage,"decision",decision.id,1,"Requeued while send reads source");
    expect((await handleTodoMail(request("/mail/send",{draft_id:ready.id,version:1,operation_id:crypto.randomUUID()}),storage,b.binding,"owner")).status).toBe(409);expect(b.sends).toBe(0);
    b.onProfile=undefined;await runTodoPreparation(storage,{ownerID:"owner",binding:b.binding,ai:ai()});const current=preparationView(storage,"decision",decision.id).prepared_draft!;
    const {updated_at:_at,status:_status,...editable}=current;
    expect((await handleTodoMail(request("/mail/drafts",{...editable,mode:"compose",thread_id:null,reply_message_id:null}),storage,b.binding,"owner")).status).toBe(200);
    expect((await handleTodoMail(request("/mail/send",{draft_id:current.id,version:2,operation_id:crypto.randomUUID()}),storage,b.binding,"owner")).status).toBe(409);expect(b.sends).toBe(0);
  }));
  it("bounded interrupted lease exhaustion becomes discoverably failed without a stuck preparing decision", async () => withStorage(async storage => {
    const decision=seed(storage);storage.sql.exec("UPDATE todo_preparations SET state='preparing',attempt=3,due_at=0 WHERE target_id=?",decision.id);
    await runTodoPreparation(storage,{ownerID:"owner"});expect(preparationView(storage,"decision",decision.id)).toMatchObject({status:"failed",error:"preparation_interrupted"});
    expect(storage.sql.exec<{status:string}>("SELECT status FROM todo_decisions WHERE id=?",decision.id).toArray()[0]!.status).toBe("needs_you");expect(nextTodoPreparationAlarm(storage)).toBeUndefined();
  }));
  it("shared account alarm expires registry tombstones and preserves the minimum preparation/registry alarm", async () => {
    await runInDurableObject((env as unknown as AccountAuthEnv).NANOCODEX_USERS.getByName(crypto.randomUUID()), async (instance,state) => {
      const storage=state.storage, now=Date.now();
      storage.sql.exec("INSERT INTO agent_registry_pending(id,expires_at) VALUES(?,?),(?,?)",crypto.randomUUID(),now-1,crypto.randomUUID(),now+60_000);
      // Account is deliberately absent: alarm must not run external inference.
      const capture=crypto.randomUUID();storage.sql.exec("INSERT INTO todo_captures(id,operation_id,body,created_at) VALUES(?,?,?,?)",capture,crypto.randomUUID(),"Organize these notes: alpha",new Date().toISOString());enqueueTodoPreparation(storage,"capture",capture,1);
      storage.sql.exec("UPDATE todo_preparations SET due_at=? WHERE target_id=?",now+100_000,capture);await instance.alarm();
      expect(storage.sql.exec("SELECT * FROM agent_registry_pending").toArray()).toHaveLength(1);expect(await storage.getAlarm()).toBe(now+60_000);
      storage.sql.exec("UPDATE todo_preparations SET due_at=? WHERE target_id=?",now+30_000,capture);await instance.alarm();expect(await storage.getAlarm()).toBe(now+30_000);await storage.deleteAlarm();
    });
  });
  it("receipt migration preserves old personal policy dedupe and allows independent action_review outcome", async () => withStorage(async storage => {
    storage.sql.exec("CREATE TABLE gmail_firehose_decision_receipts(source_key TEXT PRIMARY KEY,outcome TEXT NOT NULL CHECK(outcome IN ('reply','no_reply','filtered')),created_at INTEGER NOT NULL)");
    storage.sql.exec("INSERT INTO gmail_firehose_decision_receipts VALUES('gmail:old-personal','reply',123)");const receipts=gmailDecisionReceipts(storage);expect(receipts.has("gmail:old-personal")).toBe(true);receipts.mark("gmail:new-action","action_review");expect(receipts.has("gmail:new-action")).toBe(true);receipts.mark("gmail:new-action","filtered");
    expect(storage.sql.exec<{outcome:string}>("SELECT outcome FROM gmail_firehose_decision_receipts_v2 WHERE source_key='gmail:new-action'").toArray()[0]!.outcome).toBe("action_review");expect(gmailDecisionReceipts(storage).has("gmail:old-personal")).toBe(true);
  }));
  it("fingerprint changes for message facts but not unrelated labels/read state", async () => {
    const thread={id:"tfixture",connection_id:connection,messages:[{id:"m",thread_id:"tfixture",body_text:"facts",label_ids:["INBOX"],unread:true}]};
    expect(await todoMailContextFingerprint(thread)).toBe(await todoMailContextFingerprint({...thread,messages:[{...thread.messages[0],label_ids:["INBOX","Label_1"],unread:false}]}));
    expect(await todoMailContextFingerprint(thread)).not.toBe(await todoMailContextFingerprint({...thread,messages:[{...thread.messages[0],body_text:"changed"}]}));
  });
});

describe("capture public research through actual preparation code", () => {
  const capture = async (storage:DurableObjectStorage) => { const r=await handleTodoInbox(request("",{body:"Compare California health insurance options",operation_id:crypto.randomUUID()}),storage);return ((await r.json()) as any).item; };
  it("binds subject, dispatches fixed public search and persists cited complete proposal without writes", async () => withStorage(async storage => {
    const item=await capture(storage);let bound="", searches=0, calls=0;
    const binding={fetch:async(input:Request|string,init?:RequestInit)=>{const r=input instanceof Request?input:new Request(input,init);const p=new URL(r.url).pathname;if(p.startsWith("/subjects/")){bound=p.split("/").at(-1)!;return new Response(null,{status:204});}expect(p).toBe("/v1/search");expect(r.headers.get("x-nanocodex-subject")).toBe(bound);expect(r.headers.get("authorization")).toBe("Bearer NANOCODEX_PROVIDER_CREDENTIAL");const body=await r.json() as any;expect(body.commands).toEqual({search_query:[{q:"California health insurance comparison official coverage"}],response_length:"long"});expect(JSON.stringify(body)).not.toContain("owner_request");searches++;return Response.json({output:"Official coverage (https://www.healthcare.gov/coverage/)\nPublished: 2026-01-01\nCompare plan premiums and deductible coverage before choosing a public insurance plan."});}} as unknown as Fetcher;
    await runTodoPreparation(storage,{ownerID:"owner",binding,ai:ai(async input=>{calls++;if(!input.kind)return {response:JSON.stringify({queries:["California health insurance comparison official coverage"]})};expect(input.evidence.some((e:any)=>e.kind==="web")).toBe(true);return response({body_text:"",proposal:"Compare premiums and deductibles before selecting a plan; final personalized eligibility requires your details.",source_references:["https://www.healthcare.gov/coverage/"]});})});
    expect(preparationView(storage,"capture",item.id)).toMatchObject({kind:"capture",status:"blocked",error:"complete_capture_proposal_unverified",draft_id:null,sources:[{kind:"web",reference:"https://www.healthcare.gov/coverage/"}]});expect(searches).toBe(1);expect(calls).toBe(2);expect(storage.sql.exec("SELECT * FROM todo_mail_drafts").toArray()).toHaveLength(0);
  }));
  it("unavailable public evidence blocks rather than reporting a research plan complete", async () => withStorage(async storage=>{const item=await capture(storage);await runTodoPreparation(storage,{ownerID:"owner"});expect(preparationView(storage,"capture",item.id)).toMatchObject({status:"blocked",error:"research_unavailable",draft_id:null});}));
  it("private names never reach public search", async () => withStorage(async storage=>{const item=await capture(storage);let searches=0;const binding={fetch:async(input:Request|string)=>{const r=input instanceof Request?input:new Request(input);if(new URL(r.url).pathname.startsWith("/subjects/"))return new Response(null,{status:204});searches++;throw new Error("must not dispatch");}} as unknown as Fetcher;await runTodoPreparation(storage,{ownerID:"owner",binding,ai:ai(async()=>({response:JSON.stringify({queries:["Alice Morgan cancer diagnosis Northstar acquisition plans"]})}))});expect(searches).toBe(0);expect(preparationView(storage,"capture",item.id)).toMatchObject({status:"blocked",error:"research_private_context_query"});}));
});

it("never marks imperative future personalized research work ready even with citations", async () => {
  const result=await prepareDecisionProposal(ai(async()=>response({body_text:"",proposal:"Contact providers to obtain your personalized quotes, then compare coverage and decide which plan is best.",source_references:["https://www.healthcare.gov/coverage/"]})),{kind:"capture",owner_request:"Find my personalized eligible insurance price and prepare the complete decision",owner_changes:"",evidence:[{kind:"web",reference:"https://www.healthcare.gov/coverage/",detail:"excerpt",content:"Generic public plan information"}]});
  expect(result).toMatchObject({status:"blocked",missing_information:"complete_capture_proposal_unverified",body_text:""});
});

it("mixed external requests cannot become ready via transformation prefix", async () => {
  const result=await prepareDecisionProposal(ai(async()=>response({body_text:"",source_references:["capture:mixed"]})),{kind:"capture",owner_request:"Summarize current health insurance plans and recommend cheapest eligible quote for me.",owner_changes:"",evidence:[{kind:"user",reference:"capture:mixed",detail:"request",content:"request only"}]});
  expect(result).toMatchObject({status:"blocked",missing_information:"complete_capture_proposal_unverified"});
});

 it("deterministic capture verifies full projection without model, connector or CRM access; Park/reopen stays version fenced", async () => withStorage(async storage => {
   const {item} = await (await handleTodoInbox(request("",{body:"Format this as bullet points:\nalpha\nbeta",operation_id:crypto.randomUUID()}),storage)).json() as any;
   const forbidden = {ownerID:"owner", ai:ai(async()=>{throw Error("unexpected model");}), binding:{fetch:async()=>{throw Error("unexpected provider");}} as unknown as Fetcher,
     crm:{prepare:()=>{throw Error("unexpected CRM");}} as unknown as D1Database};
   await runTodoPreparation(storage, forbidden);
   expect(preparationView(storage,"capture",item.id)).toMatchObject({status:"ready",proposal:"- alpha\n- beta",error:null,draft_id:null,sources:[{kind:"user",reference:`capture:${item.id}`}]});
   expect((await handleTodoInbox(request(`/items/${item.id}`,{version:1,status:"parked",operation_id:crypto.randomUUID()},"PATCH"),storage)).status).toBe(200);
   await runTodoPreparation(storage,forbidden);expect(preparationView(storage,"capture",item.id)).toMatchObject({status:"blocked",error:"preparation_parked"});
   expect((await handleTodoInbox(request(`/items/${item.id}`,{version:2,status:"captured",operation_id:crypto.randomUUID()},"PATCH"),storage)).status).toBe(200);
   await runTodoPreparation(storage,forbidden);expect(preparationView(storage,"capture",item.id).status).toBe("ready");
   expect(storage.sql.exec("SELECT * FROM todo_mail_drafts").toArray()).toHaveLength(0);
 }));
 it("changed deterministic owner request returns to unverified model gate, not old exact projection", async () => withStorage(async storage => {
   const {item} = await (await handleTodoInbox(request("",{body:"Format this as bullet points:\nalpha\nbeta",operation_id:crypto.randomUUID()}),storage)).json() as any;
   await runTodoPreparation(storage,{ownerID:"owner"});expect(preparationView(storage,"capture",item.id).status).toBe("ready");
   await handleTodoInbox(request(`/items/${item.id}/prepare`,{version:1,text:"Also recommend current prices",operation_id:crypto.randomUUID()}),storage);
   await runTodoPreparation(storage,{ownerID:"owner",ai:ai(async input=>response({body_text:"",source_references:[input.evidence[0].reference]}))});
   expect(preparationView(storage,"capture",item.id)).toMatchObject({status:"blocked",error:"complete_capture_proposal_unverified"});
 }));

describe("confirmed stay firehose -> durable proposal -> calendar evidence", () => {
  it("prepares a forwarded stay without an email draft, detects duplicates, and blocks incomplete coverage", async () => withStorage(async storage => {
    const {proposeGmailReplyDecisions} = await import("../src/gmail-firehose-decisions");
    const checkIn = "2090-04-10", checkOut = "2090-04-13";
    const body = `Forwarded confirmation: Pine Hotel booking confirmed. Check-in ${checkIn}. Check-out ${checkOut}. Location: Pine Street.`;
    let calendarFailure=false, duplicate=false, writes=0, calendarReads=0;
    const binding={fetch:async(input:Request|string)=>{
      const r=input instanceof Request?input:new Request(input),p=new URL(r.url).pathname;
      if(p.startsWith("/subjects/"))return new Response(null,{status:204});
      if(p.endsWith("/connectors"))return Response.json({connectors:{gmail:{connected:true,connections:[{id:connection,label:"Synthetic",capabilities:["gmail","gcalendar"],scopes:["https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/calendar"]}]},gcalendar:{connected:true,connections:[{id:connection,label:"Synthetic",capabilities:["gmail","gcalendar"],scopes:["https://www.googleapis.com/auth/calendar"]}]}}});
      if(r.method!=="GET"){writes++;throw new Error("unexpected external mutation");}
      if(p.endsWith("/threads/tfixture"))return Response.json({id:"tfixture",messages:[raw("mfixture",{payload:{...raw().payload,headers:[...raw().payload.headers.filter(h=>h.name!=="Subject"),{name:"Subject",value:"Fwd: Pine Hotel booking confirmed"}],body:{data:btoa(body)}}})]});
      if(p.endsWith("/profile"))return Response.json({emailAddress:"owner@example.test"});
      if(p.endsWith("/calendarList"))return Response.json({items:[{id:"primary",summary:"Personal"}]});
      if(p.endsWith("/events")){calendarReads++;return calendarFailure?new Response(null,{status:503}):Response.json({items:duplicate?[{id:"stay",summary:"Stay at Pine Hotel",start:{date:checkIn},end:{date:checkOut}}]:[]});}
      throw new Error("unexpected provider request");
    }} as unknown as Fetcher;
    const classifier={run:async()=>({state:"Completed",result:{answers:{action:{choice:"booking_review",confidence:0.99,probabilities:{booking_review:0.99,no_action:0.01}}}}})};
    let decisionID="";
    const event=JSON.stringify({type:"gmail.history",connectionId:connection,email:"owner@example.test",messages:[{id:"mfixture",threadId:"tfixture",status:"ok",headers:{from:"Companion <companion@example.test>",subject:"Fwd: Pine Hotel booking confirmed"},body}]});
    const traces:any[]=[];
    const produce=()=>proposeGmailReplyDecisions(event,classifier,{proposeTodoDecision:async input=>{const d=proposeTodoDecision(storage,input);decisionID=d.id;return d;}},()=>{},gmailDecisionReceipts(storage),async t=>{traces.push(t);});
    expect(await produce()).toBe(1);expect(await produce()).toBe(0);
    const extractor={run:async()=>({response:JSON.stringify({property:"Pine Hotel",location:"Pine Street",check_in:checkIn,check_out:checkOut,property_quote:"Pine Hotel",check_in_quote:checkIn,check_out_quote:checkOut})})} as unknown as TodoMailSuggestionAI;
    await runTodoPreparation(storage,{ownerID:"owner",binding,ai:extractor});
    const ready=preparationView(storage,"decision",decisionID);
    expect(ready).toMatchObject({status:"ready",kind:"action_review",draft_id:null});
    expect(ready.proposal).toContain("Exclusive end (checkout): 2090-04-13");expect(calendarReads).toBe(1);expect(writes).toBe(0);
    expect(traces[0]).toMatchObject({policy_version:"gmail-booking-review-triage-v1",reason:"booking_review"});
    expect(storage.sql.exec("SELECT * FROM todo_mail_drafts").toArray()).toHaveLength(0);
    duplicate=true;enqueueTodoPreparation(storage,"decision",decisionID,1);await runTodoPreparation(storage,{ownerID:"owner",binding,ai:extractor});
    expect(preparationView(storage,"decision",decisionID).proposal).toContain("Possible existing event");
    calendarFailure=true;enqueueTodoPreparation(storage,"decision",decisionID,1);await runTodoPreparation(storage,{ownerID:"owner",binding,ai:extractor});
    expect(preparationView(storage,"decision",decisionID)).toMatchObject({status:"blocked",error:"incomplete_calendar_coverage",draft_id:null});expect(writes).toBe(0);
  }));
});

describe("opted-in contextual archive journey",()=>{
 it.each(["confirmed","unknown","revoked","changed","not_opted_in","action_card"])("archives only reviewed message IDs and never retries an ambiguous write: %s",async scenario=>withStorage(async storage=>{
  const {cleanupGmailInbox}=await import("../src/gmail-firehose-cleanup");
  const content="Your payment was received. Receipt only; nothing else is required.";
  let labels=["INBOX","UNREAD"],writes=0,reads=0,authChecks=0;const traces:any[]=[];
  const binding={fetch:async(input:Request|string)=>{
   const r=input instanceof Request?input:new Request(input),path=new URL(r.url).pathname;
   if(path.startsWith("/subjects/"))return new Response(null,{status:204});
   if(path.endsWith("/connectors"))return Response.json({connectors:{gmail:{connected:true,connections:[{id:connection,label:"Synthetic",capabilities:["gmail"],scopes:["https://www.googleapis.com/auth/gmail.modify"]}]}}});
   if(path.endsWith("/threads/tfixture")){reads++;return Response.json({id:"tfixture",messages:[raw("mfixture",{labelIds:labels,payload:{...raw().payload,body:{data:btoa(scenario==="changed"&&reads>1?"Please reply with your decision.":content)}}})]});}
   if(path.endsWith("/messages/batchModify")){writes++;expect(await r.json()).toEqual({ids:["mfixture"],removeLabelIds:["INBOX"]});if(scenario==="unknown")throw new Error("ambiguous network failure");labels=["UNREAD"];return new Response(null,{status:204});}
   throw new Error("unexpected provider route");
  }} as unknown as Fetcher;
  const input=JSON.stringify({type:"gmail.history",connectionId:connection,email:"owner@example.test",archive_non_actionable:scenario!=="not_opted_in",messages:[{id:"mfixture",threadId:"tfixture",status:"ok",headers:{from:"Service <noreply@example.test>",subject:"Payment receipt"},body:content}]});
  const deps={ownerID:"owner",storage,binding,authorize:()=>{},archiveAuthorized:async()=>{authChecks++;return scenario!=="revoked"||authChecks===1;},outcome:()=>scenario==="action_card"?"reply":"no_reply",observe:async(t:any)=>{traces.push(t);},ai:{run:async()=>({answers:{action:{choice:"receipt",confidence:0.99,probabilities:{receipt:0.99,completed:0.0025,expired:0.0025,waiting:0.0025,keep:0.0025}}}})}};
  await cleanupGmailInbox(input,deps);
  if(scenario==="confirmed"||scenario==="unknown") {
   expect(writes).toBe(1);await cleanupGmailInbox(input,deps);expect(writes).toBe(1);
   expect(traces.at(-1)).toMatchObject({outcome:scenario==="confirmed"?"archived":"unavailable",reason:scenario==="confirmed"?"archived_receipt":"archive_unknown"});
  }else expect(writes).toBe(0);
  expect(labels).toContain("UNREAD");
 }));
});
