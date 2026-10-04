import type { NamedTool, ToolContext } from "nanocodex";
import type { Principal } from "./account-auth";

/** Dispatch through the public router with a trusted principal, never HTTP identity headers. */
export function workspacePushTools(options: {
  sessionId: string;
  ownerId: string;
  authorizationEpoch: number;
  origin: string;
  authorization(context: ToolContext): Principal | undefined;
  request(request: Request, principal: Principal): Promise<Response>;
}): NamedTool[] {
  return [...(["gmail", "calendar"] as const).map(service => ({
    name: `${service}_watch`,
    description: service === "gmail"
      ? "Enable background Gmail processing for this agent, inspect status, or disable an exact connected Google account's watch. Incoming mail does not create chat turns; enabled TODO processing runs in the background. Enable requires its mailbox email. Optional archive_non_actionable=true authorizes high-confidence contextual archiving of receipts, completed/expired notices and waiting-on-others conversations; it never marks read or deletes. Optional crm=true explicitly imports relevant correspondence into the private CRM. Select the exact connection_id from connected accounts. Does not send email. Direct account authorization required; unavailable through Connect."
      : "Enable continuous Calendar meeting import into the private CRM, inspect status, or disable a watch for this agent and exact Google connection/calendar. Enable requires explicit crm=true; calendar_id defaults to primary. This does not supply meeting notes or send invitations. Direct account authorization required; unavailable through Connect.",
    parameters: { type: "object", additionalProperties: false, required: ["operation", "connection_id"], properties: {
      operation: {type: "string", enum: ["enable", "status", "disable"]},
      connection_id: {type: "string", pattern: "^[A-Za-z0-9_-]{43}$"},
      ...(service === "gmail" ? { email: {type: "string", maxLength: 320, description: "Required for enable: connected mailbox email."}, archive_non_actionable: {type:"boolean",description:"Explicit opt-in to contextual inbox archiving."}, crm: {type: "boolean", description: "Optional explicit CRM opt-in on enable."} }
        : { calendar_id: {type: "string", minLength: 1, maxLength: 1024}, crm: {type: "boolean", enum: [true], description: "Required true for enable."} }),
    } },
    handler: async (input: unknown, context: ToolContext) => {
      context.signal.throwIfAborted();
      const principal = options.authorization(context);
      const body = input as Record<string, unknown>;
      const capability = body?.operation === "status" ? "agents:read" : "agents:write";
      if (!principal || (principal.kind !== "account_session" && principal.kind !== "api_key")
        || principal.connectGrant !== undefined || principal.userId !== options.ownerId
        || principal.authorizationEpoch !== options.authorizationEpoch
        || !principal.capabilities.includes(capability) || !principal.capabilities.includes("tools:use")) {
        throw new Error(`Watch requires current direct account authorization with ${capability} and tools:use`);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)
        || !["enable", "status", "disable"].includes(body.operation as string)
        || typeof body.connection_id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.connection_id)) throw new TypeError("Invalid watch operation or connection_id");
      const enable = body.operation === "enable";
      const allowed = ["operation", "connection_id", ...(service === "calendar" ? ["calendar_id"] : []), ...(enable ? service === "gmail" ? ["email", "crm", "archive_non_actionable"] : ["crm"] : [])];
      if (Object.keys(body).some(key => !allowed.includes(key))) throw new TypeError("Unexpected watch argument");
      if (service === "gmail" && enable && (typeof body.email !== "string" || body.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(body.email)
        || (body.archive_non_actionable !== undefined && typeof body.archive_non_actionable !== "boolean") || (body.crm !== undefined && typeof body.crm !== "boolean"))) throw new TypeError("Enable requires a mailbox email and optional boolean crm");
      if (service === "calendar" && ((enable && body.crm !== true) || (body.calendar_id !== undefined
        && (typeof body.calendar_id !== "string" || !body.calendar_id.trim() || body.calendar_id.length > 1024 || /[\u0000-\u001f\u007f]/.test(body.calendar_id))))) throw new TypeError("Calendar enable requires crm=true and a valid calendar_id");
      const url = new URL(`/v1/agents/${encodeURIComponent(options.sessionId)}/${service}-push/${body.connection_id}`, options.origin);
      if (service === "calendar") url.searchParams.set("calendar_id", (body.calendar_id as string | undefined) ?? "primary");
      const headers = new Headers({origin: url.origin});
      if (enable) headers.set("content-type", "application/json");
      const payload = service === "calendar" ? {crm: true} : {email: body.email, ...(body.archive_non_actionable === undefined ? {} : {archive_non_actionable:body.archive_non_actionable}), ...(body.crm === undefined ? {} : {crm: body.crm})};
      const response = await options.request(new Request(url, {method: enable ? "PUT" : body.operation === "status" ? "GET" : "DELETE", headers,
        ...(enable ? {body: JSON.stringify(payload)} : {}), signal: context.signal}), principal);
      if (!response.ok) {
        // Only known fixed codes may cross the tool boundary, never upstream text.
        const allowed = new Set(["gmail_push_mailbox_denied","gmail_push_unconfigured","gmail_push_unavailable","forbidden","not_found","crm_unavailable"]);
        let code = "request_failed";
        try { const data = await response.json() as {error?:unknown}; if (typeof data.error === "string" && allowed.has(data.error)) code = data.error; } catch { /* no provider details */ }
        throw new Error(`${service} watch request failed (HTTP ${response.status}; ${code})`);
      }
      return response.json();
    },
  })), {
    name:"gmail_triage",
    description:"Inspect account-private Gmail firehose source health and decision traces, or run labeled synthetic backtests through the production Jev policies. Backtests do not modify mail or persist fixtures; they are evaluation, not model training. Direct account authorization only.",
    parameters:{type:"object",additionalProperties:false,required:["operation"],properties:{
      operation:{type:"string",enum:["status","traces","backtest"]},connection_id:{type:"string",pattern:"^[A-Za-z0-9_-]{43}$"},
      limit:{type:"integer",minimum:1,maximum:200},before:{type:"string"},lane:{type:"string",enum:["reply","auto","cleanup"]},
      samples:{type:"array",minItems:1,maxItems:5,items:{type:"object",additionalProperties:false,required:["id","expected","from","subject","body"],properties:{
        id:{type:"string"},expected:{type:"string",enum:["reply","no_reply","action_review","archive","keep"]},from:{type:"string"},subject:{type:"string"},body:{type:"string"}}}}
    }},
    handler:async(input:unknown,context:ToolContext)=>{
      context.signal.throwIfAborted();
      const principal=options.authorization(context),body=input as Record<string,unknown>;
      if(!principal || !["account_session","api_key"].includes(principal.kind) || principal.connectGrant || principal.userId!==options.ownerId
        || principal.authorizationEpoch!==options.authorizationEpoch || !principal.capabilities.includes("tools:use")
        || !principal.capabilities.includes(body?.operation==="backtest"?"agents:write":"agents:read"))throw new Error("Gmail triage requires current direct account authorization");
      if(!body || typeof body!=="object" || Array.isArray(body) || !["status","traces","backtest"].includes(body.operation as string))throw new TypeError("Invalid triage operation");
      const allowed=body.operation==="status"?["operation","connection_id"]:body.operation==="traces"?["operation","limit","before"]:["operation","lane","samples"];
      if(Object.keys(body).some(k=>!allowed.includes(k)))throw new TypeError("Unexpected triage argument");
      const url=new URL(body.operation==="status"?"/v1/todo/source-health":body.operation==="traces"?"/v1/todo/traces":"/v1/todo/decision-backtest",options.origin);
      if(body.operation==="status") {
        if(typeof body.connection_id!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(body.connection_id))throw new TypeError("Invalid connection_id");url.searchParams.set("connection_id",body.connection_id);
      }
      if(body.operation==="traces") {
        if(body.limit!==undefined)url.searchParams.set("limit",String(body.limit));
        if(body.before!==undefined)url.searchParams.set("before",String(body.before));
      }
      const backtest=body.operation==="backtest";
      const response=await options.request(new Request(url,{method:backtest?"POST":"GET",headers:{origin:url.origin,"content-type":"application/json"},signal:context.signal,
        ...(backtest?{body:JSON.stringify({samples:body.samples,lane:body.lane??"auto"})}:{})}),principal);
      if(!response.ok){await response.body?.cancel();throw new Error(`Gmail triage request failed (HTTP ${response.status})`);}
      return response.json();
    }
  }];
}
