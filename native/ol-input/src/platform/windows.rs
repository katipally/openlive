//! Windows synthetic input. SendInput is the whole surface; there is no
//! Accessibility gate to probe.

use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL,
};

pub(crate) fn key_input(vk: u16, scan: u16, flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS) -> INPUT {
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
pub fn send_paste_chord() -> Result<(), String> {
    let v = paste_virtual_key();
    send(&[key_input(VK_CONTROL.0, 0, Default::default())])?;
    std::thread::sleep(Duration::from_millis(50));
    send(&[
        key_input(v, 0, Default::default()),
        key_input(v, 0, KEYEVENTF_KEYUP),
    ])?;
    std::thread::sleep(Duration::from_millis(50));
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

pub fn secure_input_active() -> bool {
    false
}

pub fn frontmost_app_name() -> Option<String> {
    None
}
