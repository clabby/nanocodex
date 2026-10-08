import { authenticateCompanyAccount, isUserId, type AccountAuthEnv } from "./account-auth";

export type CompanyRole = "owner" | "writer" | "reader";
export type CompanyTeamMembership = {
  team_id: string; user_id: string; role: CompanyRole; name: string; authorization_epoch: number;
  membership_id: string; company_id?: string; company_membership_id?: string;
};
type Company = { company_id?: string; id: string; name: string; authorization_epoch: number; created_at: number };
type Member = { membership_id?: string; company_membership_id?: string; user_id: string; role: CompanyRole; joined_at: number };
type Invitation = { id: string; digest: string; role: "writer" | "reader"; user_id?: string;
  expires_at: number; accepted_by?: string; revoked?: boolean };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const memberKey = (id: string) => `company:member:${id}`;
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (name: string, status: number) => reply({ error: name }, status);
const digest = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), x => x.toString(16).padStart(2, "0")).join("");

/** Company authority is independent of personal account organization grants. Never cache it. */
export async function resolveCompanyTeam(env: AccountAuthEnv, userId: string, teamId: string): Promise<CompanyTeamMembership | undefined> {
  if (!uuid(teamId) || !isUserId(userId)) return undefined;
  const member = await env.NANOCODEX_ORGANIZATIONS.getByName(teamId).resolveCompanyMembership(userId);
  if (!member?.company_id) return member;
  const parent = await env.NANOCODEX_ORGANIZATIONS.getByName(member.company_id).resolveCompanyMembership(userId);
  return parent && !parent.company_id && parent.membership_id === member.company_membership_id ? member : undefined;
}
export async function readCompanyMembership(storage: DurableObjectStorage, userId: string): Promise<CompanyTeamMembership | undefined> {
  const [company, member] = await Promise.all([storage.get<Company>("company:metadata"), storage.get<Member>(memberKey(userId))]);
  return company && member ? { team_id: company.id, user_id: userId, role: member.role,
    name: company.name, authorization_epoch: company.authorization_epoch,
    membership_id: member.membership_id ?? String(member.joined_at),
    ...(company.company_id ? { company_id: company.company_id, company_membership_id: member.company_membership_id } : {}) } : undefined;
}

