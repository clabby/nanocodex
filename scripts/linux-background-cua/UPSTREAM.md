# Hyprland background input experiment

The `upstream/` sources are from trycua/cua commit
`c5a15f3df3b29ffbe774de9f33d632fe75afec75`, directory
`libs/cua-driver/hyprland-plugin`. The upstream MIT license is preserved in
`upstream/LICENSE.md`. The independent-seat design credits Dillon DuPont's
Hyprland prototype in the upstream source. Tests and packaging were omitted;
this copy builds with `BUILD_TESTING=OFF`.

This is an experimental development fixture, not a supported Blender backend.
`build.sh` compiles against exactly Hyprland 0.56.2 and does not load the module.
Use the compositor's compiler family/version and verify its full ABI string.
Input-enabled modules retain Wayland resources until compositor exit; do not
experimentally replace this module in an existing user's desktop session.

The upstream protocol's production-v3 name does not imply generic application
qualification. Upstream qualifying evidence covers only specific native Calc
and Inkscape builds, not Blender or modified/middle-button gestures. Local tests
must observe actual application results and independent primary-seat state.

Capture helper source is derived from trycua/cua commit
`9e60d90b8681d3ba7ccf2c7801dbaa21b0d6efbb`,
`libs/cua-driver/rust/crates/platform-linux/src/wayland/hyprland_capture.rs`.
The only encoder dependency was replaced with the standalone png crate.
Protocol XML retains its own BSD license.

Local changes after the pinned upstream import:

- `DragOptions` extends independent-seat DRAG with an optional evdev button and
  modifier mask. HELLO explicitly advertises `background_drag_options`; legacy
  DRAG keeps its original meaning. Foreground requests reject the suffix.
- The lane holds its own modifier state across motion and releases it after the
  button, including disconnect/cancellation. Parsing tests are in
  `upstream/tests/drag_options_test.cpp` (compile directly with C++23 and `-Isrc`).
- `cua:refresh` explicitly applies the current `plugin:cua:enabled` value without
  reloading the user's configuration or restarting the compositor. `cua:status`
  remains read-only. Activation checks both ABI equality and input readiness.
- Repeat information remains upstream's `(0, 0)`. A temporary repeat-rate change
  was rejected: the Blender fixture crash was caused by a missing primary
  pointer and its uninitialized cursor theme, not keyboard repeat.
