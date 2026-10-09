//! WP2 local /btw fork, /collapse, /close.
//! STUB owned by the named work package; replace the body, keep the type name.

use super::{Feature, FeatureCommand, FeatureContext};
use crate::nanocodex2::tui::pane::PaneId;

#[derive(Default)]
pub(crate) struct LocalBtw;

impl Feature for LocalBtw {
    fn name(&self) -> &'static str {
        "btw_local"
    }

    fn command(&mut self, pane: PaneId, command: &FeatureCommand, cx: &FeatureContext<'_>) -> bool {
        match command {
            FeatureCommand::Btw(_) | FeatureCommand::Collapse | FeatureCommand::CloseBtw => {
                cx.host.error(Some(pane), "local /btw is not available yet in the unified TUI");
                true
            }
            #[allow(unreachable_patterns)]
            _ => false,
        }
    }
}
