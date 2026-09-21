//! macOS primitives: synthetic keystrokes, keyboard-layout lookup, and the
//! permission probes. Everything Carbon lives behind the externs at the top.

use std::ffi::c_void;
use std::os::raw::c_char;
use std::ptr;
use std::sync::OnceLock;
use std::time::Duration;

use handy_keys::{Key, Modifiers};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_core_graphics::{
    CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
    CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess,
};

pub type EventHotKeyRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct EventHotKeyID {
    pub signature: u32,
    pub id: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct EventTypeSpec {
    pub event_class: u32,
    pub event_kind: u32,
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut c_void;
    fn TISGetInputSourceProperty(source: *mut c_void, key: *const c_void) -> *mut c_void;
    static kTISPropertyUnicodeKeyLayoutData: *const c_void;
    fn LMGetKbdType() -> u8;
    #[allow(clippy::too_many_arguments)]
    fn UCKeyTranslate(
        layout: *const u8,
        virtual_key: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        options: u32,
        dead_key_state: *mut u32,
        max_length: usize,
        actual_length: *mut usize,
        unicode_string: *mut u16,
    ) -> i32;
    fn IsSecureEventInputEnabled() -> bool;

    pub fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        hotkey_id: EventHotKeyID,
        target: *mut c_void,
        options: u32,
        out: *mut EventHotKeyRef,
    ) -> i32;
    pub fn UnregisterEventHotKey(hotkey: EventHotKeyRef) -> i32;
    pub fn GetApplicationEventTarget() -> *mut c_void;
    pub fn InstallEventHandler(
        target: *mut c_void,
        handler: extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32,
        num_types: u32,
        types: *const EventTypeSpec,
        user_data: *mut c_void,
        out: *mut *mut c_void,
    ) -> i32;
    pub fn GetEventParameter(
        event: *mut c_void,
        name: u32,
        kind: u32,
        out_actual_type: *mut u32,
        buffer_size: usize,
        out_actual_size: *mut usize,
        data: *mut c_void,
    ) -> i32;
    pub fn GetEventKind(event: *mut c_void) -> u32;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
    fn CFRelease(cf: *const c_void);
    fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        num: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> *const c_void;
    fn CFStringCreateWithCString(
        allocator: *const c_void,
        cstr: *const c_char,
        encoding: u32,
    ) -> *const c_void;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    static kCFBooleanTrue: *const c_void;
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

pub const K_EVENT_CLASS_KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
pub const K_EVENT_HOTKEY_PRESSED: u32 = 5;
pub const K_EVENT_HOTKEY_RELEASED: u32 = 6;
pub const K_EVENT_PARAM_DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");
pub const K_EVENT_PARAM_TYPE_HOTKEY_ID: u32 = u32::from_be_bytes(*b"hkid");
pub const K_HOTKEY_NO_OPTIONS: u32 = 0;

/// Carbon modifier masks, which are the EventRecord bits, not the CG flags.
pub fn carbon_modifiers(modifiers: Modifiers) -> u32 {
    const CMD: u32 = 1 << 8;
    const SHIFT: u32 = 1 << 9;
    const OPTION: u32 = 1 << 11;
    const CONTROL: u32 = 1 << 12;
    let mut out = 0;
    for (group, mask) in [
        (Modifiers::CMD, CMD),
        (Modifiers::SHIFT, SHIFT),
        (Modifiers::OPT, OPTION),
        (Modifiers::CTRL, CONTROL),
    ] {
        if modifiers.intersects(group) {
            out |= mask;
        }
    }
    out
}

/// ANSI virtual keycodes. Carbon hotkey registration needs a keycode, and a
/// key missing from this table simply cannot be shadow-registered.
pub fn virtual_keycode(key: Key) -> Option<u16> {
    use Key::*;
    Some(match key {
        A => 0, S => 1, D => 2, F => 3, H => 4, G => 5, Z => 6, X => 7, C => 8, V => 9,
        B => 11, Q => 12, W => 13, E => 14, R => 15, Y => 16, T => 17,
        Num1 => 18, Num2 => 19, Num3 => 20, Num4 => 21, Num6 => 22, Num5 => 23,
        Equal => 24, Num9 => 25, Num7 => 26, Minus => 27, Num8 => 28, Num0 => 29,
        RightBracket => 30, O => 31, U => 32, LeftBracket => 33, I => 34, P => 35,
        Return => 36, L => 37, J => 38, Quote => 39, K => 40, Semicolon => 41,
        Backslash => 42, Comma => 43, Slash => 44, N => 45, M => 46, Period => 47,
        Tab => 48, Space => 49, Grave => 50, Delete => 51, Escape => 53,
        F17 => 64, F18 => 79, F19 => 80, F20 => 90,
        F5 => 96, F6 => 97, F7 => 98, F3 => 99, F8 => 100, F9 => 101, F11 => 103,
        F13 => 105, F16 => 106, F14 => 107, F10 => 109, F12 => 111, F15 => 113,
        Home => 115, PageUp => 116, ForwardDelete => 117, F4 => 118, End => 119,
        F2 => 120, PageDown => 121, F1 => 122,
        LeftArrow => 123, RightArrow => 124, DownArrow => 125, UpArrow => 126,
        _ => return None,
    })
}

/// The keycode that produces "v" on the layout the user is actually typing on.
/// Dvorak and non-Latin layouts move it, so it is resolved at paste time. Must
/// run on the main thread: TIS reads per-process main-thread state.
pub fn resolve_paste_keycode() -> Option<u16> {
    const COMMAND_MODIFIER_STATE: u32 = 1;
    const KEY_ACTION_DOWN: u16 = 0;
    const NO_DEAD_KEYS: u32 = 1;

    unsafe {
        let source = TISCopyCurrentKeyboardLayoutInputSource();
        if source.is_null() {
            return None;
        }
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
        if data.is_null() {
            CFRelease(source.cast());
            return None;
        }
        let layout = CFDataGetBytePtr(data.cast());
        let keyboard_type = LMGetKbdType() as u32;
        let mut found = None;
        for keycode in 0u16..128 {
            let mut dead_state = 0u32;
            let mut length = 0usize;
            let mut chars = [0u16; 4];
            let status = UCKeyTranslate(
                layout,
                keycode,
                KEY_ACTION_DOWN,
                COMMAND_MODIFIER_STATE,
                keyboard_type,
                NO_DEAD_KEYS,
                &mut dead_state,
                chars.len(),
                &mut length,
                chars.as_mut_ptr(),
            );
            if status == 0 && length == 1 && chars[0] == u16::from(b'v') {
                found = Some(keycode);
                break;
            }
        }
        CFRelease(source.cast());
        found
    }
}

fn event_source() -> Option<objc2_core_foundation::CFRetained<CGEventSource>> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
}

