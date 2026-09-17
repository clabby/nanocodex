# Remote input-to-presentation latency

The native Omarchy publisher now forwards complete encoder packets without
waiting for the following H.264 access-unit delimiter. In the wired 4K test,
this reduced median input-to-scheduled-presentation latency by 13–15 ms.

| Capture framing | Actions | Median | 95th percentile |
| --- | ---: | ---: | ---: |
| Previous Annex-B lookahead | 20 | 92.3 ms | 107.2 ms |
| Explicit encoder packet lengths | 20 | 77.3 ms | 87.2 ms |
| Explicit lengths, second connection | 20 | 79.7 ms | 92.1 ms |

Both new-framing runs had zero decoded-video frame drops and zero video/audio
packet loss. The session retained 3840×2160 capture at 60 Hz, NVENC at a
60,000 kbps ceiling, desktop audio, and leased relative pointer input.
These are short samples on the existing wired network, not a WAN or game-scene
latency guarantee.

## Measurement

The full published account viewer connected to the real Omarchy publisher. A
temporary fullscreen GTK application alternated red and blue on Space. For each
sample, the browser sent a Space down/up pair over the actual leased reliable
control channel. A `requestVideoFrameCallback` sampled the center pixel of the
real video element and detected the changed color. The reported duration is
browser send time to the matching frame's `expectedDisplayTime`, both on the
same monotonic browser clock. It is scheduled presentation timing, not a camera
measurement of photons from a physical monitor. Samples were separated by
150 ms; the test released control and removed the temporary application.

The first comparison also reduced median send-to-packet-receive time from
64.6 to 49.7 ms. This supports the encoder-forwarding path as the source of the
improvement. Original observations and summary statistics are in
[input-latency-measurements.json](input-latency-measurements.json).

A separate experiment set both audio and video receiver `jitterBufferTarget`
values to zero. Its matched color-toggle median was 98.0 ms versus the normal
92.3 ms baseline; it did not improve this setup. Production retains adaptive
browser buffering. No improvement is claimed for that experiment.

## Framing and validation

Pipe reads do not identify frame boundaries. The encoder uses FFmpeg's tee
muxer to flush packet metadata to a separate local pipe before writing the
corresponding Annex-B payload. The companion reads exactly the declared packet
length and forwards an `NCH264F1` stream with unsigned, big-endian 32-bit packet
lengths. Each packet is bounded to 8 MiB; truncated lengths/payloads and invalid
metadata fail closed. The receiver also accepts the previous Annex-B stream.
Set `NANOCODEX_SCREEN_FRAME_BOUNDARIES=annexb` to select the previous encoder
output for troubleshooting. No settings are specific to one GPU or machine.

The Go race suite includes a real FFmpeg test which supplies just one raw frame
and keeps input open: that frame must arrive without another capture or EOF.
Additional tests exercise byte-at-a-time reads, oversized/truncated payloads,
malformed metadata, and legacy Annex-B handling. The staged binary also passed
an actual host NVENC 4K encode: its declared 125,005-byte frame matched the
complete H.264 payload exactly.

This change is implemented in the Go companion. The shared Rust native/VM
publisher still uses delimiter lookahead at the time of this report; its
cross-platform framed-output port requires its own runtime verification.
