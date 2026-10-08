import { useState } from "react";
import { useAccountSession } from "./AccountSession";
import { useAccountQuery } from "./useAccountQuery";
import { decodeTeams } from "./TeamsPanel";

/** Selection lives only in this explicit creation surface; it never becomes a default. */
export function TeamSessionChooser({ onCreate, onClose }: { onCreate(teamId: string): void; onClose(): void }) {
  const account = useAccountSession();
  const { query, refresh } = useAccountQuery(account.account?.id, "/v1/teams", decodeTeams, { staleTime: 0 });
  const [teamId, setTeamId] = useState("");
  const writable = query.data?.filter(team => team.role !== "reader") ?? [];
  return <form className="team-session-chooser" aria-label="New team session" onSubmit={event => { event.preventDefault(); if (writable.some(team => team.id === teamId)) onCreate(teamId); }}>
    <p>This session contributes its conversation to the selected team’s shared context. Personal sessions remain private.</p>
    {query.error && <p role="alert">{query.error.message} <button type="button" onClick={() => void refresh()}>Retry teams</button></p>}
    {query.isLoading ? <p role="status">Loading teams…</p> : <>
      <label>Team <select value={teamId} onChange={event => setTeamId(event.target.value)}><option value="">Choose a team</option>{writable.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
      {!query.error && writable.length === 0 && <p>Create or join a team as a writer or owner in Account → API access → Teams.</p>}
      <button type="submit" disabled={!writable.some(team => team.id === teamId)}>Start team session</button>
    </>}
    <button type="button" onClick={onClose}>Cancel</button>
  </form>;
}
