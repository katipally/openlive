//! The arithmetic of posted input, kept free of X11 and D-Bus so it is tested
//! on every OS: keysyms for keys and text, where a keysym sits in an X keymap,
//! button codes, and wheel notches.
//!
//! Text goes in by keysym, never by keycode guessed from US QWERTY: X11 looks
//! the keysym up in the live keymap (and binds a spare keycode to it when no
//! key makes it), and the RemoteDesktop portal hands it to the compositor,
//! which does the same lookup on the layout in use.

use openlive_cu_core::keys::Modifiers;

pub const RETURN: u32 = 0xff0d;
pub const TAB: u32 = 0xff09;
pub const SHIFT_L: u32 = 0xffe1;
pub const CONTROL_L: u32 = 0xffe3;
pub const ALT_L: u32 = 0xffe9;
pub const SUPER_L: u32 = 0xffeb;
pub const CAPS_LOCK: u32 = 0xffe5;
pub const ISO_LEVEL3_SHIFT: u32 = 0xfe03;
const NO_SYMBOL: u32 = 0;

/// The keysym that types `c`: Latin-1 is its own keysym, everything else the
/// Unicode keysym range (0x01000000 + code point) that X and xkbcommon both read.
pub fn char_keysym(c: char) -> u32 {
    match c {
        '\n' | '\r' => RETURN,
        '\t' => TAB,
        '\u{8}' => 0xff08,
        '\u{1b}' => 0xff1b,
        ' '..='~' | '\u{a0}'..='\u{ff}' => c as u32,
        c => 0x0100_0000 | c as u32,
    }
}

/// The keysym of one key as the core names it: a named key or a single character.
pub fn key_keysym(key: &str) -> Option<u32> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Some(char_keysym(c));
    }
    Some(match key {
        "return" => RETURN,
        "tab" => TAB,
        "space" => 0x20,
        "backspace" => 0xff08,
        "forwarddelete" => 0xffff,
        "escape" => 0xff1b,
        "home" => 0xff50,
        "left" => 0xff51,
        "up" => 0xff52,
        "right" => 0xff53,
        "down" => 0xff54,
        "pageup" => 0xff55,
        "pagedown" => 0xff56,
        "end" => 0xff57,
        f if f.len() > 1 && f.starts_with('f') => {
            let n: u32 = f[1..].parse().ok().filter(|n| (1..=12).contains(n))?;
            0xffbe + n - 1
        }
        _ => return None,
    })
}

/// The modifier keys a chord holds, in the order they go down.
pub fn modifier_keysyms(m: Modifiers) -> Vec<u32> {
    [(m.meta, SUPER_L), (m.ctrl, CONTROL_L), (m.alt, ALT_L), (m.shift, SHIFT_L)].into_iter().filter_map(|(on, k)| on.then_some(k)).collect()
}

/// Text as keysyms. CRLF counts as one Return.
pub fn typed(text: &str) -> Vec<u32> {
    let mut out = Vec::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            chars.next_if_eq(&'\n');
        }
        out.push(char_keysym(c));
    }
    out
}

/// Which shift level of a key makes a keysym: the columns of the core X
/// keymap XKB fills in, group 1 only (columns 2 and 3 belong to group 2,
/// which a posted key cannot select).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Plain,
    Shift,
    AltGr,
    AltGrShift,
}

impl Level {
    pub fn needs_shift(self) -> bool {
        matches!(self, Level::Shift | Level::AltGrShift)
    }
    pub fn needs_altgr(self) -> bool {
        matches!(self, Level::AltGr | Level::AltGrShift)
    }
}

const COLUMNS: [(usize, Level); 4] = [(0, Level::Plain), (1, Level::Shift), (4, Level::AltGr), (5, Level::AltGrShift)];

/// The upper case X implies for a key whose second column is empty.
fn implied_upper(keysym: u32) -> Option<u32> {
    match keysym {
        0x61..=0x7a => Some(keysym - 0x20),
        0xe0..=0xfe if keysym != 0xf7 => Some(keysym - 0x20),
        _ => None,
    }
}

/// The core keyboard mapping, as GetKeyboardMapping returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keymap {
    pub min_keycode: u8,
    pub per_keycode: usize,
    pub keysyms: Vec<u32>,
}

impl Keymap {
    fn rows(&self) -> impl Iterator<Item = (u8, &[u32])> {
        self.keysyms.chunks(self.per_keycode.max(1)).enumerate().map(|(i, row)| (self.min_keycode.saturating_add(i as u8), row))
    }

    /// The key and level that type `keysym`, lowest keycode first. O(k) for k keycodes.
    pub fn find(&self, keysym: u32) -> Option<(u8, Level)> {
        self.rows().find_map(|(code, row)| {
            let at = |col: usize| row.get(col).copied().unwrap_or(NO_SYMBOL);
            COLUMNS.iter().find_map(|&(col, level)| {
                let sym = match at(col) {
                    NO_SYMBOL if col == 1 => implied_upper(at(0)).unwrap_or(NO_SYMBOL),
                    s => s,
                };
                (sym == keysym && sym != NO_SYMBOL).then_some((code, level))
            })
        })
    }

