# Native live-screen decode diagnostic

Read-only owner-account diagnostic for **actual published native WebRTC H264**.
No synthetic publisher, screenshots, JPEG recovery, screen control, microphone,
production deployment, display allocation, host restart or device installation.

Uses the existing `nanocodex-cli-auth` normal saved/environment account selection
internally. Never read/export credential files manually or put credentials in
arguments. Authentication, discovery generation, WebSocket leases, TURN URLs,
credentials, candidates and SDP remain inside the process. HTTP redirects are
rejected. Errors use local stage names or HTTP status codes, not response bodies.

```sh
cargo build --manifest-path scripts/native-screen-health/Cargo.toml \
  --target-dir output/native-screen-health-target -j 3
output/native-screen-health-target/debug/nanocodex-screen-health MACHINE_ID SURFACE_ID
```

Requires `ffmpeg` on PATH, and an existing normal owner-account CLI login. The
origin is selected by the normal CLI account abstraction. A missing CLI login
reports `user_login_required`; do not work around it by credential extraction.

The diagnostic opens one current viewer lease, answers its actual publisher
H264 offer, receives decrypted RTP, depacketizes Annex-B NAL units, and streams
them directly into native FFmpeg over stdin. FFmpeg decodes the real frames and
outputs MD5 hashes of decoded raw pixel planes. No frame image or compressed
media is written to disk or emitted. The process prints one bounded JSON report
of peer-state names, RTP/Annex-B/decode counters, frame dimensions and at most
eight raw-pixel MD5 hashes. Success requires at least two native decoded frames.
These are **native decoder counts**, not browser `framesDecoded` statistics.

It performs a 20-second media observation with a 65-second total deadline, one
lease renewal every ten seconds, bounded signaling, and no input/data-channel
messages. Early candidates are queued until the remote description is applied.
Transient network or display failure is reported, never replaced by a synthetic
loopback result. A failure is evidence of the observed run, not proof that the
transport can never work. Changes to production publisher binaries are not part
of this diagnostic.

For native Hands, `MACHINE_ID` is the publisher/account screen machine UUID,
not the agent environment routing key `user:UUID`. Use the UUID component of
that routing key; the publisher uses `AttachmentMachine.id()` unchanged while
agent request routing explicitly prepends `user:`. Do not select a different
machine merely because another publication is available.
