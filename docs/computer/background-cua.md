# Background native computer use

The intended behavior is simultaneous use of the same desktop: human input stays
with the user's foreground application while the agent captures and operates an
explicitly bound background application. A second workspace, restored cursor,
or focus-then-restore sequence does not meet this contract.

## Regressions driving this work

Verified historical reports from September 2026 (these are reported failures,
not fresh reproductions):

- Session `01a0b0bd-67d4-7df3-879f-246e83567ebd`, turn
  `01a0b142-72da-7390-b301-274c7084bcca`: concurrent focus changes caused browser
  input to land in Terminal. Actual event destination is the primary oracle.
- Session `01a0ae34-4b45-7afe-bf0e-632183de716e`, turn
  `01a0ae41-2ab4-7e81-b7bb-9de9a310eabd`: unreadable 639×359 and stale frames.
  Capture must prove current target contents after input, not only produce bytes.
- Same session, turn `01a0ae61-c03e-7c13-85fa-e0214c9c6411`: controller ownership
  prevented confirming input release. Cancellation must release agent-owned
  keys/buttons without releasing a human's physical holds.
- Same session, turn `01a0ae81-2805-77d2-b9ac-4e94beaf0956`: collector tests passed
  while the actual Wayland publisher was disconnected and the feed black.
  Installed public-tool testing is required in addition to helper tests.

## Relevant Sky evidence

The sibling Sky research tree's original symbol inventory contains
`SyntheticAppFocusEnforcer`, separate real/synthetic activation state,
`VirtualCursor`, PID event posting and window-local event coordinates. Its actual
`captureScreenshotWithSkyLight` decompilation uses selected window IDs and
`ignoreGlobalClipShape`. The old rebuild's mandatory foreground activation does
not reproduce that architecture. The exact private event-field recipe is from
current CUA source, not independently recovered Sky code.

