//! Posted input through SendInput: the fallback when no UI Automation pattern
//! does the job, and the only way to type, press keys or hover.
//!
//! SendInput inserts a batch into the input stream atomically, so a chord's
//! modifiers go down and up in the same batch as its key, and nothing the user
//! does lands in between. UIPI drops input bound for a more privileged window
//! without saying so (the call still reports success), which is why the backend
//! checks the target's integrity before it ever gets here.

use crate::codes::{self, Typed, VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT};
use openlive_cu_core::backend::{Button, Direction};
use openlive_cu_core::keys::{Chord, Modifiers};
use openlive_cu_core::{CuError, ErrorCode};
use std::thread::sleep;
use std::time::Duration;
use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetSystemMetrics, HWND_MESSAGE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, WINDOW_EX_STYLE, WINDOW_STYLE,
};

/// Between the parts of a click: the macOS backend's pause, which apps on both systems keep up with.
const PAUSE: Duration = Duration::from_millis(50);
const DRAG_STEPS: u32 = 10;
/// UTF-16 units per batch of typed text, with a breath between batches so a busy app drops nothing.
const TEXT_CHUNK: usize = 16;
/// How long the target app gets to read the clipboard before the user's own content goes back.
const PASTE_SETTLE: Duration = Duration::from_millis(300);
/// Another app may hold the clipboard open for a moment.
const CLIPBOARD_TRIES: u32 = 10;
/// CF_UNICODETEXT.
const CF_UNICODETEXT: u32 = 13;
/// Formats whose data is a GDI handle, not an HGLOBAL, so the bytes cannot be
/// copied; Windows synthesises CF_BITMAP from CF_DIB, which is copied.
const GDI_FORMATS: &[u32] = &[2, 3, 9, 14, 0x80, 0x82, 0x83, 0x8E];

fn send(inputs: &[INPUT]) -> Result<(), CuError> {
    // SAFETY: a slice of fully initialised INPUT structs and their size.
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        return Ok(());
    }
    Err(CuError::internal("Windows did not take the posted input (SendInput refused it)"))
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn key(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

/// A virtual key, down or up, with its scan code (some apps read only that) and the extended flag it needs.
fn vk(code: u16, down: bool) -> INPUT {
    // SAFETY: a pure table lookup.
    let scan = unsafe { MapVirtualKeyW(u32::from(code), MAPVK_VK_TO_VSC) } as u16;
    let mut flags = if down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP };
    if codes::extended(code) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    key(code, scan, flags)
}

/// A move to a desktop pixel, in SendInput's absolute space across every monitor.
fn move_input(at: (f64, f64)) -> INPUT {
    // SAFETY: plain metric reads, physical pixels in a per-monitor-aware process.
    let (x, y, w, h) = unsafe {
        (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN))
    };
    let dx = codes::absolute(at.0.round() as i32, x, w);
    let dy = codes::absolute(at.1.round() as i32, y, h);
    mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dx, dy, 0)
}

fn button_flags(button: Button) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    match button {
        Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

/// The pointer alone. With a button held down it is a drag; Windows tracks the button itself.
pub fn move_to(at: (f64, f64)) -> Result<(), CuError> {
    send(&[move_input(at)])
}

/// Half a click. A press moves there first, so the app sees the pointer arrive.
pub fn press_button(at: (f64, f64), button: Button, down: bool) -> Result<(), CuError> {
    let (press, release) = button_flags(button);
    send(&[move_input(at)])?;
    sleep(PAUSE);
    send(&[mouse(if down { press } else { release }, 0, 0, 0)])
}

/// One move, then a down/up pair per press, close enough together to count as a double click.
pub fn click(at: (f64, f64), button: Button, count: u8) -> Result<(), CuError> {
    let (press, release) = button_flags(button);
    send(&[move_input(at)])?;
    sleep(PAUSE);
    for _ in 0..count {
        send(&[mouse(press, 0, 0, 0)])?;
        sleep(PAUSE);
        send(&[mouse(release, 0, 0, 0)])?;
        sleep(PAUSE);
    }
    Ok(())
}

pub fn drag(from: (f64, f64), to: (f64, f64)) -> Result<(), CuError> {
    let point = |t: f64| (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
    send(&[move_input(from)])?;
    sleep(PAUSE);
    send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)])?;
    sleep(PAUSE);
    let moved = (1..=DRAG_STEPS).try_for_each(|step| {
        sleep(Duration::from_millis(15));
        send(&[move_input(point(f64::from(step) / f64::from(DRAG_STEPS)))])
    });
    // Released even when a move failed: a button left down breaks the user's next click.
    let released = send(&[mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0)]);
    moved.and(released)
}

