//! Local-only recording ownership. Dropping a task or state drops its audio resources.
use crate::voice_recording::{RecordedSample, Recorder};
use tokio::task::JoinSet;

pub(super) enum State {
    Ready,
    Waiting,
    Busy,
    Starting,
    Stopping,
    Playing,
    Recording(Recorder),
    Review(RecordedSample),
    PlaybackFailed(RecordedSample, String),
}
pub(super) struct Panel {
    pub name: String,
    pub error: Option<String>,
    pub state: State,
    pub tasks: JoinSet<Result<State, String>>,
}
impl Panel {
    pub fn new(name: String) -> Self {
        Self {
            name,
            error: None,
            state: State::Ready,
            tasks: JoinSet::new(),
        }
    }
    pub fn text(&self) -> String {
        let detail = match &self.state {
            State::Ready => "Ready · /voice clone record to start microphone",
            State::Waiting => "Waiting for realtime voice cleanup · /voice clone cancel",
            State::Busy => "Uploading recording…",
            State::Starting => "Opening your microphone… · Esc cancels",
            State::Stopping => "Saving your recording… · Esc cancels",
            State::Playing => "Playing your recording locally… · Esc cancels",
            State::Recording(_) => {
                "RECORDING MICROPHONE LOCALLY · /voice clone stop · /voice clone cancel"
            }
            State::Review(_) | State::PlaybackFailed(_, _) => {
                "Recording stopped · /voice clone review · submit --consent · cancel"
            }
        };
        let elapsed = match &self.state {
            State::Recording(recorder) => {
                let seconds = recorder.elapsed().as_secs();
                let peak = recorder.peak();
                let bars = if peak < 128 {
                    0
                } else {
                    (usize::from(peak.min(8192)) * 12 / 8192).clamp(1, 12)
                };
                format!(
                    "\n● RECORDING  {:02}:{:02} / 02:00   mic [{}{}]",
                    seconds / 60,
                    seconds % 60,
                    "▮".repeat(bars),
                    "·".repeat(12 - bars)
                )
            }
            _ => String::new(),
        };
        let error = self.error.as_deref().unwrap_or("");
        format!(
            "Voice clone: {}\n{detail}{elapsed}\n\nR: start recording   Space/S: stop   P: play sample locally\nU: upload to ElevenLabs with consent   Esc: cancel and delete\n\nPressing U confirms you own this voice or have permission to clone it.\nAudio is recorded locally and never sent to chat. No automatic upload.\n{error}",
            self.name
        )
    }
    pub fn microphone_peak(&self) -> u16 {
        match &self.state {
            State::Recording(recorder) => recorder.peak(),
            _ => 0,
        }
    }
    pub fn start_if_ready(&mut self) {
        if matches!(self.state, State::Waiting) {
            self.state = State::Starting;
            self.tasks
                .spawn(async { Recorder::start().await.map(State::Recording) });
        }
    }
    pub fn record(&mut self) -> Result<(), String> {
        if !matches!(self.state, State::Ready) {
            return Err("Cancel the current recording before starting another.".into());
        }
        self.error = None;
        self.state = State::Waiting;
        Ok(())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        if !matches!(self.state, State::Recording(_)) {
            return Err("No microphone recording is running.".into());
        }
        let State::Recording(recorder) = std::mem::replace(&mut self.state, State::Stopping) else {
            unreachable!()
        };
        self.tasks
            .spawn(async { recorder.stop().await.map(State::Review) });
        Ok(())
    }
    pub fn play(&mut self) -> Result<(), String> {
        if !matches!(self.state, State::Review(_)) {
            return Err("Stop recording before playback.".into());
        }
        let State::Review(sample) = std::mem::replace(&mut self.state, State::Playing) else {
            unreachable!()
        };
        self.error = None;
        self.tasks.spawn(async move {
            match sample.play().await {
                Ok(()) => Ok(State::Review(sample)),
                Err(error) => Ok(State::PlaybackFailed(sample, error)),
            }
        });
        Ok(())
    }
    pub fn review(&self) -> Result<String, String> {
        let State::Review(sample) = &self.state else {
            return Err("Stop a recording before reviewing it.".into());
        };
        Ok(format!(
            "Recording ready for review: {}\nListen to this local audio file before submitting. Nothing has been uploaded.\n/voice clone submit --consent uploads directly to ElevenLabs and confirms you own this voice or have permission to clone it.\n/voice clone cancel deletes the recording.",
            sample.path().display()
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn recording_requires_explicit_start_and_review_requires_stopped_sample() {
        let mut panel = Panel::new("Synthetic voice".into());
        assert!(matches!(panel.state, State::Ready));
        assert!(panel.tasks.is_empty());
        assert!(panel.review().is_err());
        assert!(panel.stop().is_err());
        panel.record().unwrap();
        assert!(matches!(panel.state, State::Waiting));
        assert!(panel.record().is_err());
        assert!(panel.tasks.is_empty()); // Caller must confirm realtime cleanup first.
    }
}
