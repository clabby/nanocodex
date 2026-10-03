//! Permission-preserving AX metadata. Native AX text values and labels are never read.
#![allow(unsafe_code)]
use super::*;
use std::{
    ffi::{c_char, c_void},
    ptr,
};
type Ref = *const c_void;
#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    origin: Point,
    size: Size,
}
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateSystemWide() -> Ref;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementCopyAttributeValue(element: Ref, name: Ref, value: *mut Ref) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Ref, seconds: f32) -> i32;
    fn AXUIElementGetPid(element: Ref, pid: *mut i32) -> i32;
    fn AXValueGetTypeID() -> usize;
    fn AXValueGetValue(value: Ref, kind: u32, output: *mut c_void) -> bool;
    fn CGWindowListCopyWindowInfo(options: u32, relative_to: u32) -> Ref;
    fn CGRectMakeWithDictionaryRepresentation(dictionary: Ref, rect: *mut Rect) -> bool;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    fn CGEventCreate(source: Ref) -> Ref;
    fn CGEventGetLocation(event: Ref) -> Point;
}
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn IsSecureEventInputEnabled() -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Ref);
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithCString(allocator: Ref, string: *const c_char, encoding: u32) -> Ref;
    fn CFStringGetCString(string: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
    fn CFEqual(a: Ref, b: Ref) -> bool;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(number: Ref, kind: isize, output: *mut c_void) -> bool;
}
struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}
fn attribute(element: Ref, name: &'static std::ffi::CStr) -> Option<Owned> {
    // SAFETY: attributes are fixed null-terminated literals; successful Copy
    // returns a retained CF object which Owned releases exactly once.
    unsafe {
        let key = Owned(CFStringCreateWithCString(
            ptr::null(),
            name.as_ptr(),
            0x08000100,
        ));
        if key.0.is_null() {
            return None;
        }
        let mut result = ptr::null();
        if AXUIElementCopyAttributeValue(element, key.0, &mut result) == 0 && !result.is_null() {
            Some(Owned(result))
        } else {
            None
        }
    }
}
fn element_attribute(element: Ref, name: &'static std::ffi::CStr) -> Option<Owned> {
    let result = attribute(element, name)?;
    if unsafe { CFGetTypeID(result.0) == AXUIElementGetTypeID() } {
        Some(result)
    } else {
        None
    }
}
fn role(element: Ref, name: &'static std::ffi::CStr) -> Option<String> {
    let result = attribute(element, name)?;
    let mut bytes = [0u8; 128];
    unsafe {
        if CFGetTypeID(result.0) != CFStringGetTypeID()
            || !CFStringGetCString(
                result.0,
                bytes.as_mut_ptr().cast(),
                bytes.len() as isize,
                0x08000100,
            )
        {
            return None;
        }
    }
    let end = bytes.iter().position(|b| *b == 0)?;
    let value = std::str::from_utf8(&bytes[..end]).ok()?;
    // Emit only known role constants. A custom app cannot smuggle content into
    // the recording by returning an arbitrary role/subrole string.
    match value {
        "AXSecureTextField" | "AXTextField" | "AXTextArea" | "AXButton" | "AXCheckBox"
        | "AXRadioButton" | "AXPopUpButton" | "AXSlider" | "AXStaticText" | "AXWindow"
        | "AXStandardWindow" | "AXUnknown" => Some(value.to_owned()),
        _ => None,
    }
}
// Match the AX focused window to a public WindowServer ID, never a local
// counter. Separate sources()/recording observers then agree on window scope.
// Numeric PID/bounds/ID only: optional window names are never extracted.
fn stable_window_id(pid: i32, window: Ref) -> Option<u32> {
    fn value(dictionary: Ref, name: &'static std::ffi::CStr) -> Option<Ref> {
        unsafe {
            if dictionary.is_null() || CFGetTypeID(dictionary) != CFDictionaryGetTypeID() {
                return None;
            }
            let key = Owned(CFStringCreateWithCString(
                ptr::null(),
                name.as_ptr(),
                0x08000100,
            ));
            if key.0.is_null() {
                return None;
            }
            let value = CFDictionaryGetValue(dictionary, key.0);
            if value.is_null() { None } else { Some(value) }
        }
    }
    fn number(dictionary: Ref, name: &'static std::ffi::CStr) -> Option<i64> {
        let value = value(dictionary, name)?;
        let mut result = 0i64;
        unsafe {
            if CFGetTypeID(value) != CFNumberGetTypeID()
                || !CFNumberGetValue(value, 4, (&mut result as *mut i64).cast())
            {
                return None;
            }
        }
        Some(result)
    }
    let position = attribute(window, c"AXPosition")?;
    let dimensions = attribute(window, c"AXSize")?;
    let mut point = Point { x: 0.0, y: 0.0 };
    let mut size = Size {
        width: 0.0,
        height: 0.0,
    };
    // SAFETY: CF/AX types are checked before decoding; the C-layout buffers
    // match kAXValueCGPointType=1 and kAXValueCGSizeType=2 on macOS.
    unsafe {
        if CFGetTypeID(position.0) != AXValueGetTypeID()
            || CFGetTypeID(dimensions.0) != AXValueGetTypeID()
            || !AXValueGetValue(position.0, 1, (&mut point as *mut Point).cast())
            || !AXValueGetValue(dimensions.0, 2, (&mut size as *mut Size).cast())
        {
            return None;
        }
    }
    if ![point.x, point.y, size.width, size.height]
        .iter()
        .all(|v| v.is_finite())
        || size.width <= 0.0
        || size.height <= 0.0
    {
        return None;
    }
    // On-screen windows excluding desktop elements. The retained array owns
    // dictionaries and their values throughout this bounded scan.
    let windows = Owned(unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) });
    if windows.0.is_null() || unsafe { CFGetTypeID(windows.0) != CFArrayGetTypeID() } {
        return None;
    }
    let count = unsafe { CFArrayGetCount(windows.0) };
    if !(1..=256).contains(&count) {
        return None;
    }
    let mut found = None;
    for index in 0..count {
        let dictionary = unsafe { CFArrayGetValueAtIndex(windows.0, index) };
        if number(dictionary, c"kCGWindowOwnerPID") != Some(i64::from(pid)) {
            continue;
        }
        let bounds = value(dictionary, c"kCGWindowBounds")?;
        if unsafe { CFGetTypeID(bounds) != CFDictionaryGetTypeID() } {
            return None;
        }
        let mut rect = Rect {
            origin: Point { x: 0.0, y: 0.0 },
            size: Size {
                width: 0.0,
                height: 0.0,
            },
        };
        if !unsafe { CGRectMakeWithDictionaryRepresentation(bounds, &mut rect) } {
            return None;
        }
        // Both APIs use top-left global screen points; exact bounds prevent
        // guessing among another document, a sheet, or an overlapping window.
        if rect.origin.x == point.x
            && rect.origin.y == point.y
            && rect.size.width == size.width
            && rect.size.height == size.height
        {
            let id = number(dictionary, c"kCGWindowNumber")
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v != 0)?;
            if found.is_some() {
                return None;
            }
            found = Some(id);
        }
    }
    found
}