/// The wheel turns where the pointer is, so the pointer moves there first.
pub fn scroll(at: (f64, f64), direction: Direction, pages: f64) -> Result<(), CuError> {
    let delta = codes::wheel_delta(pages);
    let (flags, data) = match direction {
        Direction::Up => (MOUSEEVENTF_WHEEL, delta),
        Direction::Down => (MOUSEEVENTF_WHEEL, -delta),
        Direction::Left => (MOUSEEVENTF_HWHEEL, -delta),
        Direction::Right => (MOUSEEVENTF_HWHEEL, delta),
    };
    send(&[move_input(at)])?;
    sleep(PAUSE);
    send(&[mouse(flags, 0, 0, data)])
}

/// KEYEVENTF_UNICODE: each UTF-16 unit arrives as itself whatever the keyboard
/// layout, so text needs no key codes and no layout guesswork.
pub fn type_text(text: &str) -> Result<(), CuError> {
    let steps = codes::typed(text);
    for chunk in steps.chunks(TEXT_CHUNK) {
        let inputs: Vec<INPUT> = chunk
            .iter()
            .flat_map(|step| match *step {
                Typed::Unit(u) => [key(0, u, KEYEVENTF_UNICODE), key(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)],
                Typed::Key(code) => [vk(code, true), vk(code, false)],
            })
            .collect();
        send(&inputs)?;
        sleep(Duration::from_millis(8));
    }
    Ok(())
}

/// A chord in one batch: modifiers down, the key down and up, modifiers up.
pub fn press(chord: &Chord) -> Result<(), CuError> {
    let mut m = chord.modifiers;
    let code = match codes::vk(&chord.key) {
        Some(code) => code,
        None => {
            let c = chord.key.encode_utf16().next().filter(|_| chord.key.chars().count() == 1);
            // SAFETY: a lookup on the current keyboard layout.
            let scan = c.map(|c| unsafe { VkKeyScanW(c) }).filter(|s| *s != -1);
            match scan {
                Some(s) => {
                    // The high byte is the shift state the character needs on this layout.
                    m.shift |= s as u16 & 0x100 != 0;
                    m.ctrl |= s as u16 & 0x200 != 0;
                    m.alt |= s as u16 & 0x400 != 0;
                    s as u16 & 0xFF
                }
                // A character no key on this layout makes still types, when nothing is held with it.
                None if !chord.modifiers.any() => return type_text(&chord.key),
                None => return Err(CuError::invalid(format!("'{}' is on no key of this keyboard layout, so it cannot be pressed with modifiers", chord.key))),
            }
        }
    };
    let held: Vec<u16> = [(m.meta, VK_LWIN), (m.ctrl, VK_CONTROL), (m.alt, VK_MENU), (m.shift, VK_SHIFT)]
        .into_iter()
        .filter_map(|(on, code)| on.then_some(code))
        .collect();
    let mut inputs: Vec<INPUT> = held.iter().map(|c| vk(*c, true)).collect();
    inputs.extend([vk(code, true), vk(code, false)]);
    inputs.extend(held.iter().rev().map(|c| vk(*c, false)));
    send(&inputs).inspect_err(|_| {
        // Modifiers always come back up: a stuck control key breaks the user's next keystroke.
        let _ = send(&held.iter().rev().map(|c| vk(*c, false)).collect::<Vec<_>>());
    })
}

// ── the clipboard ───────────────────────────────────────────────────────────

/// A window to own the clipboard: with no owner, SetClipboardData after
/// EmptyClipboard fails, as the documentation for OpenClipboard warns.
struct Owner(HWND);

