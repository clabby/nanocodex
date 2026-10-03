//! Foreground HWND and read-only native edit-control password metadata.
#![allow(unsafe_code)]
use super::*;
use windows_sys::Win32::{
    Foundation::POINT,
    UI::{
        Input::KeyboardAndMouse::GetAsyncKeyState,
        WindowsAndMessaging::{
            GUITHREADINFO, GWL_STYLE, GetClassNameW, GetCursorPos, GetForegroundWindow,
            GetGUIThreadInfo, GetWindowLongW, GetWindowThreadProcessId, SMTO_ABORTIFHUNG,
            SMTO_BLOCK, SendMessageTimeoutW,
        },
    },
};
pub(super) struct Observer;
impl Observer {
    pub(super) fn new() -> Result<Self> {
        Ok(Self)
    }
    pub(super) fn native_button_events(&self) -> bool {
        false
    }
    pub(super) fn sample(&mut self) -> Result<Observation> {
        // SAFETY: all pointers are stack-owned output buffers, handles are
        // obtained from the OS, and no input/keyboard messages are sent.
        unsafe {
            let window = GetForegroundWindow();
            if window.is_null() {
                return Err(ObserverError::new(
                    "foreground_unavailable",
                    "Windows foreground window unavailable (possibly secure desktop)",
                ));
            }
            let mut pid = 0;
            let thread = GetWindowThreadProcessId(window, &mut pid);
            if thread == 0 || pid == 0 {
                return Err(ObserverError::new(
                    "foreground_unavailable",
                    "Windows foreground process unavailable",
                ));
            }
            let mut point = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut point) == 0 {
                return Err(ObserverError::new(
                    "pointer_unavailable",
                    "Windows pointer unavailable (possibly secure desktop)",
                ));
            }
            let mut buttons = 0;
            // Only mouse virtual keys. No key enumeration or key history.
            for (bit, key) in [(0, 1), (1, 4), (2, 2)] {
                if GetAsyncKeyState(key) < 0 {
                    buttons |= 1 << bit;
                }
            }
            let mut info: GUITHREADINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
            let mut secure_input = SensitiveInput::Unknown;
            let mut accessibility = None;
            if GetGUIThreadInfo(thread, &mut info) != 0 && !info.hwndFocus.is_null() {
                let mut class = [0u16; 128];
                let len = GetClassNameW(info.hwndFocus, class.as_mut_ptr(), class.len() as i32);
                if len > 0 {
                    let class = String::from_utf16_lossy(&class[..len as usize]);
                    // ES_PASSWORD is meaningful only on native edit controls;
                    // custom browser/UIA controls must remain Unknown.
                    if class.eq_ignore_ascii_case("Edit")
                        || class.eq_ignore_ascii_case("RichEdit20W")
                        || class.eq_ignore_ascii_case("RichEdit50W")
                    {
                        let style = GetWindowLongW(info.hwndFocus, GWL_STYLE);
                        let mut password_char = 0;
                        // EM_GETPASSWORDCHAR (0xD2) reads the masking glyph only,
                        // never text. Timeout prevents a hung application stall.
                        let response = SendMessageTimeoutW(
                            info.hwndFocus,
                            0xD2,
                            0,
                            0,
                            SMTO_ABORTIFHUNG | SMTO_BLOCK,
                            100,
                            &mut password_char,
                        );
                        secure_input = if style & 0x20 != 0 || (response != 0 && password_char != 0)
                        {
                            SensitiveInput::Sensitive
                        } else if response != 0 {
                            SensitiveInput::Clear
                        } else {
                            SensitiveInput::Unknown
                        };
                        accessibility = Some(AccessibilitySummary {
                            role: "native_edit".to_owned(),
                            subrole: None,
                        });
                    }
                }
            }
            if GetForegroundWindow() != window {
                return Err(ObserverError::new(
                    "foreground_changed",
                    "Foreground changed during native observation",
                ));
            }
            Ok(Observation {
                foreground: ForegroundContext {
                    app_id: format!("pid:{pid}"),
                    window_id: format!("hwnd:{:x}", window as usize),
                    process_id: Some(pid),
                },
                pointer: PointerSnapshot {
                    x: point.x,
                    y: point.y,
                    buttons,
                },
                secure_input,
                accessibility,
                events: Vec::new(),
                capabilities: ObserverCapabilities {
                    button_events: true,
                    scroll_events: false,
                    sensitive_input: true,
                },
            })
        }
    }
}
