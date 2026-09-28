# Local patch to webrtc-sys 0.3.45

The codex-voice workspace builds the crates.io webrtc-sys 0.3.45 source (LiveKit,
Apache-2.0) with a small mixer patch. The linked native archive remains
webrtc-89d790b; no WebRTC ABI or provider transport is replaced. Only the patch
is tracked:

- `overlay/src/nanocodex_pcm.cpp`, `overlay/include/livekit/nanocodex_pcm.h`:
  bounded mono PCM source/mixer decorator and private C ABI used only by
  webrtc-host, added unchanged.
- `webrtc-sys.patch`: `src/peer_connection_factory.cpp` uses the prepared
  thread-local source as that factory's `dependencies.audio_mixer` (upstream
  exposes no other hook), and `build.rs` compiles the added file.

`prepare.py` takes the crate archive from Cargo's download cache or
static.crates.io (never when `CARGO_NET_OFFLINE=true`), verifies the pinned
SHA-256, adds the overlay, and applies the patch exactly. Any failure exits
non-zero and keeps the previous tree. The result goes to the gitignored
`vendor/webrtc-sys` that `[patch.crates-io]` points at, stamped with a
fingerprint of its inputs so reruns are no-ops. `scripts/build-voice-native.py`
runs it; direct cargo commands on this workspace need
`python3 third_party/codex-voice/patches/webrtc-sys/prepare.py` first.
Upgrading means updating `VERSION`/`SHA256` and rebasing the patch.

## Mixer behavior

The decorator forwards all WebRTC sources to AudioMixerImpl and adds PCM to its
48 kHz result. A silent 48 kHz source prevents the default mixer from selecting
8 kHz when all remote tracks are muted. The same AudioTransportImpl then feeds
reverse audio processing and the ADM. Only a factory immediately following
`nanocodex_pcm_create` on the same thread gets this mixer; unrelated factories
retain their original default. State lifetime is shared between the mixer and
opaque ingress handle, so factory teardown cannot leave a dangling callback.

The callback uses a fixed 9,600-sample queue and a try-lock (no waiting, copying
heap buffers or allocation in the added callback). Command writes hold a bounded
short lock; a contended callback emits the existing provider mix for that block.
Cancellation cannot retract a block already returned to AudioTransportImpl.
`nanocodex_pcm_test_render` exercises the actual factory-attached mixer without starting device streams.
Its test-only caller must retain the factory throughout the synchronous call.