    /// A keycode no key uses, from the top, to bind a keysym the layout lacks.
    pub fn spare(&self) -> Option<u8> {
        let rows: Vec<(u8, &[u32])> = self.rows().collect();
        rows.into_iter().rev().find(|(_, row)| row.iter().all(|s| *s == NO_SYMBOL)).map(|(code, _)| code)
    }
}

/// X core buttons and evdev button codes (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE) for the portal.
pub fn x_button(button: openlive_cu_core::backend::Button) -> u8 {
    use openlive_cu_core::backend::Button::*;
    match button {
        Left => 1,
        Middle => 2,
        Right => 3,
    }
}

pub fn evdev_button(button: openlive_cu_core::backend::Button) -> i32 {
    use openlive_cu_core::backend::Button::*;
    match button {
        Left => 0x110,
        Right => 0x111,
        Middle => 0x112,
    }
}

/// Wheel notches per page: three lines a notch by default, and a page is the
/// twelve lines the other backends scroll.
pub fn notches(pages: f64) -> u32 {
    (pages * 4.0).round().max(1.0) as u32
}

/// The X core wheel button for a direction: 4 up, 5 down, 6 left, 7 right.
pub fn wheel_button(direction: openlive_cu_core::backend::Direction) -> u8 {
    use openlive_cu_core::backend::Direction::*;
    match direction {
        Up => 4,
        Down => 5,
        Left => 6,
        Right => 7,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openlive_cu_core::keys::{parse, NAMED_KEYS};

    #[test]
    fn every_named_key_and_character_has_a_keysym() {
        for k in NAMED_KEYS {
            assert!(key_keysym(k).is_some(), "{k}");
        }
        assert_eq!(key_keysym("a"), Some(0x61));
        assert_eq!(key_keysym("/"), Some(0x2f));
        assert_eq!(key_keysym("f12"), Some(0xffc9));
        assert_eq!(key_keysym("f13"), None);
        assert_eq!(key_keysym(&parse("delete", false).unwrap().key), Some(0xffff));
    }

    #[test]
    fn text_is_latin1_or_unicode_keysyms() {
        assert_eq!(typed("a\r\nb\tc"), [0x61, RETURN, 0x62, TAB, 0x63]);
        assert_eq!(typed("é€😀"), [0xe9, 0x0100_20ac, 0x0101_f600]);
        assert_eq!(typed("\r"), [RETURN]);
    }

    fn us() -> Keymap {
        // Keycodes 8..=12: a/A, 1/!, an AltGr row (e, E, -, -, €), Shift_L, and an empty key.
        let per = 6;
        let mut syms = vec![0; per * 5];
        syms[..2].copy_from_slice(&[0x61, 0]);
        syms[per..per + 2].copy_from_slice(&[0x31, 0x21]);
        syms[2 * per] = 0x65;
        syms[2 * per + 4] = 0x20ac;
        syms[3 * per] = SHIFT_L;
        Keymap { min_keycode: 8, per_keycode: per, keysyms: syms }
    }

    #[test]
    fn finds_the_key_and_level_for_a_keysym() {
        let k = us();
        assert_eq!(k.find(0x61), Some((8, Level::Plain)));
        // An empty second column means the upper case of the first.
        assert_eq!(k.find(0x41), Some((8, Level::Shift)));
        assert_eq!(k.find(0x21), Some((9, Level::Shift)));
        assert_eq!(k.find(0x20ac), Some((10, Level::AltGr)));
        assert_eq!(k.find(SHIFT_L), Some((11, Level::Plain)));
        assert_eq!(k.find(0x0100_20ac), None);
        assert_eq!(k.spare(), Some(12));
        assert!(Level::AltGrShift.needs_shift() && Level::AltGrShift.needs_altgr() && !Level::Plain.needs_shift());
    }

    #[test]
    fn a_full_keymap_has_no_spare() {
        let k = Keymap { min_keycode: 8, per_keycode: 2, keysyms: vec![0x61, 0x41, 0x62, 0x42] };
        assert_eq!(k.spare(), None);
        assert_eq!(Keymap { min_keycode: 8, per_keycode: 0, keysyms: vec![] }.find(0x61), None);
    }

    #[test]
    fn modifiers_go_down_in_a_fixed_order() {
        let m = parse("ctrl+shift+super+t", false).unwrap().modifiers;
        assert_eq!(modifier_keysyms(m), [SUPER_L, CONTROL_L, SHIFT_L]);
    }

    #[test]
    fn wheel_notches() {
        assert_eq!(notches(1.0), 4);
        assert_eq!(notches(0.1), 1);
        assert_eq!(notches(2.5), 10);
    }
}
