# Desktop audio and streaming quality

The Wayland Go publisher and native Rust publisher send desktop output as a
stereo Opus WebRTC track: 48 kHz, 128 kbit/s, 20 ms packets. Audio shares the
existing authenticated peer and authorization lifecycle. Linux resolves the
actual playback sink monitor; Windows uses native WASAPI render loopback. Neither
falls back to a microphone. Frames-v 1 and the macOS native publisher currently
remain video-only.

The web viewer retains both tracks in one MediaStream. Enable sound is a user
gesture so browser autoplay rules can unlock playback; a denied sound request
falls back to muted video. Closing the viewer detaches both tracks. Audio-source
failure does not disconnect video. The playback endpoint is selected at publisher
startup; changing the default endpoint requires restarting the publisher.

The Go Ogg reader checks page checksums, preserves individual packet boundaries
across page aggregation/continuation, and bounds every packet. Actual PipeWire
capture can aggregate two Opus packets even with a 20 ms page-duration setting;
a regression test covers this observed behavior. Rust consumes bounded stereo
PCM directly and encodes Opus; the Windows producer has a bounded queue and a
cancellation-aware lifetime.

## Measured sound, not merely a negotiated track

On Omarchy, a four-second 997 Hz WAV was played through the ordinary desktop
playback sink. An actual Chromium viewer received the live publisher through
production authorization/signaling. Its Web Audio analyser measured maximum RMS
0.10858 and the expected nearest FFT bin at 996.09 Hz. WebRTC received 319 audio
packets with zero loss and nonzero decoded audio energy. Audio and video tracks
were live; 377 video frames decoded during the measurement. No desktop audio
recording or credentials are retained in the evidence file.

This first measurement used the actual viewer component with an account-context
fixture and a local authenticated proxy. A separate published-app measurement
is recorded after deployment. Measurements are individual local wired-network
samples, not a guarantee for cellular or WAN connections.

## Quality configuration

`NANOCODEX_SCREEN_BITRATE_KBPS` accepts 1000 through 100000; the default stays 6000.
The Wayland publisher passes this bitrate to its existing video encoder. Windows
also accepts `NANOCODEX_SCREEN_MAX_DIMENSION` from 1280 through 7680, default 1280,
keeps the display aspect ratio, and never upscales. Its H.264 level accounts for
resolution, frame rate, and bitrate.

The Omarchy desktop was configured separately for 3840 by 2160 at 60 Hz, scale 2,
with NVIDIA NVENC and 60000 kbit/s. A 30-second 40 Mbit/s motion test decoded 1800
frames with zero dropped frames, loss, or freezes. At 60 Mbit/s, the subsequent
30-second motion test decoded 1758 frames, reported 61 fps, and again had zero
loss, drops, or freezes; average quantization parameter fell from 16.5 to 11.3.
These are separate live runs, not a same-frame image-quality comparison.

## Checks

Focused Rust screen/audio tests, Go race tests including a real FFmpeg Opus
encoder, browser viewer tests, full web typechecking, and the production build
cover the changed paths. The full account test run also exercises the existing
450-entry IndexedDB recovery test. That test exceeded its prior 10-second CI
budget and took 7.92 seconds locally; its budget is now 30 seconds with its
pagination assertions preserved. Existing documentation spelling and Rust
item-order lint failures were repaired without changing runtime behavior.
