//! Posted input: the fallback when no accessibility action does the job.
//!
//! Mouse events go to the HID event tap, not to a pid: pid-targeted mouse
//! events reach the app without a window, so AppKit never routes the press to
//! a view. The window server also drops a mouse-up posted back to back with
//! its mouse-down, hence the pauses. (Both learned by Orca's helper, MIT,
//! Copyright (c) 2026 Lovecast Inc.)

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting};
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation, CGEventType, CGKeyCode,
    CGMouseButton, CGScrollEventUnit,
};
use objc2_foundation::{NSArray, NSString};
use openlive_cu_core::backend::{Button, Direction};
use openlive_cu_core::keys::Chord;
use openlive_cu_core::{CuError, ErrorCode};
use std::thread::sleep;
use std::time::Duration;

const PAUSE: Duration = Duration::from_millis(50);
/// Lines per page of scrolling: about a screenful in a text view.
const LINES_PER_PAGE: f64 = 12.0;
const DRAG_STEPS: u32 = 10;
/// UTF-16 units per posted text event. CGEventKeyboardSetUnicodeString takes
/// up to 20; fewer keeps fast typists' apps from dropping the tail.
const TEXT_CHUNK: usize = 16;
/// How long the target app gets to read the clipboard before the user's own content goes back.
const PASTE_SETTLE: Duration = Duration::from_millis(300);

fn source() -> Result<objc2_core_foundation::CFRetained<CGEventSource>, CuError> {
    CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok_or_else(|| CuError::internal("no event source"))
}

fn post(event: Option<objc2_core_foundation::CFRetained<CGEvent>>) -> Result<(), CuError> {
    let event = event.ok_or_else(|| CuError::internal("could not create an input event"))?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

fn mouse_types(button: Button) -> (CGEventType, CGEventType, CGEventType, CGMouseButton) {
    match button {
        Button::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGEventType::LeftMouseDragged, CGMouseButton::Left),
        Button::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGEventType::RightMouseDragged, CGMouseButton::Right),
        Button::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGEventType::OtherMouseDragged, CGMouseButton::Center),
    }
}

fn mouse(src: &CGEventSource, kind: CGEventType, at: CGPoint, button: CGMouseButton, click_state: i64) -> Result<(), CuError> {
    let event = CGEvent::new_mouse_event(Some(src), kind, at, button);
    if click_state > 0 {
        CGEvent::set_integer_value_field(event.as_deref(), CGEventField::MouseEventClickState, click_state);
    }
    post(event)
}

/// One move, then a down/up pair per press, numbered so two presses register as a double click.
pub fn click(at: (f64, f64), button: Button, count: u8) -> Result<(), CuError> {
    let src = source()?;
    let at = CGPoint { x: at.0, y: at.1 };
    let (down, up, _, b) = mouse_types(button);
    mouse(&src, CGEventType::MouseMoved, at, b, 0)?;
    sleep(PAUSE);
    for press in 1..=i64::from(count) {
        mouse(&src, down, at, b, press)?;
        sleep(PAUSE);
        mouse(&src, up, at, b, press)?;
        sleep(PAUSE);
    }
    Ok(())
}

/// The pointer alone. With a button held (a `mouse_down` before) it is a drag event, as the app expects.
pub fn move_to(at: (f64, f64), held: Option<Button>) -> Result<(), CuError> {
    let src = source()?;
    let (kind, b) = match held {
        Some(button) => {
            let (_, _, dragged, b) = mouse_types(button);
            (dragged, b)
        }
        None => (CGEventType::MouseMoved, CGMouseButton::Left),
    };
    mouse(&src, kind, CGPoint { x: at.0, y: at.1 }, b, 0)
}

