//! Local, bounded microphone capture. Audio never leaves this module over a network.
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use tempfile::NamedTempFile;

pub(crate) const MAX_SECONDS: u64 = 120;
const MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Owns a microphone subprocess and its private temporary output.
/// Dropping this value cancels capture, reaps the process, and removes the audio.
pub(crate) struct Recorder {
    child: Option<Child>,
    output: Option<NamedTempFile>,
    started_at: Instant,
}

/// Keeps the validated WAV alive until its consumer has finished uploading it.
pub(crate) struct RecordedSample {
    output: NamedTempFile,
}

impl RecordedSample {
    pub(crate) fn path(&self) -> &Path {
        self.output.path()
    }

    /// Play locally. Dropping this future kills the player; no audio is uploaded.
    pub(crate) async fn play(&self) -> Result<(), String> {
        let mut command = if cfg!(target_os = "macos") {
            sanitized_program("/usr/bin/afplay")
        } else if cfg!(target_os = "linux") {
            let mut command = sanitized_program("ffplay");
            command.args([
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "error",
                "-protocol_whitelist",
                "file,pipe",
            ]);
            command.env("SDL_AUDIODRIVER", "pulseaudio");
            command.env("PULSE_SERVER", local_pulse_server()?);
            command
        } else {
            return Err("Local recording playback is unavailable on this platform.".into());
        };
        command.arg(self.path());
        run_player(command).await
    }
}

impl Recorder {
    pub(crate) fn elapsed(&self) -> Duration {
        self.started_at
            .elapsed()
            .min(Duration::from_secs(MAX_SECONDS))
    }

