# Terminal voice controls

The managed `nanocodex2` TUI supports ChatGPT and ElevenLabs speech. Run it from
the directory containing your `.env` (or a child directory); startup loads that
file automatically. Set `ELEVENLABS_API_KEY` there or in your environment. Keep
`.env` untracked. Never paste a key into the composer.

- `/voice` toggles voice; `/voice on` and `/voice off` start and stop it.
- `/voice voices` lists ChatGPT voices and your ElevenLabs catalog.
- `/voice voices chatgpt` or `/voice voices elevenlabs` lists one provider.
- `/voice chatgpt cove` selects ChatGPT; `/voice cove` remains supported.
- `/voice elevenlabs VOICE_ID` selects an ElevenLabs catalog or cloned voice.
- `/voice mute`, `/voice unmute`, and Ctrl-X control the microphone.
- `/voice status` shows current status; `/voice help` displays command help.

Selecting a voice starts voice mode. While active, switching stops the old
session and waits for cleanup before reconnecting with the new voice, preserving
microphone mute. The selected voice is remembered when voice is stopped and
started again in the same TUI process. Catalog and clone operations run in the
background and leave the composer responsive. Catalogs, help, and clone results
open a persistent local panel: use arrows, Page Up/Down, or the mouse wheel to
scroll, `c` to copy its text, and Esc to return to your draft.

To record a new sample in place, enter `/voice clone "My voice"`. The recording
modal uses **R** to start, **S** or **Space** to stop, **P** to listen locally,
**U** to upload with the displayed ownership/permission consent, and **Esc** to
cancel and delete. Realtime voice stops and completes cleanup before capture.
Recording is capped at two minutes; audio stays local until you explicitly upload.
See [recording and cloning](tui-cloning.md) for prerequisites and details.

To create an instant clone from an existing local audio sample:

```text
/voice clone "My voice" "recordings/my sample.wav" --consent
```

`--consent` confirms that you own the voice or have permission to clone it.
Quote names and paths containing spaces. Relative paths resolve against the TUI
workspace; `~/` expands to your home directory without shell execution. The result provides the new voice ID and the command to select it;
cloning does not automatically change the active voice. If ElevenLabs requires
verification, complete it there before selecting the clone. Audio is uploaded
directly to ElevenLabs using your local key. The sample, key, and command do not
enter the chat/model prompt. Voice transcription still follows the normal voice
conversation flow.
