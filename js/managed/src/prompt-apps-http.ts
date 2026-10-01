import type { Principal } from "./account-auth";
import { AppError, appRequest, type AppOperation, type AppValidator } from "./prompt-apps";

// Includes JSON escaping overhead for a 256 KiB Swift source document.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AppError("invalid_content_type", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("invalid_json");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text = "", bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new AppError("body_too_large", 413); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("invalid_json");
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_json");
  } finally { reader.releaseLock(); }
}
export async function routeAppsRequest(request: Request, db: D1Database | undefined, principal: Principal | null | undefined, validator?: AppValidator): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  if (!principal) return json({ error: "unauthorized" }, 401);
  const write = request.method !== "GET";
  if (principal.kind === "connect_grant" || principal.connectGrant !== undefined
    || !principal.capabilities.includes(write ? "agents:write" : "agents:read") || !principal.capabilities.includes("tools:use")) return json({ error: "forbidden" }, 403);
  const url = new URL(request.url);
  if (write && principal.kind !== "api_key" && request.headers.get("origin") !== url.origin) return json({ error: "forbidden_origin" }, 403);
  if (!db) return json({ error: "apps_unavailable" }, 503);
  try {
    if (url.pathname === "/v1/apps/validate") {
      if (request.method !== "POST" || url.search) throw new AppError("method_not_allowed", 405);
      return json(await appRequest(db, principal.userId, "validate", await body(request), undefined, validator));
    }
    const match = /^\/v1\/apps(?:\/([a-zA-Z0-9_-]{1,128})(\/(?:data|restore))?)?$/.exec(url.pathname);
    if (!match) throw new AppError("not_found", 404);
    const [, id, section] = match;
    const data = section === "/data";
    let operation: AppOperation;
    if (section === "/restore" && request.method === "POST") operation = "restore";
    else if (section === "/restore") throw new AppError("method_not_allowed", 405);
    else if (!id && request.method === "GET") operation = "list";
    else if (!id && request.method === "POST") operation = "save";
    else if (id && request.method === "GET") operation = data ? "data_get" : "get";
    else if (id && request.method === "PUT") operation = data ? "data_set" : "save";
    else if (id && !data && request.method === "DELETE") operation = "delete";
    else throw new AppError("method_not_allowed", 405);
    const input: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams) {
      if (!(operation === "list" ? ["limit", "cursor"] : operation === "delete" ? ["revision"] : []).includes(key) || Object.hasOwn(input, key)) throw new AppError("invalid_query");
      if (key === "revision" || key === "limit") {
        if (!/^[1-9][0-9]*$/.test(value)) throw new AppError("invalid_query");
        input[key] = Number(value);
      } else input[key] = value;
    }
    if (request.method === "POST" || request.method === "PUT" || (request.method === "DELETE" && request.body !== null)) {
      const parsed = await body(request);
      if (Object.hasOwn(parsed, "id") || Object.keys(parsed).some(key => Object.hasOwn(input, key))) throw new AppError("invalid_input");
      Object.assign(input, parsed);
    }
    if (id) input.id = id;
    return json(await appRequest(db, principal.userId, operation, input, undefined, validator), !id && write ? 201 : 200);
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.code, ...(error.validation ? { validation: error.validation } : {}) }, error.status);
    return json({ error: "apps_unavailable" }, 503);
  }
}