    /// The caller should stop/collect the sample when this returns true.
    pub(crate) fn is_finished(&mut self) -> Result<bool, String> {
        self.child
            .as_mut()
            .expect("capture child")
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|e| format!("Cannot inspect microphone recorder: {e}"))
    }

    pub(crate) async fn start() -> Result<Self, String> {
        let input = microphone_input()?;
        let output = tempfile::Builder::new()
            .prefix("nanocodex-voice-")
            .suffix(".wav")
            .tempfile()
            .map_err(|e| format!("Cannot create microphone recording: {e}"))?;
        let mut command = sanitized_command();
        command.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
        ]);
        command.args(input);
        command.args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-t",
            &MAX_SECONDS.to_string(),
            "-fs",
            &MAX_BYTES.to_string(),
            "-f",
            "wav",
        ]);
        command.arg(output.path());
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().map_err(|e| {
            format!("Cannot start microphone recording: {e}. Install ffmpeg and make it available on PATH.")
        })?;
        let mut recorder = Self {
            child: Some(child),
            output: Some(output),
            started_at: Instant::now(),
        };
        // Catch missing input backends/devices before telling the user capture started.
        tokio::time::sleep(Duration::from_millis(300)).await;
        if recorder
            .child
            .as_mut()
            .expect("capture child")
            .try_wait()
            .map_err(|e| format!("Cannot inspect microphone recorder: {e}"))?
            .is_some()
        {
            return Err("Microphone capture could not start. Check microphone permission, the default input device, and ffmpeg audio input support.".into());
        }
        Ok(recorder)
    }

    pub(crate) async fn stop(mut self) -> Result<RecordedSample, String> {
        let child = self.child.as_mut().expect("capture child");
        // ffmpeg's interactive quit flushes the WAV header; killing it does not.
        if child
            .try_wait()
            .map_err(|e| format!("Cannot inspect microphone recorder: {e}"))?
            .is_none()
        {
            if let Some(mut stdin) = child.stdin.take() {
                // A broken pipe can mean the duration/size limit already ended capture.
                let _ = stdin.write_all(b"q\n");
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            match child
                .try_wait()
                .map_err(|e| format!("Cannot stop microphone recorder: {e}"))?
            {
                Some(status) => break status,
                None if Instant::now() >= deadline => {
                    return Err(
                        "Microphone recorder did not stop in time; recording discarded.".into(),
                    );
                }
                None => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        };
        if !status.success() {
            return Err("Microphone recording failed. Check microphone permission and the default input device.".into());
        }
        let mut output = self.output.take().expect("capture output");
        validate_wav(output.as_file_mut())
            .map_err(|e| format!("Invalid microphone recording: {e}"))?;
        Ok(RecordedSample { output })
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Reap before NamedTempFile is dropped, including on Windows where an
            // open subprocess handle could otherwise prevent file deletion.
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn microphone_input() -> Result<Vec<String>, String> {
    // AVFoundation resolves "default" through the OS default audio device. Never
    // select an arbitrary enumerated device (which could be loopback/system audio).
    if cfg!(target_os = "macos") {
        Ok(["-f", "avfoundation", "-i", ":default"]
            .map(str::to_owned)
            .to_vec())
    } else if cfg!(target_os = "linux") {
        // Pin PulseAudio to a local socket rather than honoring a user config
        // that could redirect the default server to another machine.
        Ok(vec![
            "-f".into(),
            "pulse".into(),
            "-server".into(),
            local_pulse_server()?,
            "-i".into(),
            "default".into(),
        ])
    } else {
        Err("Microphone recording is supported on macOS (AVFoundation) and Linux (PulseAudio/PipeWire) with ffmpeg. On this platform, use /voice clone with an existing audio file.".into())
    }
}

fn local_pulse_server() -> Result<String, String> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("Local audio requires XDG_RUNTIME_DIR and a local PulseAudio/PipeWire server.")?;
    Ok(format!("unix:{}", runtime.join("pulse/native").display()))
}

async fn run_player(command: Command) -> Result<(), String> {
    let mut command = tokio::process::Command::from(command);
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start local playback: {e}. On Linux, install ffplay."))?;
    let status = tokio::time::timeout(Duration::from_secs(MAX_SECONDS + 5), child.wait())
        .await
        .map_err(|_| "Local playback timed out.".to_owned())?
        .map_err(|e| format!("Local playback failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Local playback failed. Check the default audio output device.".into())
    }
}

fn sanitized_command() -> Command {
    sanitized_program("ffmpeg")
}

fn sanitized_program(program: &str) -> Command {
    let mut command = Command::new(program);
    command.env_clear();
    // Pass only runtime/device discovery settings, never API keys, account
    // credentials, proxy settings, FFREPORT, or dynamic loader overrides.
    for key in [
        "PATH",
        "HOME",
        "TMPDIR",
        "XDG_RUNTIME_DIR",
        "LANG",
        "LC_ALL",
        "SystemRoot",
        "WINDIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
}

fn validate_wav(file: &mut std::fs::File) -> Result<(), String> {
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if !(44..=MAX_BYTES).contains(&len) {
        return Err("empty or oversized WAV".into());
    }
    file.rewind().map_err(|e| e.to_string())?;
    let mut header = [0; 12];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    if u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap())) + 8 != len {
        return Err("incomplete WAV header".into());
    }
    let mut pcm = false;
    let mut data = None;
    let mut offset = 12_u64;
    while offset + 8 <= len {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut chunk = [0; 8];
        file.read_exact(&mut chunk).map_err(|e| e.to_string())?;
        let size = u64::from(u32::from_le_bytes(chunk[4..].try_into().unwrap()));
        if offset + 8 + size > len {
            return Err("truncated WAV data".into());
        }
        if &chunk[..4] == b"fmt " && size >= 16 {
            let mut format = [0; 16];
            file.read_exact(&mut format).map_err(|e| e.to_string())?;
            pcm = format[..2] == 1_u16.to_le_bytes()
                && format[2..4] == 1_u16.to_le_bytes()
                && format[4..8] == 16000_u32.to_le_bytes()
                && format[14..16] == 16_u16.to_le_bytes();
        }
        if &chunk[..4] == b"data" {
            data = Some(size);
        }
        offset += 8 + size + (size % 2);
    }
    if !pcm || !data.is_some_and(|n| n > 0 && n % 2 == 0 && n <= MAX_SECONDS * 16000 * 2) {
        return Err("expected nonempty mono 16 kHz PCM within the 120 second limit".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(samples: usize) -> NamedTempFile {
        let mut file = NamedTempFile::new().unwrap();
        let n = (samples * 2) as u32;
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + n).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt \x10\0\0\0\x01\0\x01\0").unwrap();
        file.write_all(&16000_u32.to_le_bytes()).unwrap();
        file.write_all(&32000_u32.to_le_bytes()).unwrap();
        file.write_all(b"\x02\0\x10\0data").unwrap();
        file.write_all(&n.to_le_bytes()).unwrap();
        file.write_all(&vec![0; n as usize]).unwrap();
        file
    }

    #[test]
    fn validates_pcm_and_rejects_empty_truncated_or_excess_duration() {
        assert!(validate_wav(wav(16000).as_file_mut()).is_ok());
        assert!(validate_wav(wav(0).as_file_mut()).is_err());
        assert!(validate_wav(wav(16000 * 121).as_file_mut()).is_err());
        let mut truncated = wav(10);
        truncated.as_file().set_len(45).unwrap();
        assert!(validate_wav(truncated.as_file_mut()).is_err());
    }

    #[test]
    fn sample_and_cancelled_recorder_remove_audio() {
        let sample = RecordedSample { output: wav(10) };
        let path = sample.path().to_owned();
        drop(sample);
        assert!(!path.exists());
        let output = wav(10);
        let path = output.path().to_owned();
        drop(Recorder {
            child: None,
            output: Some(output),
            started_at: Instant::now(),
        });
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_reaps_child_and_removes_audio() {
        let child = Command::new("sleep").arg("60").spawn().unwrap();
        let pid = child.id();
        let output = wav(10);
        let path = output.path().to_owned();
        drop(Recorder {
            child: Some(child),
            output: Some(output),
            started_at: Instant::now(),
        });
        assert!(!path.exists());
        assert!(
            !Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_playback_kills_player_without_playing_audio() {
        let pid_file = NamedTempFile::new().unwrap();
        let mut command = sanitized_program("/bin/sh");
        command.args(["-c", "echo $$ > \"$1\"; exec sleep 60", "test-player"]);
        command.arg(pid_file.path());
        let task = tokio::spawn(run_player(command));
        let deadline = Instant::now() + Duration::from_secs(5);
        let pid = loop {
            let content = std::fs::read_to_string(pid_file.path()).unwrap();
            if let Ok(pid) = content.trim().parse::<u32>() {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "synthetic player failed to start"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        loop {
            let alive = Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success();
            if !alive {
                break;
            }
            assert!(Instant::now() < deadline, "cancelled player remains alive");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[test]
    fn subprocess_environment_is_allowlisted() {
        let command = sanitized_command();
        assert!(command.get_envs().all(|(key, _)| {
            [
                "PATH",
                "HOME",
                "TMPDIR",
                "XDG_RUNTIME_DIR",
                "LANG",
                "LC_ALL",
                "SystemRoot",
                "WINDIR",
            ]
            .iter()
            .any(|allowed| key == *allowed)
        }));
    }
}