/** Called only by the existing Organization DO, through trusted service binding requests. */
export async function handleCompanyRequest(storage: DurableObjectStorage, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = await request.json<Record<string, unknown>>();
  const actor = body.actor;
  if (!isUserId(actor)) return error("invalid_subject", 400);
  // One transaction serializes authorization checks with all membership mutations.
  return storage.transaction(async tx => {
    let company = await tx.get<Company>("company:metadata");
    if (url.pathname === "/company/create") {
      if (!uuid(body.id) || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) return error("invalid_team", 400);
      if (company || await tx.get("metadata")) return error("conflict", 409);
      if (body.company_id !== undefined && (!uuid(body.company_id) || typeof body.company_membership_id !== "string")) return error("invalid_company", 400);
      company = { ...(body.company_id ? { company_id: body.company_id as string } : {}), id: body.id, name: body.name.trim(), authorization_epoch: 1, created_at: Date.now() };
      await tx.put({ "company:metadata": company, [memberKey(actor)]: { user_id: actor, role: "owner", joined_at: Date.now(), membership_id: crypto.randomUUID(), ...(company.company_id ? { company_membership_id: body.company_membership_id } : {}) } });
      return reply({ ...company, role: "owner" }, 201);
    }
    if (!company) return error("not_found", 404);
    // This context endpoint is available only on the trusted internal DO transport.
    if (url.pathname === "/company/context") return reply({ company_id: company.company_id });
    if (company.company_id && typeof body.company_membership_id !== "string") return error("not_found", 404);
    if (url.pathname === "/company/accept") {
      if (typeof body.token !== "string" || body.token.length > 128) return error("invalid_invitation", 400);
      const tokenDigest = await digest(body.token);
      const inviteId = await tx.get<string>(`company:token:${tokenDigest}`);
      const invite = inviteId ? await tx.get<Invitation>(`company:invite:${inviteId}`) : undefined;
      if (!invite || invite.revoked || (invite.user_id && invite.user_id !== actor)) return error("invalid_invitation", 404);
      if (invite.accepted_by && invite.accepted_by !== actor) return error("invitation_consumed", 409);
      const stored = await tx.get<Member>(memberKey(actor));
      const existing = stored && (!company.company_id || stored.company_membership_id === body.company_membership_id) ? stored : undefined;
      if (invite.accepted_by === actor) return existing ? reply({ ...existing, team_id: company.id }) : error("membership_revoked", 403);
      if (invite.expires_at <= Date.now()) return error("invitation_expired", 410);
      const member = existing ?? { user_id: actor, role: invite.role, joined_at: Date.now(), membership_id: crypto.randomUUID(), ...(company.company_id ? { company_membership_id: body.company_membership_id as string } : {}) };
      await tx.put({ [memberKey(actor)]: member, [`company:invite:${invite.id}`]: { ...invite, accepted_by: actor } });
      return reply({ ...member, team_id: company.id });
    }
    const member = await tx.get<Member>(memberKey(actor));
    if (!member || (company.company_id && member.company_membership_id !== body.company_membership_id)) return error("not_found", 404);
    if (url.pathname === "/company/read") {
      const members = [...(await tx.list<Member>({ prefix: "company:member:", limit: 1001 })).values()];
      const invitations = member.role === "owner"
        ? [...(await tx.list<Invitation>({ prefix: "company:invite:", limit: 1000 })).values()].map(({ digest: _, ...view }) => view)
        : undefined;
      return reply({ ...company, role: member.role, ...(invitations ? { invitations } : {}), members: members.slice(0, 1000), truncated: members.length > 1000 });
    }
    if (member.role !== "owner") return error("owner_required", 403);
    if (url.pathname === "/company/invite") {
      if ((body.role !== "reader" && body.role !== "writer") || (body.user_id !== undefined && !isUserId(body.user_id))) return error("invalid_invitation", 400);
      if ((await tx.list({ prefix: "company:invite:", limit: 1000 })).size >= 1000) return error("invitation_limit", 429);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, "0")).join("");
      const invite: Invitation = { id: crypto.randomUUID(), digest: await digest(token), role: body.role,
        ...(body.user_id ? { user_id: body.user_id as string } : {}), expires_at: Date.now() + 7 * 86400_000 };
      await tx.put({ [`company:invite:${invite.id}`]: invite, [`company:token:${invite.digest}`]: invite.id });
      const { digest: _, ...view } = invite;
      return reply({ ...view, token, team_id: company.id }, 201);
    }
    if (url.pathname === "/company/revoke-invite") {
      if (!uuid(body.invitation_id)) return error("invalid_invitation", 400);
      const key = `company:invite:${body.invitation_id}`;
      const invite = await tx.get<Invitation>(key);
      if (!invite) return error("not_found", 404);
      await tx.put(key, { ...invite, revoked: true });
      return reply({ revoked: true });
    }
    if (url.pathname === "/company/member") {
      if (!isUserId(body.user_id) || (body.remove !== true && !["owner", "writer", "reader"].includes(String(body.role)))) return error("invalid_member", 400);
      const target = await tx.get<Member>(memberKey(body.user_id));
      if (!target) return error("not_found", 404);
      if (target.role === "owner" && (body.remove || body.role !== "owner")) {
        const members = await tx.list<Member>({ prefix: "company:member:" });
        if (![...members.values()].some(m => m.role === "owner" && m.user_id !== target.user_id)) return error("last_owner", 409);
      }
      if (body.remove) await tx.delete(memberKey(target.user_id));
      else await tx.put(memberKey(target.user_id), { ...target, role: body.role });
      await tx.put("company:metadata", { ...company, authorization_epoch: company.authorization_epoch + 1 });
      return reply(body.remove ? { revoked: true } : { ...target, role: body.role });
    }
    return error("not_found", 404);
  });
}

