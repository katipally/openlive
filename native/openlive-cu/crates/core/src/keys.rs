//! Key chords as models write them, `cmd+shift+p` or `Return`, normalised to
//! one vocabulary every backend maps onto its own key codes.

use crate::protocol::CuError;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
    /// Command on macOS, the Windows key elsewhere.
    pub meta: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

impl Modifiers {
    pub fn any(&self) -> bool {
        self.meta || self.ctrl || self.alt || self.shift
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub modifiers: Modifiers,
    /// Lowercase: a single character (`a`, `/`), or a named key (`return`, `up`, `f5`).
    pub key: String,
}

/// The spellings models reach for, onto the one each backend knows.
const ALIASES: &[(&str, &str)] = &[
    ("enter", "return"), ("esc", "escape"), ("del", "delete"), ("arrowup", "up"), ("arrowdown", "down"),
    ("arrowleft", "left"), ("arrowright", "right"), ("pgup", "pageup"), ("page_up", "pageup"),
    ("pgdn", "pagedown"), ("pgdown", "pagedown"), ("page_down", "pagedown"), ("spacebar", "space"),
    ("plus", "="), ("minus", "-"),
];

/// Every named key a backend must map. Single printable characters are implied.
pub const NAMED_KEYS: &[&str] = &[
    "return", "tab", "space", "backspace", "forwarddelete", "escape", "up", "down", "left", "right",
    "home", "end", "pageup", "pagedown", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10",
    "f11", "f12",
];

/// `mac` decides what `cmdorctrl` means. A chord is any number of modifiers and exactly one key.
pub fn parse(spec: &str, mac: bool) -> Result<Chord, CuError> {
    let mut modifiers = Modifiers::default();
    let mut key: Option<String> = None;
    // `cmd++` is cmd and the plus key.
    let spelled = match spec.trim_end().strip_suffix("++") {
        Some(head) => format!("{head}+plus"),
        None => spec.to_owned(),
    };
    for raw in spelled.split('+').map(|p| p.trim().to_lowercase().replace(' ', "")) {
        if raw.is_empty() {
            return Err(CuError::invalid(format!("'{spec}' has an empty key")));
        }
        match raw.as_str() {
            "cmd" | "command" | "meta" | "super" | "win" | "windows" => modifiers.meta = true,
            "ctrl" | "control" => modifiers.ctrl = true,
            "alt" | "option" | "opt" => modifiers.alt = true,
            "shift" => modifiers.shift = true,
            "cmdorctrl" | "commandorcontrol" => {
                if mac { modifiers.meta = true } else { modifiers.ctrl = true }
            }
            _ => {
                if key.is_some() {
                    return Err(CuError::invalid(format!("'{spec}' names more than one key; press them one at a time")));
                }
                let name = ALIASES.iter().find(|(from, _)| *from == raw).map_or(raw.as_str(), |(_, to)| *to);
                // The Mac key labelled delete erases to the left; everywhere else Delete erases to the right.
                let name = match name { "delete" if mac => "backspace", "delete" => "forwarddelete", n => n };
                if name.chars().count() != 1 && !NAMED_KEYS.contains(&name) {
                    return Err(CuError::invalid(format!("unknown key '{name}' in '{spec}'")));
                }
                key = Some(name.to_owned());
            }
        }
    }
    let key = key.ok_or_else(|| CuError::invalid(format!("'{spec}' has modifiers but no key")))?;
    Ok(Chord { modifiers, key })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chords_and_aliases() {
        let c = parse("Cmd+Shift+P", true).unwrap();
        assert_eq!(c.key, "p");
        assert!(c.modifiers.meta && c.modifiers.shift && !c.modifiers.ctrl);
        assert_eq!(parse("Enter", true).unwrap().key, "return");
        assert_eq!(parse("ArrowUp", true).unwrap().key, "up");
        assert_eq!(parse("page down", true).unwrap().key, "pagedown");
        assert_eq!(parse("cmd++", true).unwrap().key, "=");
        assert_eq!(parse("delete", true).unwrap().key, "backspace");
        assert_eq!(parse("delete", false).unwrap().key, "forwarddelete");
    }

    #[test]
    fn cmdorctrl_follows_the_platform() {
        assert!(parse("CmdOrCtrl+a", true).unwrap().modifiers.meta);
        assert!(parse("CmdOrCtrl+a", false).unwrap().modifiers.ctrl);
    }

    #[test]
    fn refuses_what_it_cannot_press() {
        assert!(parse("cmd+shift", true).is_err());
        assert!(parse("a+b", true).is_err());
        assert!(parse("hyperdrive", true).is_err());
        assert!(parse("", true).is_err());
    }
}
