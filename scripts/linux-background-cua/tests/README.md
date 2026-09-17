# Live validation fixtures

These are the actual owned-app probes used on Omarchy. They are development
fixtures, **not commands to aim at a user's desktop**. The verifier types into its
owned foreground GTK entry while transforming a factory-default Blender scene.
Its oracle reads Blender scene/view state, foreground app identity, cursor
position, and entry text; an input acknowledgment alone is insufficient.

The current harness expects a `background-cua/` directory in its working directory
with `fixture-env.json` selecting an isolated compositor. The JSON contains only
XDG_RUNTIME_DIR, WAYLAND_DISPLAY and HYPRLAND_INSTANCE_SIGNATURE. It expects the
companion at `source/crates/experimental/nanocodex-computer/runtime/target/debug/`
and capture helper at `source/scripts/linux-background-cua/capture/target/debug/`.
`hyprctl-fixture.py` always addresses the exact fixture instance.

Run labwc headless with GLES on a supported render device, then nested Hyprland
0.56.2 with a headless output. Use a short, private runtime directory: Hyprland's
instance signature plus the input socket name must fit sockaddr_un. Compile
`primary-keyboard.c` with wayland-client and xkbcommon, generating client headers
and private code from the two included protocol XML files using wayland-scanner.
Both a primary pointer and canonical US keyboard are required; Blender 4.5.3
can divide by zero in custom-cursor setup when the primary seat has no pointer.
Connect this fixture to a FIFO named `primary2-keys.fifo`. Stop old fixture
processes whenever replacing the compositor so they cannot consume FIFO input.

Load the built plugin into **that isolated compositor**, set
`plugin:cua:enabled true`, and call `cua:refresh -j`. Require matching ABI and ready
input transport. Launch Blender with `--factory-startup --python blender-fixture.py`
and NANOCODEX_FIXTURE_RECEIPT pointing to `blender-hypr-baseline-proof.json`.
Launch `foreground-fixture.py` with NANOCODEX_FOREGROUND_RECEIPT pointing to
`foreground-current.json`, keeping that fixture foreground. Run
`public-cua-proof.py`, then `cancel-proof.py`.

The public probe verifies cube translation, orbit, pan, primary typing during
both a transform and an agent-held Shift gesture, unchanged foreground/cursor,
and exact-window capture. The disconnect probe checks that no lane retains a
button/key/drag. The scripts leave their receipts and screenshots for inspection.
They do not establish WoW coexistence on the installed user compositor.