pub(super) struct Observer {
    system: Owned,
}
impl Observer {
    pub(super) fn new() -> Result<Self> {
        // This query does not display a permission prompt.
        if !unsafe { AXIsProcessTrusted() } {
            return Err(ObserverError::new(
                "permission_denied",
                "macOS Accessibility permission is required for foreground observation",
            ));
        }
        let system = Owned(unsafe { AXUIElementCreateSystemWide() });
        if system.0.is_null() {
            return Err(ObserverError::new(
                "native_observation_failed",
                "Cannot create system accessibility element",
            ));
        }
        if unsafe { AXUIElementSetMessagingTimeout(system.0, 0.1) } != 0 {
            return Err(ObserverError::new(
                "native_observation_failed",
                "Cannot bound accessibility messaging",
            ));
        }
        Ok(Self { system })
    }
    pub(super) fn native_button_events(&self) -> bool {
        false
    }
    pub(super) fn sample(&mut self) -> Result<Observation> {
        let failure = || {
            ObserverError::new(
                "foreground_unavailable",
                "macOS foreground accessibility context is unavailable",
            )
        };
        let app = element_attribute(self.system.0, c"AXFocusedApplication").ok_or_else(failure)?;
        let mut pid = 0;
        if unsafe { AXUIElementGetPid(app.0, &mut pid) } != 0 || pid <= 0 {
            return Err(failure());
        }
        let window = element_attribute(app.0, c"AXFocusedWindow").ok_or_else(failure)?;
        let window_id = stable_window_id(pid, window.0).ok_or_else(|| {
            ObserverError::new(
                "window_identity_unavailable",
                "Cannot uniquely match the focused AX window to a stable native window ID",
            )
        })?;
        let field = element_attribute(app.0, c"AXFocusedUIElement");
        let field_role = field.as_ref().and_then(|f| role(f.0, c"AXRole"));
        let subrole = field.as_ref().and_then(|f| role(f.0, c"AXSubrole"));
        let secure_input = if unsafe { IsSecureEventInputEnabled() }
            || subrole.as_deref() == Some("AXSecureTextField")
        {
            SensitiveInput::Sensitive
        } else {
            // Custom, browser and unrecognized controls remain unknown. Text
            // fields need a reported subrole to distinguish secure controls.
            match field_role.as_deref() {
                Some(
                    "AXButton" | "AXCheckBox" | "AXRadioButton" | "AXPopUpButton" | "AXSlider",
                ) => SensitiveInput::Clear,
                Some("AXTextField" | "AXTextArea")
                    if subrole.is_some() && subrole.as_deref() != Some("AXUnknown") =>
                {
                    SensitiveInput::Clear
                }
                _ => SensitiveInput::Unknown,
            }
        };
        let event = Owned(unsafe { CGEventCreate(ptr::null()) });
        if event.0.is_null() {
            return Err(ObserverError::new(
                "pointer_unavailable",
                "macOS pointer position unavailable",
            ));
        }
        let position = unsafe { CGEventGetLocation(event.0) };
        let mut buttons = 0;
        for (bit, native) in [(0, 0), (1, 2), (2, 1)] {
            if unsafe { CGEventSourceButtonState(0, native) } {
                buttons |= 1 << bit;
            }
        }
        let current_app =
            element_attribute(self.system.0, c"AXFocusedApplication").ok_or_else(failure)?;
        let current_window =
            element_attribute(current_app.0, c"AXFocusedWindow").ok_or_else(failure)?;
        if !unsafe { CFEqual(app.0, current_app.0) && CFEqual(window.0, current_window.0) } {
            return Err(ObserverError::new(
                "foreground_changed",
                "Foreground changed during native observation",
            ));
        }
        Ok(Observation {
            foreground: ForegroundContext {
                app_id: format!("pid:{pid}"),
                window_id: format!("ax:{pid}:{window_id}"),
                process_id: Some(pid as u32),
            },
            pointer: PointerSnapshot {
                x: position.x.round() as i32,
                y: position.y.round() as i32,
                buttons,
            },
            secure_input,
            accessibility: field_role.map(|role| AccessibilitySummary { role, subrole }),
            events: Vec::new(),
            capabilities: ObserverCapabilities {
                button_events: true,
                scroll_events: false,
                sensitive_input: true,
            },
        })
    }
}
