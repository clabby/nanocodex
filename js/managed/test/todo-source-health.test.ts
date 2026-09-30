import { isManagedRoutePath } from "../../account/worker/managedProxy";
import { describe,it,expect } from "vitest";
import { readTodoSourceHealth } from "../src/todo-source-health";
import { routeTodoRequest } from "../src/todo-inbox";
const connection="D".repeat(43);
const request=(query=`connection_id=${connection}`,method="GET")=>new Request(`https://example.test/v1/todo/source-health?${query}`,{method});
const fixture=(data:unknown,status=200)=>{const calls:Request[]=[];const binding={fetch:async(input:Request|string,init?:RequestInit)=>{calls.push(input instanceof Request?input:new Request(input,init));return Response.json(data,{status});}} as unknown as Fetcher;return {binding,calls};};
describe("protected metadata-only existing source health",()=>{
 it("uses stored account owner, GET only, strips all identity/history/provider secrets",async()=>{
  const f=fixture({enabled:true,pending:false,expiration:String(Date.now()+3600000),lastError:null,renewalError:null,agentId:"private",email:"private@example.test",cursor:"123",targetHistoryId:"456",userId:"other",secret:"never-return"});
  const r=await readTodoSourceHealth(request(),f.binding,"stored-owner");const value=await r.json() as any;
  expect(value).toMatchObject({status:"partial",health:"configured",enabled:true,pending:false,error:null,scope:{labels:["INBOX"],archived_excluded:true,complete:false}});
  expect(JSON.stringify(value)).not.toMatch(/private|never-return|cursor|targetHistoryId|agentId|userId/);expect(f.calls).toHaveLength(1);expect(f.calls[0]!.method).toBe("GET");expect(f.calls[0]!.url).toBe(`https://egress.internal/users/stored-owner/gmail-push/${connection}`);expect(f.calls[0]!.body).toBeNull();expect(r.headers.get("cache-control")).toBe("no-store");
 });
 it.each(["enabled","disabled","expired","pending","retrying"])("never infers complete coverage from %s",async kind=>{
  const f=fixture({enabled:kind!=="disabled",pending:kind==="pending",expiration:String(Date.now()+(kind==="expired"?-1:3600000)),lastError:kind==="retrying"?"gmail_or_wake_retry":null,renewalError:null});const value=await (await readTodoSourceHealth(request(),f.binding,"owner")).json() as any;expect(value.status).toBe("partial");expect(value.scope.complete).toBe(false);expect(value.health).toBe(kind==="enabled"?"configured":kind);
 });
 it.each([403,404,503,302])("sanitizes broker status%s without exposing response bodies",async status=>{const f=fixture({secret:"provider-secret"},status);const r=await readTodoSourceHealth(request(),f.binding,"owner");expect((await r.json() as any).status).toBe("unknown");expect(f.calls).toHaveLength(1);});
 it("does not return raw errors",async()=>{const f=fixture({enabled:true,pending:false,expiration:String(Date.now()+100000),lastError:"Bearer private-credential",renewalError:"private-email"});const value=await (await readTodoSourceHealth(request(),f.binding,"owner")).json() as any;expect(value.error).toBe("unrecognized_provider_error");expect(JSON.stringify(value)).not.toContain("private");});
 it.each(["",`connection_id=${connection}&owner_id=other`,`connection_id=${connection}&connection_id=${connection}`,"connection_id=../other"])("rejects query%s before dispatch",async query=>{const f=fixture({enabled:false});expect((await readTodoSourceHealth(request(query),f.binding,"owner")).status).toBe(400);expect(f.calls).toHaveLength(0);});
 it("rejects writes before dispatch and unavailable reads stay unknown",async()=>{const f=fixture({enabled:false});expect((await readTodoSourceHealth(request(undefined,"PUT"),f.binding,"owner")).status).toBe(405);expect(f.calls).toHaveLength(0);expect((await (await readTodoSourceHealth(request(),undefined,"owner")).json() as any).status).toBe("unknown");});
 it("enforces account auth, read capability, Connect denial and owner route without trusting caller owner",async()=>{
  const calls:any[]=[];const env={NANOCODEX_USERS:{getByName:(owner:string)=>({fetch:async(url:string)=>{calls.push({owner,url});return Response.json({status:"unknown"});}})}} as any;const r=request();const url=new URL(r.url);
  expect((await routeTodoRequest(r,env,url,null))!.status).toBe(401);
  const me={kind:"api_key",userId:"trusted-principal",capabilities:["agents:read"]} as any;
  expect((await routeTodoRequest(r,env,url,{...me,connectGrant:{}}))!.status).toBe(403);expect((await routeTodoRequest(r,env,url,{...me,capabilities:[]}))!.status).toBe(403);expect(calls).toHaveLength(0);
  expect((await routeTodoRequest(r,env,url,me))!.status).toBe(200);expect(calls[0]).toEqual({owner:"trusted-principal",url:`https://user.internal/todo/source-health?connection_id=${connection}`});
 });
});

it("website proxy exposes only exact source-health product path",()=>{expect(isManagedRoutePath("/v1/todo/source-health")).toBe(true);expect(isManagedRoutePath("/v1/todo/source-health/enable")).toBe(false);expect(isManagedRoutePath("/v1/todo/source-health/../credentials")).toBe(false);});