export async function routeCompanyTeamRequest(request: Request, env: AccountAuthEnv, url: URL): Promise<Response | undefined> {
  if (!/^\/v1\/teams(?:\/[^/]+(?:\/(?:invitations(?:\/[^/]+)?|members\/[^/]+))?)?$/.test(url.pathname)) return undefined;
  const principal = await authenticateCompanyAccount(request, env, url);
  if (!principal) return error("unauthorized", 401);
  if (principal.kind === "api_key" && !principal.capabilities.includes(request.method === "GET" ? "organization:read" : "organization:write")) return error("forbidden_capability", 403);
  if (request.method !== "GET" && (principal.kind === "account_session" || request.headers.has("origin")) && request.headers.get("origin") !== url.origin) return error("forbidden_origin", 403);
  const user = env.NANOCODEX_USERS.getByName(principal.userId);
  if (url.pathname === "/v1/teams" && request.method === "GET") {
    const ids = await user.listCompanyTeams();
    const teams = (await Promise.all(ids.map(id => resolveCompanyTeam(env, principal.userId, id)))).filter(m => m !== undefined).map(m => ({ id: m.team_id, ...m }));
    return reply({ teams });
  }
  let body: Record<string, unknown> = {};
  if (request.method === "POST" || request.method === "PATCH") {
    if (!request.headers.get("content-type")?.startsWith("application/json")) return error("expected_json", 415);
    const raw = await request.text();
    if (raw.length > 8192) return error("payload_too_large", 413);
    try { const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error("invalid_json", 400); body = parsed; } catch { return error("invalid_json", 400); }
  }
  if (url.pathname === "/v1/teams" && request.method === "POST") {
    if ((await user.listCompanyTeams()).length >= 100) return error("team_limit", 429);
    let parent: CompanyTeamMembership | undefined;
    if (body.company_id !== undefined) {
      if (!uuid(body.company_id)) return error("invalid_company", 400);
      parent = await resolveCompanyTeam(env, principal.userId, body.company_id);
      if (!parent) return error("not_found", 404);
      if (parent.company_id) return error("invalid_company", 400);
      if (parent.role !== "owner") return error("owner_required", 403);
    }
    const id = crypto.randomUUID();
    const response = await env.NANOCODEX_ORGANIZATIONS.getByName(id).fetch("https://organization.internal/company/create", { method: "POST", body: JSON.stringify({ id, name: body.name, actor: principal.userId, ...(parent ? { company_id: parent.team_id, company_membership_id: parent.membership_id } : {}) }) });
    if (response.ok) await user.addCompanyTeam(id);
    return response;
  }
  const match = /^\/v1\/teams\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match || !uuid(match[1])) return error("not_found", 404);
  const id = match[1], tail = match[2] ?? "";
  let action: string;
  let input: Record<string, unknown> = {};
  if (!tail && request.method === "GET") action = "read";
  else if (tail === "invitations" && request.method === "POST") { action = "invite"; input = { role: body.role, user_id: body.user_id }; }
  else if (tail === "invitations/accept" && request.method === "POST") {
    if ((await user.listCompanyTeams()).length >= 100 && !(await user.listCompanyTeams()).includes(id)) return error("team_limit", 429);
    action = "accept"; input = { token: body.token };
  } else if (/^invitations\/[^/]+$/.test(tail) && request.method === "DELETE") { action = "revoke-invite"; input = { invitation_id: tail.split("/")[1] }; }
  else if (/^members\/[^/]+$/.test(tail) && ["PATCH", "DELETE"].includes(request.method)) { action = "member"; input = { user_id: tail.split("/")[1], role: body.role, remove: request.method === "DELETE" }; }
  else return error("method_not_allowed", 405);
  const organization = env.NANOCODEX_ORGANIZATIONS.getByName(id);
  const contextResponse = await organization.fetch("https://organization.internal/company/context", { method: "POST", body: JSON.stringify({ actor: principal.userId }) });
  if (!contextResponse.ok) return contextResponse;
  const context = await contextResponse.json<{ company_id?: string }>();
  if (context.company_id) {
    const parent = await resolveCompanyTeam(env, principal.userId, context.company_id);
    if (!parent || parent.company_id) return error("not_found", 404);
    input.company_membership_id = parent.membership_id;
  }
  const response = await organization.fetch(`https://organization.internal/company/${action}`, { method: "POST", body: JSON.stringify({ ...input, actor: principal.userId }) });
  if (response.ok && action === "accept") await user.addCompanyTeam(id);
  return response;
}
