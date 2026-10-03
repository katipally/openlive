//! Windows synthetic input. SendInput is the whole surface; there is no
//! Accessibility gate to probe.

use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL,
};

pub(crate) fn key_input(
    vk: u16,
    scan: u16,
    flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS,
) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub(crate) fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("SendInput was blocked, most likely by UIPI or a secure desktop".into())
    }
}

/// A press and release of an unassigned key while Alt or Win is held, so its
/// release no longer reads as a lone tap: alone, releasing Alt focuses the
/// app's menu bar and releasing Win opens Start. The key and the marker are
/// handy-keys' own menu mask (0xE8, "HKMM"), which its hook passes through
/// untouched. A failure only costs the menu opening.
pub fn mask_menu() {
    let mask = |flags| {
        let mut input = key_input(0xE8, 0, flags);
        input.Anonymous.ki.dwExtraInfo = 0x484B_4D4D;
        input
    };
    let _ = send(&[mask(Default::default()), mask(KEYEVENTF_KEYUP)]);
}

/// The low byte of VkKeyScanW is the virtual key for "v" on the active layout.
fn paste_virtual_key() -> u16 {
    let scan = unsafe { VkKeyScanW(u16::from(b'v')) };
    if scan == -1 {
        0x56
    } else {
        (scan as u16) & 0xFF
    }
}

/// Ctrl stays physically down across the chord, because some apps read global
/// keyboard state rather than the event's own flags.
pub fn send_paste_chord(hold: Duration) -> Result<(), String> {
    let v = paste_virtual_key();
    send(&[key_input(VK_CONTROL.0, 0, Default::default())])?;
    std::thread::sleep(hold);
    send(&[
        key_input(v, 0, Default::default()),
        key_input(v, 0, KEYEVENTF_KEYUP),
    ])?;
    std::thread::sleep(hold);
    send(&[key_input(VK_CONTROL.0, 0, KEYEVENTF_KEYUP)])
}

pub fn type_text(text: &str) -> Result<(), String> {
    let inputs: Vec<INPUT> = text
        .encode_utf16()
        .flat_map(|unit| {
            [
                key_input(0, unit, KEYEVENTF_UNICODE),
                key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            ]
        })
        .collect();
    for batch in inputs.chunks(64) {
        send(batch)?;
    }
    Ok(())
}

pub fn accessibility_ok() -> bool {
    true
}

pub fn request_accessibility() -> bool {
    true
}

/// Windows has no per-process grant for synthetic input. What it does have is
/// UIPI, which drops input sent to a more privileged window; that is a fact
/// about the window in front, and `guard_injection` reads it there.
pub fn post_events_ok() -> bool {
    true
}

pub fn request_post_events() -> bool {
    true
}

/// Windows gates the microphone at capture time through its privacy settings
/// and exposes no synchronous probe, so the capture attempt is the probe.
pub fn microphone_status() -> isize {
    3
}

pub fn request_microphone() {}

pub fn screen_recording_ok() -> bool {
    true
}

pub fn request_screen_recording() -> bool {
    true
}

/// Windows exposes this only through per-application capture state in the
/// registry, which is stale often enough to be wrong. `None` rather than a
/// guess: a wrong answer here silences the user's assistant.
pub fn microphone_in_use() -> Option<bool> {
    None
}

/// Whether Right Alt is AltGr on the layout of the window in front: some
/// character on it needs Ctrl+Alt. Layouts are per thread, so it is the
/// foreground window's that counts. O(characters scanned) once per layout, then a lookup.
pub fn right_alt_is_altgr() -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardLayout, VkKeyScanExW};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    static LAYOUTS: OnceLock<Mutex<HashMap<usize, bool>>> = OnceLock::new();
    // VkKeyScanExW's high byte is the shift state a character needs: 2 Ctrl, 4 Alt.
    const CTRL_ALT: i16 = 6;
    let hkl = unsafe { GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), None)) };
    let mut layouts = LAYOUTS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    *layouts.entry(hkl.0 as usize).or_insert_with(|| {
        // Printable Latin through Latin Extended-B, and the euro sign, which
        // between them cover what AltGr types on every European layout.
        (0x21u16..0x250).chain([0x20AC]).any(|ch| {
            let scan = unsafe { VkKeyScanExW(ch, hkl) };
            scan != -1 && (scan >> 8) & CTRL_ALT == CTRL_ALT
        })
    })
}

pub fn secure_input_active() -> bool {
    false
}

pub fn frontmost_app_name() -> Option<String> {
    None
}
