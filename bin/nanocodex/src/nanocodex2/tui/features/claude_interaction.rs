//! WP1 Claude AskUserQuestion / ExitPlanMode / permission overlay.
//! STUB owned by the named work package; replace the body, keep the type name.

use super::{Feature, FeatureCommand, FeatureContext};
use crate::nanocodex2::tui::pane::PaneId;

#[derive(Default)]
pub(crate) struct ClaudeInteraction;

impl Feature for ClaudeInteraction {
    fn name(&self) -> &'static str {
        "claude_interaction"
    }

    fn command(&mut self, pane: PaneId, command: &FeatureCommand, cx: &FeatureContext<'_>) -> bool {
        match command {
            _ if false => {
                cx.host.error(Some(pane), "Claude interactions is not available yet in the unified TUI");
                true
            }
            #[allow(unreachable_patterns)]
            _ => false,
        }
    }
}
