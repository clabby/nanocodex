//! WP4 /mcp login and /mcp reload.
//! STUB owned by the named work package; replace the body, keep the type name.

use super::{Feature, FeatureCommand, FeatureContext};
use crate::nanocodex2::tui::pane::PaneId;

#[derive(Default)]
pub(crate) struct Mcp;

impl Feature for Mcp {
    fn name(&self) -> &'static str {
        "mcp"
    }

    fn command(&mut self, pane: PaneId, command: &FeatureCommand, cx: &FeatureContext<'_>) -> bool {
        match command {
            FeatureCommand::McpLogin(_) | FeatureCommand::McpReload(_) => {
                cx.host.error(Some(pane), "/mcp is not available yet in the unified TUI");
                true
            }
            #[allow(unreachable_patterns)]
            _ => false,
        }
    }
}