/// Some apps poll global keyboard state instead of reading the event's own
/// flags, so the modifier is physically down across the whole chord.
pub fn send_chord(keycode: u16, flags: CGEventFlags, modifier_keycodes: &[u16]) -> Result<(), String> {
    let source = event_source();
    let source = source.as_deref();
    let post = |code: u16, down: bool, flags: CGEventFlags| -> Result<(), String> {
        let event = CGEvent::new_keyboard_event(source, code, down)
            .ok_or_else(|| "could not create a keyboard event".to_string())?;
        CGEvent::set_flags(Some(&event), flags);
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        Ok(())
    };

    for code in modifier_keycodes {
        post(*code, true, flags)?;
    }
    std::thread::sleep(Duration::from_millis(50));
    post(keycode, true, flags)?;
    post(keycode, false, flags)?;
    std::thread::sleep(Duration::from_millis(50));
    for code in modifier_keycodes.iter().rev() {
        post(*code, false, CGEventFlags::empty())?;
    }
    Ok(())
}

pub fn send_paste_chord(keycode: u16) -> Result<(), String> {
    const LEFT_COMMAND: u16 = 55;
    send_chord(keycode, CGEventFlags::MaskCommand, &[LEFT_COMMAND])
}

pub fn type_text(text: &str) -> Result<(), String> {
    let source = event_source();
    let source = source.as_deref();
    // 20 UTF-16 units per event keeps each keystroke well under the buffer
    // limit that CGEventKeyboardSetUnicodeString silently truncates at.
    for chunk in text.chars().collect::<Vec<_>>().chunks(20) {
        let utf16: Vec<u16> = chunk.iter().collect::<String>().encode_utf16().collect();
        for down in [true, false] {
            let event = CGEvent::new_keyboard_event(source, 0, down)
                .ok_or_else(|| "could not create a keyboard event".to_string())?;
            unsafe {
                CGEvent::keyboard_set_unicode_string(
                    Some(&event),
                    utf16.len() as u64,
                    utf16.as_ptr(),
                );
            }
            CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}

pub fn accessibility_ok() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Shows the system prompt once. macOS never calls back, so the caller polls.
pub fn request_accessibility() -> bool {
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    unsafe {
        let key = CFStringCreateWithCString(
            ptr::null(),
            c"AXTrustedCheckOptionPrompt".as_ptr(),
            K_CF_STRING_ENCODING_UTF8,
        );
        if key.is_null() {
            return AXIsProcessTrusted();
        }
        let options = CFDictionaryCreate(
            ptr::null(),
            &key,
            &kCFBooleanTrue,
            1,
            &kCFTypeDictionaryKeyCallBacks as *const _,
            &kCFTypeDictionaryValueCallBacks as *const _,
        );
        let trusted = AXIsProcessTrustedWithOptions(options);
        CFRelease(key);
        if !options.is_null() {
            CFRelease(options);
        }
        trusted
    }
}

fn media_type_audio() -> *mut AnyObject {
    static AUDIO: OnceLock<usize> = OnceLock::new();
    let ptr = *AUDIO.get_or_init(|| unsafe {
        let string: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c"soun".as_ptr()];
        let retained: *mut AnyObject = msg_send![string, retain];
        retained as usize
    });
    ptr as *mut AnyObject
}

/// 0 not determined, 1 restricted, 2 denied, 3 authorized.
pub fn microphone_status() -> i32 {
    unsafe { msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: media_type_audio()] }
}

/// A null completion handler is deliberate: macOS decides when to call back
/// and the caller polls the status instead.
pub fn request_microphone() {
    unsafe {
        let _: () = msg_send![
            class!(AVCaptureDevice),
            requestAccessForMediaType: media_type_audio(),
            completionHandler: ptr::null_mut::<c_void>(),
        ];
    }
}

pub fn screen_recording_ok() -> bool {
    CGPreflightScreenCaptureAccess()
}

pub fn request_screen_recording() -> bool {
    CGRequestScreenCaptureAccess()
}

pub fn secure_input_active() -> bool {
    unsafe { IsSecureEventInputEnabled() }
}

/// Best effort: the frontmost app is the usual culprit for secure input, but
/// the OS exposes no way to name the process that actually enabled it.
pub fn frontmost_app_name() -> Option<String> {
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return None;
        }
        let name: *mut AnyObject = msg_send![app, localizedName];
        if name.is_null() {
            return None;
        }
        let utf8: *const c_char = msg_send![name, UTF8String];
        if utf8.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }
}