References:
- `../sky-re-1000502/archive/1000502/symbols/service.txt`
- `../sky-re-1000502/snapshots/2026-09-06/native-app-state/pipeline/pass6/100e2caf0.c`
- [CUA macOS input](https://github.com/trycua/cua/tree/main/libs/cua-driver/rust/crates/platform-macos/src/input)
- [CUA action evidence](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/action-support.md)

## Hot-path changes

- Text-only `getApp` and `getAXState` do not capture or write hidden images.
- `getScreenshot` refreshes window identity and geometry through a dedicated
  backend hook, without requiring a full accessibility-tree/text traversal.
- Cached app handles use a backend identity-validation hook; native backends can
  avoid enumerating every running application on each action.
- Native drag accepts an explicit mouse button and event-local modifiers, allowing
  Blender-style middle-button orbit and Shift+middle-button pan on capable
  backends. Unsupported backends must refuse before input rather than discard
  the options.

The live-screen `computer` service retains exclusive human-priority control.
Background app actions belong to `cua.getApp`, with exact app/window binding.
Do not remove screen ownership checks to simulate concurrency.

## Acceptance

Use owned foreground and background applications. Verify target state changed
exactly once; foreground app, focus and physical cursor did not move; the target
screenshot is fresh and readable. Cover typing while the human types, modified
and middle-button drags, menus/popups, stale windows/PIDs, resizing, cancellation,
reset and disconnect. Record action and capture latency separately, including
cold and warm captures. API success alone is not delivery evidence.

For Omarchy, final acceptance specifically requires native Wayland Blender while
WoW remains the human's foreground XWayland app, on the installed compositor.
macOS success, X11 tests, another compositor or an isolated desktop does not
establish that result. Track supported routes and test results explicitly.

## Implemented and verified (2026-09-17)

The branch `feat/background-cua` implements background app control separately
from the human-priority live-screen route. The normal screen service and its
ownership checks are unchanged.

macOS uses PID/window-local input and synthetic app focus. Its owned live AppKit
test verified clicks, scrolling, Shift+middle drags and Unicode typing through
MacDesktop while the foreground application stayed unchanged. It does not yet
establish compatibility with Chromium/Electron, arbitrary menus, or every app.
The original Sky private-input recipe was not completely recovered; do not claim
binary-equivalent Sky behavior. Public CGEventPostToPid is still used.

Linux has an opt-in Hyprland app backend, independently bound to a window's
compositor stable ID, address, PID, process start time and executable. Executable
policy approval is separate from the window/session identity, so two Blender
processes do not silently collapse into the same handle. It attests compositor
socket peers, captures the exact toplevel, normalizes HiDPI images to logical
window coordinates, requires a fresh screenshot for coordinate input, and uses
fresh per-operation grants. Unknown/partial transport outcomes are not retried.
Input socket closure releases the lane's keys/buttons. App-state formatting now
supports an app interface on Linux without falsely labeling the OS as macOS.

The actual public MCP stdio API verified, in an owned isolated Hyprland session:

- Factory-default Blender cube translation through `cua.getApp`.
- Middle-button orbit and Shift+middle-button pan, checked against Blender's
  view rotation/location state.
- Foreground GTK typing during both transform commands and held Shift gestures.
- Unchanged primary cursor and foreground PID; lowercase primary text remained
  lowercase while the agent held its own Shift modifier.
- Exact-window screenshots and disconnect midway through a modified drag, with
  zero held buttons/keys/drag afterward.

A quiet run measured about 146 ms for click plus five keys, 279–283 ms for a
250 ms drag, and 400–491 ms for screenshot delivery. During a simultaneous Hand
build, the final run measured 239 ms, 301–303 ms and 827–966 ms respectively.
These are end-to-end experimental debug-build measurements, not a latency SLA.

Validation: 416 parity tests passed; the Linux backend's two input validation
tests passed; the standalone C++ drag-options parser tests passed. JS tests pass
with the opt-in native/browser fixtures skipped; the separate owned Mac live
test supplies background-input evidence. Rust transport tests exercise actual
companion sessions, cancellation, isolation and reset. The Linux Hand binary and
companion compile. See `.build/background-cua` and Omarchy's
`/srv/nanocodex/workspace/background-cua` for retained detailed logs.

Current Linux limits: native Wayland toplevels only; canonical US keyboard layout;
ASCII text with unsupported characters refused before any delivery; visual app
state rather than an accessibility tree; no global clipboard paste, XWayland
background input, or arbitrary subsurface/popup support. WoW may remain the human
foreground app, but this specific combination has **not yet been verified on the
installed user compositor**.

## Omarchy activation boundary

The current Hand service is deliberately configured `NANOCODEX_COMPUTER=off` and
runs as `nanocodex` (UID 960), while the desktop is `gakonst` (UID 1000). SSH as
`gakonst` works, but `sudo -n true` requires a password. No privileged installation,
main-desktop plugin load, graphical-session restart, or existing Blender/WoW
mutation was performed.

The reviewed bundle is staged at
`/srv/nanocodex/workspace/background-cua/omarchy-install`, including SHA256SUMS.
Its installer requires an explicit local administrator command:

```sh
sudo /srv/nanocodex/workspace/background-cua/omarchy-install/install-omarchy.sh --activate
```

It installs immutable paths under `/opt/nanocodex/background-cua`, a narrowly
scoped sudo rule allowing the Hand to run only the fixed desktop companion as
`gakonst`, and a Hand service override using the freshly built CLI. It loads the
ABI-checked plugin once, applies its enable flag via `cua:refresh`, then restarts
only the Hand service. It neither restarts the compositor nor bypasses screen
ownership. The companion attests the desktop user's sole compositor, uses a
sanitized environment, and serializes first activation after compositor restart.
Existing unknown plugins or a changed compositor version refuse activation;
loaded modules are never automatically replaced or unloaded.

After that command, reselect the Omarchy Hand and verify the installed
`cua_repl.js` route against owned windows while the user continues WoW. The
privileged deployment and this final same-desktop WoW acceptance remain pending.

Rollback: remove `99-background-cua.conf` from the Hand's systemd drop-in directory
and `/etc/sudoers.d/nanocodex-background-cua`, daemon-reload and restart the Hand.
As `gakonst`, disable `plugin:cua:enabled` and call `cua:refresh`; the retired seat
resources remain until the compositor naturally exits. Do not unload/replace a
live input plugin or reboot the desktop merely to complete rollback.
