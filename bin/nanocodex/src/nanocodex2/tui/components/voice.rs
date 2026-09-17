//! Composer voice strip, following the original Nanocodex and Codex TUI controls.
use crate::voice_state::{Phase, Status};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

fn meter(peak: u16) -> String {
    let bars = if peak < 512 {
        0
    } else {
        (usize::from(peak.min(8192)) * 5 / 8192).max(1)
    };
    format!("{}{}", "▮".repeat(bars), "·".repeat(5 - bars))
}

pub(super) fn render(frame: &mut Frame<'_>, state: &Status, area: Rect) {
    let phase = match state.phase {
        Phase::Connecting => "Connecting",
        Phase::Stopping => "Stopping",
        Phase::Active if state.muted => "Muted",
        Phase::Active if state.speaking => "Speaking",
        Phase::Active => "Listening",
    };
    let binding = if state.muted { "unmute" } else { "mute" };
    let lines = vec![Line::from(vec![
        Span::styled(format!(" {phase}  "), Style::default().fg(Color::Cyan)),
        Span::raw(format!(
            "mic {}  speaker {} · ctrl+x {binding} · /voice off",
            meter(if state.muted { 0 } else { state.microphone }),
            meter(state.speaker)
        )),
    ])];
    frame.render_widget(Paragraph::new(lines), area);
}
