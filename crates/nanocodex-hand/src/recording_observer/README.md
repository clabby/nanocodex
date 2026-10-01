# Native workflow observation

`NativeObserver::for_desktop(runtime)` is the recorder entry point. Linux requires
an explicit owner-only Hand runtime with `display` and `Xauthority`; macOS and
Windows use `None`. `new()` permits an ambient desktop for standalone diagnostics.
`sample()` returns OS window/process identity, mouse position/button state,
bounded mouse events, optional role-only accessibility metadata, sensitivity,
and actual observation capabilities. No code reads keyboard events, modifier
state, clipboard contents, titles, accessibility names, or text values.

The caller must enforce recording authorization, a visible recording indicator,
app/window allow and deny lists, duration/storage limits, and pause/stop fencing.
An observation error, unknown/sensitive input, or foreground change must suppress
pixels. Identities are ephemeral native session identifiers, not durable app IDs.

## Platform behavior

- Linux connects directly to a local X11 display with 500 ms protocol deadlines.
  XRes supplies server-reported process IDs; client-supplied `_NET_WM_PID` is not
  trusted. XI2 captures mouse buttons and wheel steps, with a 256-event bound.
  Focus changes invalidate queued mouse attribution. Smooth scrolling without
  wheel emulation is not reported. Input may come from a person or an injector;
  X11 does not provide reliable human attribution. Wayland/Xwayland sessions are
  explicitly unsupported.
- An optional Linux AT-SPI probe uses installed `python3` and `python3-dbus`.
  It connects only to an existing session/accessibility bus. It matches the
  accessibility application's bus-owner PID to XRes, traverses at most 128 nodes,
  reads only states and numeric roles, and emits fixed constants. A visible
  password anywhere in the tree is sensitive. Only a recognized focused
  button/check-box/radio/slider/toggle can report clear; all missing services,
  custom controls, text input, embedded foreign-process UI, ambiguous focus,
  traversal limits, and failures remain unknown. The subprocess is killed and
  reaped after 500 ms. No accessibility service is enabled automatically.
- Linux `frame(expected)` checks context/sensitivity before and after capture.
  Context-only privacy checks preserve queued mouse events for the next sample.
  It reads only the selected window drawable, refuses clipped/overlapped windows,
  unsupported pixel formats and large windows, and returns a JPEG of at most
  1280 pixels per side / 500 kB. It never captures the root desktop. Native
  snapshots are not atomic: callers must not describe this as guaranteed secret
  detection or lossless input recording. AT-SPI reports UI password semantics,
  not the sensitivity of arbitrary document content.
- macOS reads focused application/window and a small allowlist of AX role/subrole
  constants with bounded AX messaging. Accessibility permission is checked
  without a prompt; secure event input and secure text subroles are sensitive.
  Pointer buttons are polled; quick clicks may be missed. Window IDs use public
  WindowServer IDs matched uniquely to the focused AX window by PID and exact
  global position/size, so separate source and sampler observers agree. Missing
  or ambiguous matches fail closed. Scroll and selected-window frames are
  explicitly unavailable in this adapter.
- Windows reads the foreground HWND/process and polls mouse buttons. Password
  state is checked only for native Edit/RichEdit controls via style and a 100 ms
  `EM_GETPASSWORDCHAR` query. Custom/browser controls remain unknown. Secure
  desktop/unavailable focus errors suppress capture. Scroll and selected-window
  frames are explicitly unavailable in this adapter.

## Validation

The executable journey in ignored `output/observer-e2e/` uses a private Xvfb
server and the public observer API, actual X11 windows, and native XTest mouse
injection. It covers scoped desktop selection, XRes identity despite a spoofed
WM PID property, click/release/wheel/focus events, unknown-sensitivity frame
suppression, missing-runtime rejection, explicit Wayland rejection, a stalled X
server timing out at 500 ms, reconnect recovery, and frame checks preserving
queued mouse events. Evidence
is `output/observer-e2e/evidence.jsonl`. This is a native input observation test;
it does not establish that input was human-generated.

The real GTK/AT-SPI journey is
`scripts/tests/hand-recording-gtk-e2e.py /path/to/nanocodex2`. It starts its own
session/accessibility buses, real GTK application, and authenticated Xvfb, then
uses the actual recorder CLI. It checks selected-window JPEG dimensions, overlap
suppression, a real GTK password field suppressing additional frames, and safe
focus recovery. It requires GTK3 introspection, Python D-Bus, AT-SPI2, Xvfb and
Openbox; optional `--sysroot` and `--bus-launcher` support extracted dependencies.
Evidence is retained under `output/observer-gtk-e2e/`, including the safe JPEG,
control transcript, recording export and result JSON. It never connects to a
normal desktop or session bus. macOS/Windows execution still requires native
validation.

Primary API references: [XInput2 protocol](https://cgit.freedesktop.org/xorg/proto/inputproto/tree/specs/XI2proto.txt),
[AT-SPI accessible interface](https://gnome.pages.gitlab.gnome.org/at-spi2-core/devel-docs/doc-org.a11y.atspi.Accessible.html),
[AT-SPI roles](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/enum.Role.html),
[Apple window identity](https://developer.apple.com/documentation/coregraphics/kcgwindownumber),
[Apple AX copy attribute](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue),
[Windows password-character query](https://learn.microsoft.com/en-us/windows/win32/controls/em-getpasswordchar).
