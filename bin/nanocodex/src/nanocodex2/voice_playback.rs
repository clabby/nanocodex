//! Bounded, generation-fenced local synthesis and cancellable platform playback.
use super::{elevenlabs::Client, error};
use nanocodex_managed::ManagedError;
use std::{io::Write, process::Stdio};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

pub(super) struct Playback {
    queue: mpsc::Sender<(CancellationToken, String)>,
    generation: std::sync::Mutex<CancellationToken>,
    task: tokio::task::JoinHandle<()>,
}
impl Playback {
    pub(super) fn new(client: Client, voice: String, status: watch::Sender<super::Status>) -> Self {
        let (queue, mut pending) = mpsc::channel::<(CancellationToken, String)>(4);
        let task = tokio::spawn(async move {
            while let Some((cancel, text)) = pending.recv().await {
                let result = tokio::select! {
                    biased;
                    () = cancel.cancelled() => continue,
                    result = async { let audio = client.speech(&voice, &text).await?; play(&audio).await } => result,
                };
                if let Err(error) = result {
                    status.send_modify(|s| s.text = format!("ElevenLabs playback failed: {error}"));
                }
            }
        });
        Self {
            queue,
            generation: std::sync::Mutex::new(CancellationToken::new()),
            task,
        }
    }
    pub(super) fn cancel(&self) {
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        generation.cancel();
        *generation = CancellationToken::new();
    }
    pub(super) fn enqueue(&self, text: String) -> Result<(), ManagedError> {
        let generation = self
            .generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        self.queue
            .try_send((generation, text))
            .map_err(|_| error("ElevenLabs speech queue full; reply remains available as text"))
    }
}
impl Drop for Playback {
    fn drop(&mut self) {
        self.cancel();
        self.task.abort();
    }
}
async fn play(audio: &[u8]) -> Result<(), ManagedError> {
    let mut file = tempfile::Builder::new()
        .suffix(".mp3")
        .tempfile()
        .map_err(|_| error("Cannot create private audio temporary file"))?;
    file.write_all(audio)
        .map_err(|_| error("Cannot write audio temporary file"))?;
    #[cfg(target_os = "macos")]
    let mut command = tokio::process::Command::new("/usr/bin/afplay");
    #[cfg(not(target_os = "macos"))]
    let mut command = {
        let mut command = tokio::process::Command::new("ffplay");
        command.args(["-nodisp", "-autoexit", "-loglevel", "error"]);
        command
    };
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let mut child = command.env_clear().arg(file.path()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn().map_err(|_| error("Cannot start audio output; macOS requires afplay, other platforms require ffplay on PATH"))?;
    let status = child
        .wait()
        .await
        .map_err(|_| error("Audio output failed"))?;
    if !status.success() {
        return Err(error("Audio player exited unsuccessfully"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn interruption_invalidates_every_queued_item_and_allows_fresh_speech() {
        let (queue, mut receiver) = mpsc::channel(4);
        let playback = Playback {
            queue,
            generation: std::sync::Mutex::new(CancellationToken::new()),
            task: tokio::spawn(std::future::pending()),
        };
        for _ in 0..4 {
            playback.enqueue("old".into()).unwrap();
        }
        assert!(playback.enqueue("overflow".into()).is_err());
        playback.cancel();
        for _ in 0..4 {
            assert!(receiver.recv().await.unwrap().0.is_cancelled());
        }
        playback.enqueue("new".into()).unwrap();
        let (token, text) = receiver.recv().await.unwrap();
        assert!(!token.is_cancelled());
        assert_eq!(text, "new");
        drop(playback);
        assert!(token.is_cancelled());
    }
}
