import { useEffect, useState } from "react";
import { isRecord, responseFailure, useAccountSession } from "./AccountSession";
import { useAccountQuery } from "./useAccountQuery";
import "./TeamsPanel.css";

export type CompanyTeam = { id: string; name: string; role: "owner" | "writer" | "reader"; company_id?: string };
export function decodeTeams(value: unknown): CompanyTeam[] {
  if (!isRecord(value) || !Array.isArray(value.teams)) throw new Error("Invalid teams response.");
  return value.teams.map(decodeTeam);
}
function decodeTeam(value: unknown): CompanyTeam {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !["owner", "writer", "reader"].includes(String(value.role))) throw new Error("Invalid team response.");
  return { id: value.id, name: value.name, role: value.role as CompanyTeam["role"], ...(typeof value.company_id === "string" ? { company_id: value.company_id } : {}) };
}
type Member = { user_id: string; role: CompanyTeam["role"] };
type Invitation = { id: string; role: string; expires_at: number; revoked?: boolean; accepted_by?: string };
function decodeDetail(value: unknown) {
  const team = decodeTeam(value);
  if (!isRecord(value) || !Array.isArray(value.members)) throw new Error("Invalid team members.");
  const members = value.members.map((member): Member => {
    if (!isRecord(member) || typeof member.user_id !== "string" || !["owner", "writer", "reader"].includes(String(member.role))) throw new Error("Invalid member.");
    return { user_id: member.user_id, role: member.role as Member["role"] };
  });
  const invitations = (Array.isArray(value.invitations) ? value.invitations : []).map((invite): Invitation => {
    if (!isRecord(invite) || typeof invite.id !== "string" || typeof invite.role !== "string" || typeof invite.expires_at !== "number") throw new Error("Invalid invitation.");
    return { id: invite.id, role: invite.role, expires_at: invite.expires_at, revoked: invite.revoked === true, accepted_by: typeof invite.accepted_by === "string" ? invite.accepted_by : undefined };
  });
  return { ...team, members, invitations, truncated: value.truncated === true };
}
async function mutate(path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw await responseFailure(response, "Couldn’t update team.");
  return response.json();
}

