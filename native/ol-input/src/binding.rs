//! A binding is a `+`-joined lowercase string that round-trips through parse
//! and format. Modifier-only bindings ("ctrl", "option+shift") are first class.

use std::fmt;
use std::str::FromStr;

use handy_keys::{Hotkey, Key, Modifiers};

/// Canonical names, in the order `format` emits them. Every group is written
/// bare when both sides are accepted and side-suffixed otherwise, so the
/// formatted string carries exactly what was parsed.
const GROUPS: [(&str, Modifiers, Modifiers, Modifiers); 4] = [
    ("ctrl", Modifiers::CTRL, Modifiers::CTRL_LEFT, Modifiers::CTRL_RIGHT),
    ("option", Modifiers::OPT, Modifiers::OPT_LEFT, Modifiers::OPT_RIGHT),
    ("shift", Modifiers::SHIFT, Modifiers::SHIFT_LEFT, Modifiers::SHIFT_RIGHT),
    ("command", Modifiers::CMD, Modifiers::CMD_LEFT, Modifiers::CMD_RIGHT),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Binding {
    pub modifiers: Modifiers,
    pub key: Option<Key>,
}

impl Binding {
    pub fn is_modifier_only(&self) -> bool {
        self.key.is_none()
    }

    pub fn hotkey(&self) -> Hotkey {
        Hotkey { modifiers: self.modifiers, key: self.key }
    }

    pub fn from_hotkey(hotkey: Hotkey) -> Self {
        Self { modifiers: hotkey.modifiers, key: hotkey.key }
    }
}

fn parse_modifier(part: &str) -> Option<Modifiers> {
    let (name, side) = match part.rsplit_once('_') {
        Some((name, "left")) => (name, Some(true)),
        Some((name, "right")) => (name, Some(false)),
        _ => (part, None),
    };
    let base = match name {
        "ctrl" | "control" => Modifiers::CTRL,
        "option" | "opt" | "alt" => Modifiers::OPT,
        "shift" => Modifiers::SHIFT,
        "command" | "cmd" | "meta" | "super" | "win" => Modifiers::CMD,
        "fn" | "function" => Modifiers::FN,
        _ => return None,
    };
    match side {
        None => Some(base),
        // Fn reports no side, so a side-suffixed fn is not a binding.
        Some(_) if base == Modifiers::FN => None,
        Some(left) => Some(base & if left { LEFT } else { RIGHT }),
    }
}

const LEFT: Modifiers = Modifiers::CTRL_LEFT
    .union(Modifiers::OPT_LEFT)
    .union(Modifiers::SHIFT_LEFT)
    .union(Modifiers::CMD_LEFT);
const RIGHT: Modifiers = Modifiers::CTRL_RIGHT
    .union(Modifiers::OPT_RIGHT)
    .union(Modifiers::SHIFT_RIGHT)
    .union(Modifiers::CMD_RIGHT);

impl FromStr for Binding {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        let mut modifiers = Modifiers::empty();
        let mut key = None;
        for raw in s.split('+') {
            let part = raw.trim().to_lowercase();
            if part.is_empty() {
                return Err(format!("empty component in binding \"{s}\""));
            }
            if let Some(m) = parse_modifier(&part) {
                if modifiers.contains(m) {
                    return Err(format!("modifier \"{part}\" repeated in \"{s}\""));
                }
                modifiers |= m;
                continue;
            }
            if key.is_some() {
                return Err(format!("binding \"{s}\" has more than one key"));
            }
            key = Some(
                Key::from_str(&part).map_err(|_| format!("unknown key \"{part}\" in \"{s}\""))?,
            );
        }
        if modifiers.is_empty() && key.is_none() {
            return Err("a binding needs at least one modifier or key".into());
        }
        Ok(Binding { modifiers, key })
    }
}

impl fmt::Display for Binding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut parts = Vec::new();
        for (name, both, left, right) in GROUPS {
            if self.modifiers.contains(both) {
                parts.push(name.to_string());
            } else if self.modifiers.contains(left) {
                parts.push(format!("{name}_left"));
            } else if self.modifiers.contains(right) {
                parts.push(format!("{name}_right"));
            }
        }
        if self.modifiers.contains(Modifiers::FN) {
            parts.push("fn".into());
        }
        if let Some(key) = self.key {
            parts.push(key.to_string().to_lowercase());
        }
        f.write_str(&parts.join("+"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Binding {
        s.parse::<Binding>().expect(s)
    }

    #[test]
    fn modifier_only_bindings_parse() {
        assert!(parse("ctrl").is_modifier_only());
        assert!(parse("option+shift").is_modifier_only());
        assert!(!parse("option+space").is_modifier_only());
    }

    #[test]
    fn canonical_strings_are_stable() {
        assert_eq!(parse("ctrl").to_string(), "ctrl");
        assert_eq!(parse("option+space").to_string(), "option+space");
        assert_eq!(parse("ctrl+shift+space").to_string(), "ctrl+shift+space");
        // Aliases and ordering both normalise to the canonical form.
        assert_eq!(parse("SPACE+Shift+Cmd").to_string(), "shift+command+space");
        assert_eq!(parse("alt+ctrl+c").to_string(), "ctrl+option+c");
        assert_eq!(parse("ctrl_right").to_string(), "ctrl_right");
    }

    #[test]
    fn bad_bindings_report_why() {
        for bad in ["", "ctrl+", "ctrl+ctrl", "ctrl+a+b", "ctrl+wat"] {
            assert!(bad.parse::<Binding>().is_err(), "{bad} should not parse");
        }
    }

    #[test]
    fn every_combination_round_trips() {
        let sides = [
            Modifiers::CTRL,
            Modifiers::CTRL_LEFT,
            Modifiers::OPT,
            Modifiers::OPT_RIGHT,
            Modifiers::SHIFT,
            Modifiers::CMD,
            Modifiers::CMD_LEFT,
            Modifiers::FN,
        ];
        let keys = [
            None,
            Some(Key::Space),
            Some(Key::A),
            Some(Key::F13),
            Some(Key::Num7),
            Some(Key::LeftArrow),
            Some(Key::KeypadDecimal),
            Some(Key::Grave),
        ];
        let mut checked = 0;
        for mask in 0u32..(1 << sides.len()) {
            let modifiers = sides
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .fold(Modifiers::empty(), |acc, (_, m)| acc | *m);
            for key in keys {
                if modifiers.is_empty() && key.is_none() {
                    continue;
                }
                let binding = Binding { modifiers, key };
                let text = binding.to_string();
                assert_eq!(parse(&text), binding, "{text}");
                assert_eq!(parse(&text).to_string(), text);
                checked += 1;
            }
        }
        assert_eq!(checked, (1 << sides.len()) * keys.len() - 1);
    }
}
