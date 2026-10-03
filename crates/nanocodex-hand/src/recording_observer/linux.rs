//! X11 metadata and XI2 mouse-only observation. Xwayland is deliberately refused.
use super::*;
use std::{
    io,
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::{
        Event,
        xinput::{ConnectionExt as _, EventMask, XIEventMask},
        xproto::{AtomEnum, ConnectionExt as _},
    },
    rust_connection::{DefaultStream, PollMode, RustConnection, Stream},
};
use x11rb_protocol::RawFdContainer;

// x11rb's default poll has no deadline. Nonblocking reads/writes remain native;
// short bounded sleeps permit retries without an unbounded native poll call.
struct DeadlineStream {
    inner: DefaultStream,
    deadline: std::sync::Mutex<Instant>,
}
impl DeadlineStream {
    fn arm(&self) {
        *self.deadline.lock().unwrap_or_else(|e| e.into_inner()) =
            Instant::now() + Duration::from_millis(500);
    }
    fn check(&self) -> io::Result<()> {
        if Instant::now() >= *self.deadline.lock().unwrap_or_else(|e| e.into_inner()) {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "X11 observation deadline exceeded",
            ))
        } else {
            Ok(())
        }
    }
}
impl Stream for DeadlineStream {
    fn poll(&self, _: PollMode) -> io::Result<()> {
        self.check()?;
        std::thread::sleep(Duration::from_millis(2));
        self.check()
    }
    fn read(&self, buf: &mut [u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.check()?;
        self.inner.read(buf, fds)
    }
    fn write(&self, buf: &[u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.check()?;
        self.inner.write(buf, fds)
    }
}
fn failed(_: impl fmt::Display) -> ObserverError {
    // Do not include server-controlled text or authentication diagnostics.
    ObserverError::new(
        "native_observation_failed",
        "X11 metadata unavailable, disconnected, or timed out",
    )
}
pub(super) struct Observer {
    connection: RustConnection<DeadlineStream>,
    root: u32,
    active: u32,
}
impl Observer {
    pub(super) fn new() -> Result<Self> {
        Self::connect(None)
    }
    pub(super) fn for_desktop(runtime: Option<&std::path::Path>) -> Result<Self> {
        if runtime.is_none() {
            return Err(ObserverError::new(
                "desktop_required",
                "Hand recording requires an explicit private X11 runtime",
            ));
        }
        Self::connect(runtime)
    }
    fn connect(runtime: Option<&std::path::Path>) -> Result<Self> {
        if std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"))
        {
            return Err(ObserverError::new(
                "unsupported_wayland",
                "Wayland has no authorized global observation API; Xwayland cannot verify foreground context",
            ));
        }
        let display = match runtime {
            Some(path) => {
                String::from_utf8(read_private(path.join("display"), 32)?).map_err(failed)?
            }
            None => std::env::var("DISPLAY").map_err(|_| {
                ObserverError::new(
                    "display_unavailable",
                    "An authorized local X11 display is required",
                )
            })?,
        };
        // No TCP connection, network timeout, or remote desktop authentication.
        if !display.starts_with(':') && !display.starts_with("unix:") {
            return Err(ObserverError::new(
                "unsupported_display",
                "Only a local Unix X11 display can be observed",
            ));
        }
        let parsed =
            x11rb_protocol::parse_display::parse_display(Some(&display)).map_err(failed)?;
        let mut connected = None;
        for address in parsed.connect_instruction() {
            if let Ok((stream, (family, peer))) = DefaultStream::connect(&address) {
                let (name, data) = match runtime {
                    Some(path) => private_auth(
                        &read_private(path.join("Xauthority"), 4096)?,
                        parsed.display,
                    )?,
                    None => x11rb_protocol::xauth::get_auth(family, &peer, parsed.display)
                        .map_err(failed)?
                        .unwrap_or_default(),
                };
                let stream = DeadlineStream {
                    inner: stream,
                    deadline: std::sync::Mutex::new(Instant::now() + Duration::from_millis(500)),
                };
                connected = Some(
                    RustConnection::connect_to_stream_with_auth_info(
                        stream,
                        usize::from(parsed.screen),
                        name,
                        data,
                    )
                    .map_err(failed)?,
                );
                break;
            }
        }
        let connection = connected.ok_or_else(|| {
            ObserverError::new(
                "display_unavailable",
                "Cannot connect to the authorized local X11 display",
            )
        })?;
        let root = connection
            .setup()
            .roots
            .get(usize::from(parsed.screen))
            .ok_or_else(|| failed("screen"))?
            .root;
        connection.stream().arm();
        let active = connection
            .intern_atom(false, b"_NET_ACTIVE_WINDOW")
            .map_err(failed)?
            .reply()
            .map_err(failed)?
            .atom;
        connection
            .xinput_xi_query_version(2, 0)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        // XIAllMasterDevices = 1. Never select key or raw-motion events.
        connection
            .xinput_xi_select_events(
                root,
                &[EventMask {
                    deviceid: 1,
                    mask: vec![XIEventMask::RAW_BUTTON_PRESS | XIEventMask::RAW_BUTTON_RELEASE],
                }],
            )
            .map_err(failed)?
            .check()
            .map_err(failed)?;
        connection
            .change_window_attributes(
                root,
                &x11rb::protocol::xproto::ChangeWindowAttributesAux::new()
                    .event_mask(x11rb::protocol::xproto::EventMask::PROPERTY_CHANGE),
            )
            .map_err(failed)?
            .check()
            .map_err(failed)?;
        connection.flush().map_err(failed)?;
        Ok(Self {
            connection,
            root,
            active,
        })
    }
    pub(super) fn native_button_events(&self) -> bool {
        true
    }
    fn foreground(&self) -> Result<u32> {
        let reply = self
            .connection
            .get_property(false, self.root, self.active, AtomEnum::WINDOW, 0, 1)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        let window = reply
            .value32()
            .and_then(|mut v| v.next())
            .filter(|id| *id > 1);
        window.ok_or_else(|| {
            ObserverError::new(
                "foreground_unavailable",
                "The X11 window manager did not supply a foreground window",
            )
        })
    }
    /// Read only the selected drawable, never the root framebuffer. Refuse
    /// obscuration because core X11 gives undefined pixels for covered regions.
    pub(super) fn frame(&mut self, expected: &ForegroundContext) -> Result<ObservedFrame> {
        use x11rb::protocol::xproto::{ImageFormat, ImageOrder};
        self.connection.stream().arm();
        let window = self.foreground()?;
        if expected.window_id != format!("x11:{window}") {
            return Err(failed("focus changed"));
        }
        let (width, height) = self.unobscured(window)?;
        let reply = self
            .connection
            .get_image(ImageFormat::Z_PIXMAP, window, 0, 0, width, height, u32::MAX)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        let setup = self.connection.setup();
        let format = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == reply.depth)
            .ok_or_else(|| failed("pixel format"))?;
        if format.bits_per_pixel != 32 || format.scanline_pad != 32 {
            return Err(ObserverError::new(
                "capture_unsupported",
                "X11 capture requires a 32-bit TrueColor pixel format",
            ));
        }
        let visual = setup
            .roots
            .iter()
            .flat_map(|s| &s.allowed_depths)
            .flat_map(|d| &d.visuals)
            .find(|v| v.visual_id == reply.visual)
            .ok_or_else(|| failed("visual"))?;
        if visual.red_mask != 0xff0000 || visual.green_mask != 0xff00 || visual.blue_mask != 0xff {
            return Err(ObserverError::new(
                "capture_unsupported",
                "X11 capture requires an RGB TrueColor visual",
            ));
        }
        if reply.data.len() != usize::from(width) * usize::from(height) * 4 {
            return Err(failed("image size"));
        }
        let lsb = setup.image_byte_order == ImageOrder::LSB_FIRST;
        let mut rgb = Vec::with_capacity(usize::from(width) * usize::from(height) * 3);
        for pixel in reply.data.chunks_exact(4) {
            let value = if lsb {
                u32::from_le_bytes(pixel.try_into().map_err(failed)?)
            } else {
                u32::from_be_bytes(pixel.try_into().map_err(failed)?)
            };
            rgb.extend_from_slice(&[(value >> 16) as u8, (value >> 8) as u8, value as u8]);
        }
        let image = image::RgbImage::from_raw(u32::from(width), u32::from(height), rgb)
            .ok_or_else(|| failed("image dimensions"))?;
        let scale = 1280.0 / f64::from(width.max(height));
        let image = if scale < 1.0 {
            image::imageops::resize(
                &image,
                (f64::from(width) * scale).round() as u32,
                (f64::from(height) * scale).round() as u32,
                image::imageops::FilterType::Triangle,
            )
        } else {
            image
        };
        self.connection.stream().arm();
        if self.foreground()? != window || self.unobscured(window)? != (width, height) {
            return Err(ObserverError::new(
                "capture_suppressed",
                "Selected window changed or became obscured during capture",
            ));
        }
        for quality in [80, 60, 40] {
            let mut bytes = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
                .encode_image(&image)
                .map_err(failed)?;
            if bytes.len() <= 500_000 {
                return Ok(ObservedFrame {
                    bytes,
                    width: image.width(),
                    height: image.height(),
                    mime: "image/jpeg".into(),
                });
            }
        }
        Err(ObserverError::new(
            "capture_limit",
            "Selected-window JPEG exceeds capture limit",
        ))
    }
    fn unobscured(&self, window: u32) -> Result<(u16, u16)> {
        use x11rb::protocol::xproto::MapState;
        let geometry = self
            .connection
            .get_geometry(window)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        if geometry.width == 0
            || geometry.height == 0
            || geometry.width > 4096
            || geometry.height > 4096
        {
            return Err(failed("window dimensions"));
        }
        let target = self
            .connection
            .translate_coordinates(window, self.root, 0, 0)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        let mut ancestor = window;
        for _ in 0..8 {
            let tree = self
                .connection
                .query_tree(ancestor)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            if tree.parent == self.root {
                break;
            }
            if tree.parent == 0 {
                return Err(failed("ancestry"));
            }
            ancestor = tree.parent;
        }
        let root = self
            .connection
            .query_tree(self.root)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        if root.children.len() > 128 {
            return Err(ObserverError::new(
                "capture_limit",
                "Too many desktop windows to verify occlusion",
            ));
        }
        let index = root
            .children
            .iter()
            .position(|id| *id == ancestor)
            .ok_or_else(|| failed("ancestry"))?;
        let x = i32::from(target.dst_x);
        let y = i32::from(target.dst_y);
        let right = x + i32::from(geometry.width);
        let bottom = y + i32::from(geometry.height);
        let root_geometry = self
            .connection
            .get_geometry(self.root)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        if x < 0
            || y < 0
            || right > i32::from(root_geometry.width)
            || bottom > i32::from(root_geometry.height)
        {
            return Err(ObserverError::new(
                "capture_suppressed",
                "Selected window is clipped by the display",
            ));
        }
        for other in &root.children[index + 1..] {
            let attributes = self
                .connection
                .get_window_attributes(*other)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            if attributes.map_state != MapState::VIEWABLE {
                continue;
            }
            let bounds = self
                .connection
                .get_geometry(*other)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            let border = i32::from(bounds.border_width);
            let ox = i32::from(bounds.x) - border;
            let oy = i32::from(bounds.y) - border;
            if ox < right
                && ox + i32::from(bounds.width) + 2 * border > x
                && oy < bottom
                && oy + i32::from(bounds.height) + 2 * border > y
            {
                return Err(ObserverError::new(
                    "capture_suppressed",
                    "Another window overlaps the selected capture window",
                ));
            }
        }
        Ok((geometry.width, geometry.height))
    }
    fn process_id(&self, window: u32) -> Option<u32> {
        use x11rb::protocol::res::{ClientIdMask, ClientIdSpec, ConnectionExt as _};
        // XRes obtains the client's PID from the X server. _NET_WM_PID is a
        // client-controlled property and cannot attest process identity.
        self.connection
            .res_query_client_ids(&[ClientIdSpec {
                client: window,
                mask: ClientIdMask::LOCAL_CLIENT_PID,
            }])
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| {
                reply
                    .ids
                    .into_iter()
                    .find(|v| v.spec.mask.contains(ClientIdMask::LOCAL_CLIENT_PID))
                    .and_then(|v| v.value.first().copied())
            })
            .filter(|id| *id != 0)
    }
    /// Privacy check only. X11 may queue input while waiting for replies, but
    /// this method never removes events or advances the public sample baseline.
    pub(super) fn context(&mut self) -> Result<(ForegroundContext, SensitiveInput)> {
        self.connection.stream().arm();
        let window = self.foreground()?;
        let pid = self.process_id(window);
        let (sensitive, _) = sensitivity(pid);
        self.connection.stream().arm();
        if self.foreground()? != window {
            return Err(ObserverError::new(
                "foreground_changed",
                "Foreground changed during native context verification",
            ));
        }
        Ok((
            ForegroundContext {
                app_id: pid
                    .map_or_else(|| format!("x11-window:{window}"), |id| format!("pid:{id}")),
                window_id: format!("x11:{window}"),
                process_id: pid,
            },
            sensitive,
        ))
    }
    pub(super) fn sample(&mut self) -> Result<Observation> {
        self.connection.stream().arm();
        let window = self.foreground()?;
        let pid = self.process_id(window);

        let pointer = self
            .connection
            .query_pointer(self.root)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        if !pointer.same_screen {
            return Err(ObserverError::new(
                "pointer_unavailable",
                "Pointer is outside the observed X11 screen",
            ));
        }
        let mut events = Vec::new();
        let mut focus_transition = false;
        // Bound work and memory even if the desktop floods input. Overflow is an
        // error, never silently represented as a complete observation.
        for count in 0..=256 {
            let Some(event) = self.connection.poll_for_event().map_err(failed)? else {
                break;
            };
            if count == 256 {
                return Err(ObserverError::new(
                    "event_overflow",
                    "Native mouse event queue exceeded the observation bound",
                ));
            }
            let (button, pressed) = match event {
                Event::XinputRawButtonPress(e) => (e.detail, true),
                Event::XinputRawButtonRelease(e) => (e.detail, false),
                Event::PropertyNotify(e) if e.atom == self.active => {
                    focus_transition = true;
                    continue;
                }
                Event::Error(_) => return Err(failed("X11 error")),
                _ => continue,
            };
            match button {
                1..=3 => events.push(ObservedEvent::Button {
                    button: button as u8,
                    pressed,
                }),
                4..=7 if pressed => events.push(ObservedEvent::Scroll {
                    horizontal: match button {
                        6 => -1,
                        7 => 1,
                        _ => 0,
                    },
                    vertical: match button {
                        4 => -1,
                        5 => 1,
                        _ => 0,
                    },
                }),
                _ => {}
            }
        }
        if focus_transition {
            events.clear();
            events.push(ObservedEvent::FocusChanged);
        }
        let (secure_input, accessibility) = sensitivity(pid);
        self.connection.stream().arm();
        if self.foreground()? != window {
            return Err(ObserverError::new(
                "foreground_changed",
                "Foreground changed during native observation",
            ));
        }
        let mask = u16::from(pointer.mask);
        Ok(Observation {
            foreground: ForegroundContext {
                app_id: pid
                    .map_or_else(|| format!("x11-window:{window}"), |id| format!("pid:{id}")),
                window_id: format!("x11:{window}"),
                process_id: pid,
            },
            pointer: PointerSnapshot {
                x: i32::from(pointer.root_x),
                y: i32::from(pointer.root_y),
                buttons: ((mask >> 8) & 7) as u8,
            },
            secure_input,
            accessibility,
            events,
            capabilities: ObserverCapabilities {
                button_events: true,
                scroll_events: true,
                sensitive_input: secure_input != SensitiveInput::Unknown,
            },
        })
    }
}

