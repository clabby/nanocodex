# Local patch to webrtc-sys 0.3.45

The codex-voice workspace uses the crates.io webrtc-sys 0.3.45 source (LiveKit,
Apache-2.0) with a small mixer patch. Only the patch is tracked here:

- `overlay/src/nanocodex_pcm.cpp`, `overlay/include/livekit/nanocodex_pcm.h`:
  bounded mono PCM source/mixer decorator and private C ABI used only by
  webrtc-host. They are added to the crate unchanged.
- `webrtc-sys.patch`: `src/peer_connection_factory.cpp` takes the explicitly
  prepared thread-local source as that factory's `dependencies.audio_mixer`, and
  `build.rs` compiles the added translation unit.

`prepare.py` materializes the patched crate into the gitignored
`third_party/codex-voice/vendor/webrtc-sys`, which the workspace's
`[patch.crates-io]` points at. It takes `webrtc-sys-0.3.45.crate` from Cargo's
download cache (`$CARGO_HOME/registry/cache`), or downloads it from
static.crates.io unless `CARGO_NET_OFFLINE=true`/`--offline`, and checks it against
the pinned crates.io SHA-256 before extracting. Overlay files must not already
exist upstream, and the patch must apply exactly (`git apply`, no fuzz); otherwise
the script exits non-zero and leaves any previous tree in place. A fingerprint of
the checksum, script, patch and overlay is stamped into the tree, so reruns are
no-ops until an input changes. The upstream crate's NOTICE.md, metadata and
generated sources (including `libwebrtc/lazy_load_deps_for/*.tramp.S`) come
from the archive itself.

`scripts/build-voice-native.py` (and so `pnpm build:voice-native` and the release
builds) runs it first. Before invoking cargo on this workspace directly, run:

```sh
python3 third_party/codex-voice/patches/webrtc-sys/prepare.py
```

To change the patch, edit the overlay files, or edit the materialized tree and
regenerate `webrtc-sys.patch` from the pristine archive; never commit
`vendor/`. Upgrading webrtc-sys means updating `VERSION`/`SHA256` in
`prepare.py` (the crates.io index `cksum`) and rebasing the patch.

The linked native archive remains webrtc-89d790b; no WebRTC ABI or provider
transport is replaced.

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

The mixer cannot live in webrtc-host alone: upstream's `PeerConnectionFactory`
constructor builds its own `PeerConnectionFactoryDependencies` and exposes no
hook for `audio_mixer`, and libwebrtc's Rust wrappers are typed around that
factory, so installing a mixer requires this one-line constructor change.