impl Owner {
    fn new() -> Result<Self, CuError> {
        // SAFETY: a message-only STATIC window, destroyed on drop on this same thread.
        unsafe { CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), None, WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, None, None) }
            .map(Owner)
            .map_err(|e| CuError::internal(format!("no window to own the clipboard: {}", e.message())))
    }

    fn open(&self) -> Result<Opened, CuError> {
        for _ in 0..CLIPBOARD_TRIES {
            // SAFETY: opened for this owner; closed when `Opened` drops.
            if unsafe { OpenClipboard(Some(self.0)) }.is_ok() {
                return Ok(Opened);
            }
            sleep(Duration::from_millis(20));
        }
        Err(CuError::new(ErrorCode::Internal, "another app is holding the clipboard; try again in a moment"))
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        // SAFETY: created by this thread in `new`.
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

struct Opened;

impl Drop for Opened {
    fn drop(&mut self) {
        // SAFETY: the clipboard was opened by `Owner::open`.
        let _ = unsafe { CloseClipboard() };
    }
}

/// A copy of everything on the clipboard that is plain memory, by format.
fn save(_open: &Opened) -> Vec<(u32, Vec<u8>)> {
    let mut saved = Vec::new();
    // SAFETY: the clipboard is open; each handle is locked, copied and unlocked before the next.
    unsafe {
        let mut format = EnumClipboardFormats(0);
        while format != 0 {
            if !GDI_FORMATS.contains(&format) {
                if let Ok(handle) = GetClipboardData(format) {
                    let memory = HGLOBAL(handle.0);
                    let size = GlobalSize(memory);
                    let data = GlobalLock(memory);
                    if !data.is_null() {
                        saved.push((format, std::slice::from_raw_parts(data as *const u8, size).to_vec()));
                        let _ = GlobalUnlock(memory);
                    }
                }
            }
            format = EnumClipboardFormats(format);
        }
    }
    saved
}

/// Put `bytes` on the open clipboard under `format`. The system owns the memory once it is set.
fn put(_open: &Opened, format: u32, bytes: &[u8]) -> Result<(), CuError> {
    // SAFETY: a fresh moveable block filled within its size; freed here only if the clipboard refuses it.
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).map_err(|e| CuError::internal(e.message()))?;
        let data = GlobalLock(memory);
        if data.is_null() {
            let _ = GlobalFree(Some(memory));
            return Err(CuError::internal("could not lock clipboard memory"));
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), data as *mut u8, bytes.len());
        let _ = GlobalUnlock(memory);
        SetClipboardData(format, Some(HANDLE(memory.0))).map(|_| ()).map_err(|e| {
            let _ = GlobalFree(Some(memory));
            CuError::internal(format!("could not put the text on the clipboard: {}", e.message()))
        })
    }
}

/// Put `text` on the clipboard, press ctrl+v, and put the user's clipboard
/// back, unless something else wrote to it in the meantime. The text is marked
/// to stay out of clipboard history and the cloud clipboard, the formats
/// Windows documents for content that is only passing through.
pub fn paste(text: &str) -> Result<(), CuError> {
    let owner = Owner::new()?;
    let (saved, ours) = {
        let open = owner.open()?;
        let saved = save(&open);
        // SAFETY: the clipboard is open by this owner.
        unsafe { EmptyClipboard() }.map_err(|e| CuError::internal(e.message()))?;
        let units: Vec<u8> = text.encode_utf16().chain(std::iter::once(0)).flat_map(u16::to_le_bytes).collect();
        put(&open, CF_UNICODETEXT, &units)?;
        for name in [w!("CanIncludeInClipboardHistory"), w!("CanUploadToCloudClipboard")] {
            // SAFETY: registering a named format is idempotent.
            let format = unsafe { RegisterClipboardFormatW(name) };
            if format != 0 {
                let _ = put(&open, format, &0u32.to_le_bytes());
            }
        }
        drop(open);
        // SAFETY: a plain read.
        (saved, unsafe { GetClipboardSequenceNumber() })
    };
    let pressed = press(&Chord { modifiers: Modifiers { ctrl: true, ..Default::default() }, key: "v".into() });
    sleep(PASTE_SETTLE);
    // SAFETY: a plain read.
    if unsafe { GetClipboardSequenceNumber() } == ours {
        if let Ok(open) = owner.open() {
            // SAFETY: the clipboard is open by this owner.
            let _ = unsafe { EmptyClipboard() };
            for (format, bytes) in &saved {
                let _ = put(&open, *format, bytes);
            }
        }
    }
    pressed
}
