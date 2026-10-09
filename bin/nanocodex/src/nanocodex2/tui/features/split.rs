//! WP2 /split into a tmux/zellij pane.
//! STUB owned by the named work package; replace the body, keep the type name.

use super::{Feature, FeatureCommand, FeatureContext};
use crate::nanocodex2::tui::pane::PaneId;

#[derive(Default)]
pub(crate) struct Split;

impl Feature for Split {
    fn name(&self) -> &'static str {
        "split"
    }

    fn command(&mut self, pane: PaneId, command: &FeatureCommand, cx: &FeatureContext<'_>) -> bool {
        match command {
            FeatureCommand::Split => {
                cx.host.error(Some(pane), "/split is not available yet in the unified TUI");
                true
            }
            #[allow(unreachable_patterns)]
            _ => false,
        }
    }
}