export function TeamsPanel() {
  const account = useAccountSession();
  const { query, refresh } = useAccountQuery(account.account?.id, "/v1/teams", decodeTeams);
  const [name, setName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [invitation, setInvitation] = useState(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    return fragment.has("team_invitation") ? window.location.href : "";
  });
  useEffect(() => {
    if (new URLSearchParams(window.location.hash.slice(1)).has("team_invitation"))
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); await refresh({ throwOnError: true }); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn’t update teams."); }
    finally { setBusy(false); }
  }
  return <section className="teams-panel" aria-label="Teams">
    <h2>Teams</h2>
    <p>Personal chats stay private. Start a team session explicitly to contribute its conversation to shared context. Companies hold shared knowledge; teams within a company have their own membership and context.</p>
    {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
    <button type="button" onClick={() => void refresh()} disabled={busy}>Refresh teams</button>
    {query.isLoading && <p role="status">Loading teams…</p>}
    <form onSubmit={event => { event.preventDefault(); void act(async () => { const team = decodeTeam(await mutate("/v1/teams", "POST", { name: name.trim(), ...(companyId ? { company_id: companyId } : {}) })); setSelected(team.id); setName(""); }); }}>
      <label>Company<select value={companyId} onChange={event => setCompanyId(event.target.value)}><option value="">Create a new company</option>{query.data?.filter(team => !team.company_id && team.role === "owner").map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
      <label>{companyId ? "Team name" : "Company name"}<input value={name} maxLength={120} required onChange={event => setName(event.target.value)} /></label>
      <button disabled={busy || !name.trim()}>{companyId ? "Create team" : "Create company"}</button>
    </form>
    <form onSubmit={event => { event.preventDefault(); void act(async () => {
      let value: unknown;
      try {
        const link = new URL(invitation);
        if (link.origin !== window.location.origin) throw new Error("foreign invitation");
        const fragment = new URLSearchParams(link.hash.slice(1));
        value = { team_id: fragment.get("team_id"), token: fragment.get("team_invitation") };
      } catch { try { value = JSON.parse(invitation); } catch { throw new Error("Paste the complete invitation link supplied by the owner."); } }
      if (!isRecord(value) || typeof value.team_id !== "string" || typeof value.token !== "string") throw new Error("Invitation needs team_id and token.");
      await mutate(`/v1/teams/${encodeURIComponent(value.team_id)}/invitations/accept`, "POST", { token: value.token }); setInvitation(""); setSelected(value.team_id);
    }); }}>
      <label>Team invitation<textarea value={invitation} onChange={event => setInvitation(event.target.value)} autoComplete="off" /></label>
      <button disabled={busy || !invitation.trim()}>Accept invitation</button>
    </form>
    {query.data?.length === 0 && <p>No teams yet.</p>}
    <ul>{query.data?.map(team => <li key={team.id}><button type="button" aria-pressed={selected === team.id} onClick={() => setSelected(team.id)}>{team.company_id ? "Team" : "Company"}: {team.name} · {team.role}</button></li>)}</ul>
    {selected && query.data?.some(team => team.id === selected) && <TeamDetails key={selected} id={selected} onChanged={() => refresh()} />}
  </section>;
}
function TeamDetails({ id, onChanged }: { id: string; onChanged(): Promise<unknown> }) {
  const account = useAccountSession();
  const base = `/v1/teams/${encodeURIComponent(id)}`;
  const { query, refresh } = useAccountQuery(account.account?.id, base, decodeDetail);
  const [role, setRole] = useState("writer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState("");
  async function act(action: () => Promise<unknown>) {
    if (busy) return; setBusy(true); setError("");
    try { await action(); await refresh({ throwOnError: true }); await onChanged(); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn’t update team."); }
    finally { setBusy(false); }
  }
  const team = query.data;
  return <section aria-label="Team details">
    {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
    {query.isLoading && <p role="status">Loading team…</p>}
    {team && <><h3>{team.name}</h3><p>Your role: {team.role}. Owners manage membership; writers contribute; readers access shared context.</p>
      {team.role === "owner" && <>
        <form onSubmit={event => { event.preventDefault(); void act(async () => {
          const invite = await mutate(`${base}/invitations`, "POST", { role });
          if (!isRecord(invite) || typeof invite.token !== "string") throw new Error("Invalid invitation response.");
          const link = new URL("/connect/access", window.location.origin);
          link.hash = new URLSearchParams({ team_id: id, team_invitation: invite.token }).toString();
          setIssued(link.href);
        }); }}>
          <label>Invitation role<select value={role} onChange={event => setRole(event.target.value)}><option value="writer">Writer</option><option value="reader">Reader</option></select></label>
          <button disabled={busy}>Create invitation</button>
        </form>
        {issued && <div role="status"><p>Share this single-use invitation link privately. It expires in seven days.</p><label>Created invitation<textarea readOnly value={issued} /></label><button type="button" onClick={() => setIssued("")}>Dismiss invitation</button></div>}
        <h4>Invitations</h4>
        <ul>{team.invitations.map(invite => <li key={invite.id}><span>{invite.role} · {invite.revoked ? "Revoked" : invite.accepted_by ? "Accepted" : invite.expires_at <= Date.now() ? "Expired" : "Pending"} · expires {new Date(invite.expires_at).toLocaleDateString()}</span>{!invite.revoked && !invite.accepted_by && <button type="button" disabled={busy} onClick={() => void act(() => mutate(`${base}/invitations/${encodeURIComponent(invite.id)}`, "DELETE"))}>Revoke invitation</button>}</li>)}</ul>
      </>}
      <h4>Members</h4>{team.truncated && <p>Showing the first 1,000 members.</p>}
      <ul>{team.members.map(member => <li key={member.user_id}><span>{member.user_id === account.account?.id ? "You" : member.user_id}</span>{team.role === "owner" ? <>
        <select aria-label={`Role for ${member.user_id}`} value={member.role} disabled={busy} onChange={event => void act(() => mutate(`${base}/members/${encodeURIComponent(member.user_id)}`, "PATCH", { role: event.target.value }))}><option value="owner">Owner</option><option value="writer">Writer</option><option value="reader">Reader</option></select>
        <button type="button" disabled={busy} onClick={() => { if (window.confirm("Remove this member’s access to the team?")) void act(() => mutate(`${base}/members/${encodeURIComponent(member.user_id)}`, "DELETE")); }}>Remove member</button>
      </> : <span>{member.role}</span>}</li>)}</ul>
    </>}
  </section>;
}
