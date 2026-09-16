# Nanocodex Hand

Native screen capture and input for Nanocodex Hands. This package is part of the supported Rust workspace. Platform permission prompts and capture/input APIs remain owned by the native host.

Windows uses a native, bounded GDI JPEG capture and Win32 input in the signed-in user's desktop. The background Windows service cannot access that desktop from Session 0; its companion logon task publishes the screen with the same machine identity. Locked and elevated secure desktops are not controlled by an ordinary user process.

The shared video publisher can use FFmpeg's `gdigrab` input and software H.264 at 60 Hz. Put `ffmpeg.exe` beside `nanocodex2.exe` or on PATH. If that encoder is unavailable, native JPEG capture still works without an additional executable. Run `cargo run -p nanocodex-hand --example capture_latency` from the signed-in desktop to verify native capture.

For a deployment behind nested NAT without a TURN relay, set
`NANOCODEX_SCREEN_TRANSPORT=frames-v1` on that Hand to use authenticated WebSocket
JPEG frames and input instead of WebRTC. The default remains 60 fps video when
an encoder is available. This setting applies to the shared Rust screen publisher.