fn read_private(path: std::path::PathBuf, limit: u64) -> Result<Vec<u8>> {
    use std::{io::Read, os::unix::fs::MetadataExt};
    let metadata = std::fs::symlink_metadata(&path).map_err(failed)?;
    if !metadata.is_file() || metadata.mode() & 0o077 != 0 || metadata.len() > limit {
        return Err(ObserverError::new(
            "invalid_desktop_runtime",
            "Desktop metadata must be a bounded owner-only regular file",
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(failed)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(failed)?;
    if bytes.len() as u64 > limit {
        return Err(failed("metadata limit"));
    }
    Ok(bytes)
}
// Parse the Hand's private Xauthority without changing XAUTHORITY globally or
// logging cookies. Require an exact display or the server's wildcard record.
fn private_auth(bytes: &[u8], display: u16) -> Result<(Vec<u8>, Vec<u8>)> {
    fn field<'a>(bytes: &mut &'a [u8]) -> Option<&'a [u8]> {
        let length = u16::from_be_bytes(bytes.get(..2)?.try_into().ok()?) as usize;
        *bytes = bytes.get(2..)?;
        let value = bytes.get(..length)?;
        *bytes = bytes.get(length..)?;
        Some(value)
    }
    let mut input = bytes;
    while !input.is_empty() {
        let family = u16::from_be_bytes(
            input
                .get(..2)
                .and_then(|v| v.try_into().ok())
                .ok_or_else(|| failed("authority"))?,
        );
        input = &input[2..];
        let _address = field(&mut input).ok_or_else(|| failed("authority"))?;
        let number = field(&mut input).ok_or_else(|| failed("authority"))?;
        let name = field(&mut input).ok_or_else(|| failed("authority"))?;
        let data = field(&mut input).ok_or_else(|| failed("authority"))?;
        if name == b"MIT-MAGIC-COOKIE-1"
            && data.len() == 16
            && (number == display.to_string().as_bytes() || family == 65535 && number.is_empty())
        {
            return Ok((name.to_vec(), data.to_vec()));
        }
    }
    Err(ObserverError::new(
        "invalid_desktop_runtime",
        "Desktop Xauthority has no matching authentication record",
    ))
}

fn sensitivity(pid: Option<u32>) -> (SensitiveInput, Option<AccessibilitySummary>) {
    use std::{
        io::Read,
        process::{Command, Stdio},
    };
    let unknown = || (SensitiveInput::Unknown, None);
    let Some(pid) = pid else { return unknown() };
    // AT-SPI is optional. Interpreter/import/bus/permission/timeout failures all
    // remain Unknown. Embedded fixed script emits only allowlisted constants.
    let Ok(mut child) = Command::new("python3")
        .args(["-I", "-c", include_str!("atspi.py"), &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return unknown();
    };
    let began = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return unknown();
                }
                let mut bytes = Vec::new();
                if child
                    .stdout
                    .take()
                    .is_none_or(|out| out.take(1025).read_to_end(&mut bytes).is_err())
                    || bytes.len() > 1024
                {
                    return unknown();
                }
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                    return unknown();
                };
                return match value["state"].as_str() {
                    Some("sensitive") => (SensitiveInput::Sensitive, None),
                    Some("clear") => (
                        SensitiveInput::Clear,
                        Some(AccessibilitySummary {
                            role: "atspi_control".into(),
                            subrole: None,
                        }),
                    ),
                    _ => unknown(),
                };
            }
            Ok(None) if began.elapsed() < Duration::from_millis(500) => {
                std::thread::sleep(Duration::from_millis(5))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return unknown();
            }
        }
    }
}
