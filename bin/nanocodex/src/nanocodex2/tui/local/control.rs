//! WP2: tui-control server registered as kind "native" for the local TUI
//! (prompt/steer/cancel/models.list/history.list/history.read/settings.set).
//! STUB owned by WP2. Agent 11 calls `history_page` from the driver's control bridge.

/// One page of local history for `history.read`; WP2 ports L/control.rs paging.
pub(crate) fn history_page(
    _rollout: Option<&std::path::Path>,
    _before: Option<&str>,
    _limit: usize,
) -> eyre::Result<(Vec<serde_json::Value>, Option<String>)> {
    Ok((Vec::new(), None))
}