/// Half a click. A press moves there first, as `click` does, so the app sees the pointer arrive.
pub fn press_button(at: (f64, f64), button: Button, down: bool) -> Result<(), CuError> {
    let src = source()?;
    let at = CGPoint { x: at.0, y: at.1 };
    let (press, release, _, b) = mouse_types(button);
    if down {
        mouse(&src, CGEventType::MouseMoved, at, b, 0)?;
        sleep(PAUSE);
    }
    mouse(&src, if down { press } else { release }, at, b, 1)
}

pub fn drag(from: (f64, f64), to: (f64, f64)) -> Result<(), CuError> {
    let src = source()?;
    let (down, up, dragged, b) = mouse_types(Button::Left);
    let point = |t: f64| CGPoint { x: from.0 + (to.0 - from.0) * t, y: from.1 + (to.1 - from.1) * t };
    mouse(&src, CGEventType::MouseMoved, point(0.0), b, 0)?;
    sleep(PAUSE);
    mouse(&src, down, point(0.0), b, 1)?;
    sleep(PAUSE);
    for step in 1..=DRAG_STEPS {
        mouse(&src, dragged, point(f64::from(step) / f64::from(DRAG_STEPS)), b, 0)?;
        sleep(Duration::from_millis(15));
    }
    mouse(&src, up, point(1.0), b, 1)
}

/// Scroll events go where the pointer is, so the pointer moves there first.
pub fn scroll(at: (f64, f64), direction: Direction, pages: f64) -> Result<(), CuError> {
    let src = source()?;
    let at = CGPoint { x: at.0, y: at.1 };
    mouse(&src, CGEventType::MouseMoved, at, CGMouseButton::Left, 0)?;
    sleep(PAUSE);
    let lines = (LINES_PER_PAGE * pages).round().max(1.0) as i32;
    let (vertical, horizontal) = match direction {
        Direction::Up => (lines, 0),
        Direction::Down => (-lines, 0),
        Direction::Left => (0, lines),
        Direction::Right => (0, -lines),
    };
    post(CGEvent::new_scroll_wheel_event2(Some(&src), CGScrollEventUnit::Line, 2, vertical, horizontal, 0))
}

pub fn type_text(text: &str) -> Result<(), CuError> {
    let src = source()?;
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut start = 0;
    while start < units.len() {
        let mut end = (start + TEXT_CHUNK).min(units.len());
        // Never split a surrogate pair across two events.
        if end < units.len() && (0xD800..0xDC00).contains(&units[end - 1]) {
            end -= 1;
        }
        let chunk = &units[start..end];
        for down in [true, false] {
            let event = CGEvent::new_keyboard_event(Some(&src), 0, down);
            // SAFETY: `chunk` holds `chunk.len()` UTF-16 units.
            unsafe { CGEvent::keyboard_set_unicode_string(event.as_deref(), chunk.len() as _, chunk.as_ptr()) };
            post(event)?;
        }
        sleep(Duration::from_millis(8));
        start = end;
    }
    Ok(())
}

pub fn press(chord: &Chord) -> Result<(), CuError> {
    let Some(code) = keycode(&chord.key) else {
        if !chord.modifiers.any() {
            // A character with no key on the US layout (é, ß) still types.
            return type_text(&chord.key);
        }
        return Err(CuError::invalid(format!("'{}' has no key code to press with modifiers", chord.key)));
    };
    let src = source()?;
    let m = chord.modifiers;
    let held: Vec<(CGKeyCode, CGEventFlags)> = [
        (m.meta, 55, CGEventFlags::MaskCommand),
        (m.ctrl, 59, CGEventFlags::MaskControl),
        (m.alt, 58, CGEventFlags::MaskAlternate),
        (m.shift, 56, CGEventFlags::MaskShift),
    ]
    .into_iter()
    .filter(|(on, ..)| *on)
    .map(|(_, code, flag)| (code, flag))
    .collect();
    let mut flags = CGEventFlags::empty();
    let key = |code: CGKeyCode, down: bool, flags: CGEventFlags| {
        let event = CGEvent::new_keyboard_event(Some(&src), code, down);
        CGEvent::set_flags(event.as_deref(), flags);
        post(event)
    };
    for (code, flag) in &held {
        flags |= *flag;
        key(*code, true, flags)?;
    }
    let pressed = key(code, true, flags).and_then(|_| key(code, false, flags));
    // Modifiers always come back up, even when the key failed: a stuck command key breaks the user's next keystroke.
    for (code, flag) in held.iter().rev() {
        flags.remove(*flag);
        let _ = key(*code, false, flags);
    }
    pressed
}

