//! WP2: local session source for the resume picker, `ncl resume [ID] [--from ROLLOUT --at N]`
//! and in-TUI /attach. STUB owned by WP2; keep these signatures (agent 11 wires them) or
//! record a signature change in output/unify/wp0/NOTES.md.

use std::path::Path;

use crate::nanocodex2::tui::session::SessionSummary;

/// Recent local Codex and Claude sessions for `workspace`, newest first.
pub(crate) fn list(_workspace: &Path) -> eyre::Result<Vec<SessionSummary>> {
    Ok(Vec::new())
}

/// History of a resumed local session as agent events, oldest first, for replay
/// through the managed projection (`super::events::Bridge`).
pub(crate) fn replay_events(
    _session: &nanocodex::agent::rollout::DurableSession,
) -> eyre::Result<Vec<nanocodex::agent::events::AgentEvent>> {
    Ok(Vec::new())
}
