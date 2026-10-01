//! The arithmetic of posted input, kept free of Win32 so it is tested on every
//! OS: virtual-key codes, text as SendInput takes it, wheel distances and
//! SendInput's absolute coordinate space.

pub const VK_TAB: u16 = 0x09;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_LWIN: u16 = 0x5B;

/// The virtual key of a named key, a letter or a digit. Punctuation sits on
/// different keys per layout, so it is looked up on the live layout instead.
pub fn vk(key: &str) -> Option<u16> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return match c {
            'a'..='z' => Some(c.to_ascii_uppercase() as u16),
            '0'..='9' | ' ' => Some(c as u16),
            _ => None,
        };
    }
    Some(match key {
        "return" => VK_RETURN,
        "tab" => VK_TAB,
        "space" => 0x20,
        "backspace" => 0x08,
        "forwarddelete" => 0x2E,
        "escape" => 0x1B,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "end" => 0x23,
        "home" => 0x24,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        f if f.len() > 1 && f.starts_with('f') => {
            let n: u16 = f[1..].parse().ok().filter(|n| (1..=12).contains(n))?;
            0x70 + n - 1
        }
        _ => return None,
    })
}

/// Keys that live on the extended block. Without KEYEVENTF_EXTENDEDKEY an
/// arrow arrives as its numeric keypad twin, which some apps read as a digit.
pub fn extended(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90 | 0xA3 | 0xA5)
}

/// One step of typed text: a UTF-16 unit sent as KEYEVENTF_UNICODE, or a key
/// for the characters apps take as keys rather than as text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Typed {
    Unit(u16),
    Key(u16),
}

/// Text as SendInput types it. A line break is Return (a bare LF reaches a
/// Win32 edit control as Ctrl+Enter), CRLF counts once, and a tab is Tab.
pub fn typed(text: &str) -> Vec<Typed> {
    let mut out = Vec::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                chars.next_if_eq(&'\n');
                out.push(Typed::Key(VK_RETURN));
            }
            '\n' => out.push(Typed::Key(VK_RETURN)),
            '\t' => out.push(Typed::Key(VK_TAB)),
            c => out.extend(c.encode_utf16(&mut [0; 2]).iter().map(|u| Typed::Unit(*u))),
        }
    }
    out
}

/// WHEEL_DELTA: one notch of a wheel.
pub const WHEEL_DELTA: i32 = 120;
/// Notches per page: Windows scrolls three lines a notch by default, and a
/// page is the twelve lines the macOS backend scrolls.
const NOTCHES_PER_PAGE: f64 = 4.0;

pub fn wheel_delta(pages: f64) -> i32 {
    (pages * NOTCHES_PER_PAGE).round().max(1.0) as i32 * WHEEL_DELTA
}

/// A desktop pixel as SendInput's MOUSEEVENTF_ABSOLUTE | VIRTUALDESK
/// coordinate: 0 to 65535 across the virtual screen, edges included.
pub fn absolute(px: i32, origin: i32, size: i32) -> i32 {
    let span = f64::from((size - 1).max(1));
    (f64::from(px - origin) * 65535.0 / span).round().clamp(0.0, 65535.0) as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use openlive_cu_core::keys::{parse, NAMED_KEYS};

    #[test]
    fn every_named_key_letter_and_digit_has_a_virtual_key() {
        for k in NAMED_KEYS {
            assert!(vk(k).is_some(), "{k}");
        }
        for c in "abcdefghijklmnopqrstuvwxyz0123456789".chars() {
            assert!(vk(&c.to_string()).is_some(), "{c}");
        }
        assert_eq!(vk("a"), Some(0x41));
        assert_eq!(vk("f12"), Some(0x7B));
        assert_eq!(vk("f13"), None);
        assert_eq!(vk("/"), None);
        // The core's Windows spelling of Delete lands on VK_DELETE, which is extended.
        let del = parse("delete", false).unwrap();
        assert_eq!(vk(&del.key), Some(0x2E));
        assert!(extended(0x2E) && extended(0x25) && !extended(0x41));
    }

    #[test]
    fn text_types_line_breaks_and_tabs_as_keys_and_keeps_surrogates_whole() {
        assert_eq!(typed("a\r\nb\nc\td"), vec![
            Typed::Unit('a' as u16), Typed::Key(VK_RETURN), Typed::Unit('b' as u16), Typed::Key(VK_RETURN),
            Typed::Unit('c' as u16), Typed::Key(VK_TAB), Typed::Unit('d' as u16),
        ]);
        assert_eq!(typed("😀"), vec![Typed::Unit(0xD83D), Typed::Unit(0xDE00)]);
        assert_eq!(typed("\r"), vec![Typed::Key(VK_RETURN)]);
    }

    #[test]
    fn wheel_and_absolute_coordinates() {
        assert_eq!(wheel_delta(1.0), 480);
        assert_eq!(wheel_delta(0.1), 120);
        assert_eq!(absolute(0, 0, 1920), 0);
        assert_eq!(absolute(1919, 0, 1920), 65535);
        assert_eq!(absolute(-1920, -1920, 3840), 0);
        assert_eq!(absolute(5000, 0, 1920), 65535);
    }
}