/// Put `text` on the clipboard, press cmd+v, and put the user's clipboard back,
/// unless something else wrote to it in the meantime.
pub fn paste(text: &str) -> Result<(), CuError> {
    let board = NSPasteboard::generalPasteboard();
    let saved: Vec<Retained<NSPasteboardItem>> = board.pasteboardItems().map(|items| items.iter().map(|item| {
        let copy = NSPasteboardItem::new();
        for kind in item.types().iter() {
            if let Some(data) = item.dataForType(&kind) {
                copy.setData_forType(&data, &kind);
            }
        }
        copy
    }).collect()).unwrap_or_default();
    board.clearContents();
    // SAFETY: NSPasteboardTypeString is a static the framework defines.
    if !board.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }) {
        return Err(CuError::new(ErrorCode::Internal, "could not put the text on the clipboard"));
    }
    let ours = board.changeCount();
    let pressed = press(&Chord { modifiers: openlive_cu_core::keys::Modifiers { meta: true, ..Default::default() }, key: "v".into() });
    sleep(PASTE_SETTLE);
    if board.changeCount() == ours {
        board.clearContents();
        if !saved.is_empty() {
            let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = saved.into_iter().map(ProtocolObject::from_retained).collect();
            board.writeObjects(&NSArray::from_retained_slice(&objects));
        }
    }
    pressed
}

/// US-layout virtual key codes. A letter on another layout sits on another
/// key; such characters still type through `type_text` when unmodified.
pub fn keycode(key: &str) -> Option<CGKeyCode> {
    Some(match key {
        "a" => 0, "s" => 1, "d" => 2, "f" => 3, "h" => 4, "g" => 5, "z" => 6, "x" => 7, "c" => 8, "v" => 9,
        "b" => 11, "q" => 12, "w" => 13, "e" => 14, "r" => 15, "y" => 16, "t" => 17, "1" => 18, "2" => 19,
        "3" => 20, "4" => 21, "6" => 22, "5" => 23, "=" => 24, "9" => 25, "7" => 26, "-" => 27, "8" => 28,
        "0" => 29, "]" => 30, "o" => 31, "u" => 32, "[" => 33, "i" => 34, "p" => 35, "return" => 36,
        "l" => 37, "j" => 38, "'" => 39, "k" => 40, ";" => 41, "\\" => 42, "," => 43, "/" => 44, "n" => 45,
        "m" => 46, "." => 47, "tab" => 48, "space" | " " => 49, "`" => 50, "backspace" => 51, "escape" => 53,
        "f5" => 96, "f6" => 97, "f7" => 98, "f3" => 99, "f8" => 100, "f9" => 101, "f11" => 103, "f10" => 109,
        "f12" => 111, "home" => 115, "pageup" => 116, "forwarddelete" => 117, "f4" => 118, "end" => 119,
        "f2" => 120, "pagedown" => 121, "f1" => 122, "left" => 123, "right" => 124, "down" => 125, "up" => 126,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openlive_cu_core::keys::NAMED_KEYS;

    #[test]
    fn every_named_key_has_a_code() {
        for k in NAMED_KEYS {
            assert!(keycode(k).is_some(), "{k}");
        }
        for c in "abcdefghijklmnopqrstuvwxyz0123456789".chars() {
            assert!(keycode(&c.to_string()).is_some(), "{c}");
        }
    }
}
