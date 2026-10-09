//! WP4 OpenAI Realtime voice.
//! STUB owned by the named work package; replace the body, keep the type name.

use super::{Feature, FeatureCommand, FeatureContext};
use crate::nanocodex2::tui::pane::PaneId;

#[derive(Default)]
pub(crate) struct RealtimeVoice;

impl Feature for RealtimeVoice {
    fn name(&self) -> &'static str {
        "realtime_voice"
    }

    fn command(&mut self, pane: PaneId, command: &FeatureCommand, cx: &FeatureContext<'_>) -> bool {
        match command {
            FeatureCommand::RealtimeVoice(_) => {
                cx.host.error(Some(pane), "Realtime /voice is not available yet in the unified TUI");
                true
            }
            #[allow(unreachable_patterns)]
            _ => false,
        }
    }
}
