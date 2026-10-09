//! WP1 harness switch on /model before the first prompt.
//! STUB owned by the named work package; replace the body, keep the type name.

use super::{Feature, FeatureCommand, FeatureContext};
use crate::nanocodex2::tui::pane::PaneId;

#[derive(Default)]
pub(crate) struct Harness;

impl Feature for Harness {
    fn name(&self) -> &'static str {
        "harness"
    }

    fn command(&mut self, pane: PaneId, command: &FeatureCommand, cx: &FeatureContext<'_>) -> bool {
        match command {
            FeatureCommand::SwitchModel(_) => {
                cx.host.error(Some(pane), "switching harness is not available yet in the unified TUI");
                true
            }
            #[allow(unreachable_patterns)]
            _ => false,
        }
    }
}
