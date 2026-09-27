import type { Principal } from "./account-auth";
import { CrmError, crmRequest } from "./crm";
import { crmIdentityRequest } from "./crm-identities";
import { crmFactRequest, crmRelationshipRequest } from "./crm-context";
import { crmResearchRequest } from "./crm-research";

/** Read-only account CRM boundary. Owner identity never comes from URL input. */
export async function routeCrmRequest(request: Request, db: D1Database | undefined, principal: Principal | null | undefined): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!principal) return json({ error: "unauthorized" }, 401);
  if (principal.kind === "connect_grant" || principal.connectGrant !== undefined
    || !principal.capabilities.includes("agents:read") || !principal.capabilities.includes("tools:use")) return json({ error: "forbidden" }, 403);
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if (!db) return json({ error: "crm_unavailable" }, 503);
  try {
    const url = new URL(request.url);
    const match = /^\/v1\/crm(?:\/([^/]+)(?:\/(identities|facts|relationships))?)?$/.exec(url.pathname);
    if (!match) return json({ error: "not_found" }, 404);
    const recordId = match[1];
    const section = match[2];
    const allowed = !recordId ? ["q", "kind", "tag", "company_id", "limit", "cursor"]
      : section ? ["limit", "cursor"] : ["notes_limit", "notes_cursor", "timeline_limit", "timeline_cursor"];
    const input: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams) {
      if (!allowed.includes(key) || Object.hasOwn(input, key)) throw new CrmError("invalid_input", "Unknown or repeated query parameter.");
      if (key === "limit" || key.endsWith("_limit")) {
        if (!/^[1-9][0-9]*$/.test(value)) throw new CrmError("invalid_input", "Invalid page limit.");
        input[key] = Number(value);
      } else input[key] = value;
    }
    const owner = principal.userId;
    if (!recordId) return json(await crmRequest(db, owner, "search", input, "unused"));
    const list = async (name: string, args: Record<string, unknown>) => {
      const handler = name === "identities" ? crmIdentityRequest : name === "facts" ? crmFactRequest : crmRelationshipRequest;
      const result = await handler(db, owner, "list", { ...args, record_id: recordId }, "unused");
      if (name !== "relationships") return result;
      const page = result as { relationships: { from_id: string; to_id: string }[]; next_cursor: string | null };
      const ids = [...new Set(page.relationships.flatMap(row => [row.from_id, row.to_id]))];
      if (!ids.length) return page;
      // Pages contain up to 100 edges. Individual bound lookups avoid SQLite's
      // variable limit and never disclose an endpoint belonging to another owner.
      const session = db.withSession("first-primary");
      const rows = await session.batch(ids.map(id => session.prepare("SELECT id,name FROM crm_records WHERE owner_id = ? AND id = ?").bind(owner, id)));
      const names = new Map(rows.flatMap(row => row.results as { id: string; name: string }[]).map(row => [row.id, row.name]));
      return { ...page, relationships: page.relationships.map(row => ({ ...row,
        from_name: names.get(row.from_id) ?? null, to_name: names.get(row.to_id) ?? null })) };
    };
    if (section) {
      // Collection helpers may return an empty page for a missing record.
      // Resolve the account-owned record first so every detail route returns 404.
      await crmRequest(db, owner, "get", { id: recordId, notes_limit: 1 }, "unused");
      return json(await list(section, input));
    }
    const record = await crmRequest(db, owner, "get", { ...input, id: recordId }, "unused");
    const [research, identities, facts, relationships] = await Promise.all([
      crmResearchRequest(db, owner, "get", { record_id: recordId }),
      list("identities", {}), list("facts", {}), list("relationships", {}),
    ]) as [object, { identities: unknown[]; next_cursor: string | null }, { facts: unknown[]; next_cursor: string | null }, { relationships: unknown[]; next_cursor: string | null }];
    return json({ ...record as object, ...research,
      identities: identities.identities, identities_next_cursor: identities.next_cursor,
      facts: facts.facts, facts_next_cursor: facts.next_cursor,
      relationships: relationships.relationships, relationships_next_cursor: relationships.next_cursor });
  } catch (error) {
    if (error instanceof CrmError) return json({ error: error.code }, error.code === "not_found" ? 404 : 400);
    return json({ error: "crm_unavailable" }, 503);
  }
}
