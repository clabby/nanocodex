# Record and clone a voice in the terminal

Set `ELEVENLABS_API_KEY` locally before uploading. Recording requires ffmpeg on macOS or Linux. Homebrew installations in `/opt/homebrew/bin` and `/usr/local/bin` are found even when the launching terminal omits them from PATH; Linux also needs a local PulseAudio/PipeWire server. Recording stops after 120 seconds. In the TUI:

1. Open `/voice` and select **Record a voice clone**, or enter `/voice clone "My voice"`. The local recording panel opens; opening it does not start the microphone.
2. Press **R** (equivalent to `/voice clone record`). Any realtime voice session stops first. Recording starts only after its cleanup is confirmed. The panel and composer strip display a red **● RECORDING**, an elapsed timer, and a live microphone signal meter updated five times per second. The sample never enters chat or realtime input.
3. Speak a clean sample, then press **S** or **Space** (equivalent to `/voice clone stop`). Recording stops and the panel is ready for local playback.
4. Press **P** to play the recording locally and review it. No audio is uploaded during playback.
5. Press **U**, or enter `/voice clone submit --consent` to upload directly to ElevenLabs. This confirms that you own the voice or have permission to clone it. Nothing uploads automatically. The result provides the voice ID or verification instructions; cloning does not select the voice automatically.

`/voice clone record "My voice"` combines opening and explicitly starting recording. **Esc** (equivalent to `/voice clone cancel`) discards the recording or pending recording operation. Exiting the terminal drops the recorder and temporary sample. Realtime voice cannot start while the recording panel is open. If realtime cleanup cannot be confirmed, the recording is cancelled.

The existing file flow remains available: `/voice clone "My voice" "path/to/sample.wav" --consent`. Names and paths containing spaces must be quoted. Once an explicit submit begins, cancellation cannot retract a provider upload; check the result before retrying an uncertain upload.
