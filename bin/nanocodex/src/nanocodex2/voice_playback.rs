//! Bounded, generation-fenced local synthesis and cancellable platform playback.
use super::{elevenlabs::Client, error};
use nanocodex_managed::ManagedError;
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

pub(super) struct Playback {
    queue: mpsc::Sender<(CancellationToken, String)>,
    generation: std::sync::Mutex<CancellationToken>,
    task: tokio::task::JoinHandle<()>,
}
impl Playback {
    pub(super) fn new(
        client: Client,
        voice: String,
        status: watch::Sender<super::Status>,
        active: Arc<dyn Fn(bool) -> Result<(), String> + Send + Sync>,
    ) -> Self {
        let (queue, mut pending) = mpsc::channel::<(CancellationToken, String)>(4);
        let task = tokio::spawn(async move {
            while let Some((cancel, text)) = pending.recv().await {
                if cancel.is_cancelled() {
                    continue;
                }
                let _active = match ActivePlayback::new(active.clone()) {
                    Ok(guard) => guard,
                    Err(message) => {
                        status.send_modify(|s| {
                            s.text = format!("Cannot mute microphone for playback: {message}")
                        });
                        continue;
                    }
                };
                status.send_modify(|s| s.text = format!("ElevenLabs voice {voice} speaking"));
                let result = tokio::select! {
                    biased;
                    () = cancel.cancelled() => continue,
                    result = play(&client, &voice, &text) => result,
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
type Activity = Arc<dyn Fn(bool) -> Result<(), String> + Send + Sync>;
struct ActivePlayback(Activity);
impl ActivePlayback {
    fn new(active: Activity) -> Result<Self, String> {
        active(true)?;
        Ok(Self(active))
    }
}
impl Drop for ActivePlayback {
    fn drop(&mut self) {
        let _ = (self.0)(false);
    }
}

async fn play(client: &Client, voice: &str, text: &str) -> Result<(), ManagedError> {
    let mut command = crate::voice_recording::sanitized_program("ffplay");
    // Explicit raw PCM avoids MP3 probing/buffering and never opens a URL.
    command.args([
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "pipe",
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ch_layout",
        "mono",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-i",
        "pipe:0",
    ]);
    stream_to_player(client, voice, text, command).await
}

async fn stream_to_player(
    client: &Client,
    voice: &str,
    text: &str,
    command: std::process::Command,
) -> Result<(), ManagedError> {
    let mut command = tokio::process::Command::from(command);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped())
        .kill_on_drop(true).spawn()
        .map_err(|_| error("Cannot start streaming audio output. Install ffmpeg (macOS: brew install ffmpeg); ffplay is required."))?;
    let mut stderr = child.stderr.take().expect("piped player diagnostics");
    // Drain continuously to avoid blocking the player, retaining only a bounded
    // diagnostic tail. The child receives no credentials or private URLs.
    let diagnostics = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut buffer = [0u8; 1024];
        while let Ok(n) = stderr.read(&mut buffer).await {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buffer[..n]);
            if tail.len() > 4096 {
                tail.drain(..tail.len() - 4096);
            }
        }
        String::from_utf8_lossy(&tail)
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .take(1200)
            .collect::<String>()
    });
    let mut stdin = child.stdin.take().expect("piped player input");
    // Dropping this future drops the HTTP response and kills the child, including
    // when cancellation interrupts a blocked socket read or pipe write.
    tokio::select! {
        result = async {
            let response = client.speech_stream(voice, text).await?;
            forward_audio(response, &mut stdin).await
        } => result?,
        _ = child.wait() => {
            let detail = diagnostics.await.unwrap_or_default();
            return Err(error(format!("Audio player exited before speech completed; check the default output device. {}", detail.trim())));
        },
    }

    drop(stdin);
    let status = tokio::time::timeout(Duration::from_secs(180), child.wait())
        .await
        .map_err(|_| error("Streaming audio player timed out"))?
        .map_err(|_| error("Audio output failed"))?;
    if !status.success() {
        let detail = diagnostics.await.unwrap_or_default();
        return Err(error(format!(
            "Audio player exited unsuccessfully; check the default output device. {}",
            detail.trim()
        )));
    }
    let _ = diagnostics.await;
    Ok(())
}

async fn forward_audio(
    mut response: reqwest::Response,
    output: &mut (impl AsyncWrite + Unpin),
) -> Result<(), ManagedError> {
    let mut total = 0usize;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("ElevenLabs audio stream failed"))?
    {
        total += chunk.len();
        if total > 16 * 1024 * 1024 {
            return Err(error("ElevenLabs audio exceeded 16 MiB"));
        }
        // Await each bounded pipe write before polling HTTP again: no unbounded
        // queue, complete-response allocation, or speech-bearing temporary file.
        output
            .write_all(&chunk)
            .await
            .map_err(|_| error("Streaming audio player closed its input"))?;
    }
    if total == 0 {
        return Err(error("ElevenLabs returned empty audio"));
    }
    if total % 2 != 0 {
        return Err(error("ElevenLabs returned incomplete PCM audio"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires installed ffplay and an audio output device; plays only synthetic silence"]
    async fn installed_ffplay_accepts_streaming_pcm_options() {
        use axum::{Router, routing::post};
        let app = Router::new().route(
            "/text-to-speech/test/stream",
            post(|| async { vec![0u8; 4800] }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = super::super::elevenlabs::tests::client(format!(
            "http://{}",
            listener.local_addr().unwrap()
        ));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            play(&client, "test", "synthetic silence"),
        )
        .await;
        server.abort();
        result.unwrap().unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn first_pcm_reaches_player_before_response_finishes_and_cancel_closes_both() {
        use std::time::Instant;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = super::super::elevenlabs::tests::client(format!(
            "http://{}",
            listener.local_addr().unwrap()
        ));
        let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0; 1];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            let headers = String::from_utf8(request).unwrap();
            assert!(
                headers.starts_with("POST /text-to-speech/test/stream?output_format=pcm_24000 ")
            );
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .parse()
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/pcm\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\n1234\r\n").await.unwrap();
            socket.flush().await.unwrap();
            // Intentionally never finish this response: the player must receive
            // the first chunk now, and aborting must close this HTTP connection.
            let closed = matches!(socket.read(&mut byte).await, Ok(0) | Err(_));
            let _ = closed_tx.send(closed);
        });
        let directory = tempfile::tempdir().unwrap();
        let pid_path = directory.path().join("pid");
        let audio_path = directory.path().join("audio");
        let mut command = crate::voice_recording::sanitized_program("/bin/sh");
        command.args([
            "-c",
            "echo $$ > \"$1\"; dd bs=4 count=1 of=\"$2\" 2>/dev/null; exec sleep 60",
            "mock-player",
        ]);
        command.arg(&pid_path).arg(&audio_path);
        let active = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = active.clone();
        let callback: Activity = Arc::new(move |value| {
            observed.store(value, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        });
        let task = tokio::spawn(async move {
            let _guard = ActivePlayback::new(callback).unwrap();
            stream_to_player(&client, "test", "hello", command).await
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::fs::read(&audio_path).unwrap_or_default() != b"1234" {
            assert!(
                Instant::now() < deadline,
                "first chunk buffered until response completion"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(active.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!task.is_finished());
        let pid = std::fs::read_to_string(pid_path).unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(!active.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            tokio::time::timeout(Duration::from_secs(2), closed_rx)
                .await
                .unwrap()
                .unwrap()
        );
        while std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
        {
            assert!(Instant::now() < deadline, "cancelled player remains alive");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        server.await.unwrap();
    }

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
