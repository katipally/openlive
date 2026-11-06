//! Whether the focused element takes typed text, so Dictate can put its words
//! on the clipboard instead of typing them into nothing. Each platform reads
//! the facts; the verdicts are here, pure, so every OS's is tested on any OS.
//!
//! `None` is "could not tell", and the caller types as it always did: Electron
//! and other Chromium apps expose little or no tree until a screen reader asks,
//! and a wrong "no" would send dictation to the clipboard in an app that would
//! have taken it. So only a named element that is plainly not for typing is
//! `Some(false)`.
//!
//! The same read says whether the field is a password field and what stands
//! before the caret. A secure field's content is never read. Where its role is
//! unreadable the answer is "not secure", as before, except on macOS while
//! Secure Event Input is on, where it is "secure".

use crate::platform::desktop::current as platform;

/// What one read of the focused element found.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Focus {
    pub editable: Option<bool>,
    pub secure: bool,
    /// Up to `BEFORE_MAX` characters before the caret; `None` where the app will not say.
    pub before: Option<String>,
}

pub const BEFORE_MAX: usize = 320;

pub fn read() -> Focus {
    platform::focus_read()
}

/// The last `BEFORE_MAX` characters of `text`.
pub fn tail(text: &str) -> String {
    let skip = text.chars().count().saturating_sub(BEFORE_MAX);
    text.chars().skip(skip).collect()
}

/// macOS: the focused element's AXSubrole, the verdict `ax` gave it, and
/// whether Secure Event Input is on.
pub fn ax_secure(subrole: Option<&str>, editable: Option<bool>, secure_input: bool) -> bool {
    subrole == Some("AXSecureTextField") || (secure_input && editable.is_none())
}

/// Linux: the focused accessible's AT-SPI role name.
pub fn atspi_secure(role: &str) -> bool {
    role == "password text"
}

const AX_TEXT: [&str; 3] = ["AXTextField", "AXTextArea", "AXComboBox"];
/// Containers a sparse tree reports in place of the real control.
const AX_VAGUE: [&str; 8] = [
    "AXGroup",
    "AXWebArea",
    "AXWindow",
    "AXUnknown",
    "AXScrollArea",
    "AXSplitGroup",
    "AXLayoutArea",
    "AXApplication",
];

/// macOS: the focused element's AXRole, and whether its AXValue or
/// AXSelectedTextRange can be set.
pub fn ax(role: Option<&str>, settable: bool) -> Option<bool> {
    match role {
        _ if settable => Some(true),
        Some(r) if AX_TEXT.contains(&r) => Some(true),
        Some(r) if !AX_VAGUE.contains(&r) => Some(false),
        _ => None,
    }
}

const UIA_EDIT: i32 = 50004;
const UIA_DOCUMENT: i32 = 50030;
/// Custom, Group, Window, Pane.
const UIA_VAGUE: [i32; 4] = [50025, 50026, 50032, 50033];

/// Windows: the focused element's UIA control type, whether its ValuePattern
/// is writable (`None` without one), and whether it has a TextPattern.
pub fn uia(control: Option<i32>, value_writable: Option<bool>, text_pattern: bool) -> Option<bool> {
    match control {
        _ if value_writable == Some(true) || text_pattern => Some(true),
        Some(UIA_EDIT | UIA_DOCUMENT) => Some(true),
        Some(c) if !UIA_VAGUE.contains(&c) => Some(false),
        _ => None,
    }
}

/// A terminal takes typing without saying it is editable.
const ATSPI_TYPED: [&str; 1] = ["terminal"];
const ATSPI_VAGUE: [&str; 11] = [
    "frame",
    "window",
    "panel",
    "filler",
    "unknown",
    "redundant object",
    "document web",
    "document frame",
    "embedded",
    "application",
    "section",
];

/// Linux: the focused accessible's AT-SPI role name and whether its state set
/// holds EDITABLE.
pub fn atspi(role: &str, editable: bool) -> Option<bool> {
    match role {
        _ if editable || ATSPI_TYPED.contains(&role) => Some(true),
        r if !r.is_empty() && !ATSPI_VAGUE.contains(&r) => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ax_text_controls_and_settable_values_take_typing() {
        assert_eq!(ax(Some("AXTextArea"), false), Some(true));
        assert_eq!(ax(Some("AXTextField"), false), Some(true));
        assert_eq!(ax(Some("AXStaticText"), true), Some(true));
    }

    #[test]
    fn ax_a_named_control_is_not_for_typing() {
        assert_eq!(ax(Some("AXOutline"), false), Some(false));
        assert_eq!(ax(Some("AXList"), false), Some(false));
        assert_eq!(ax(Some("AXButton"), false), Some(false));
    }

    #[test]
    fn ax_a_container_or_nothing_cannot_tell() {
        assert_eq!(ax(Some("AXWebArea"), false), None);
        assert_eq!(ax(Some("AXGroup"), false), None);
        assert_eq!(ax(None, false), None);
    }

    #[test]
    fn uia_edit_document_and_writable_patterns_take_typing() {
        assert_eq!(uia(Some(UIA_EDIT), None, false), Some(true));
        assert_eq!(uia(Some(UIA_DOCUMENT), Some(false), false), Some(true));
        assert_eq!(uia(Some(50003), Some(true), false), Some(true));
        assert_eq!(uia(Some(50020), None, true), Some(true));
    }

    #[test]
    fn uia_a_list_or_a_read_only_value_is_not_for_typing() {
        assert_eq!(uia(Some(50008), None, false), Some(false));
        assert_eq!(uia(Some(50003), Some(false), false), Some(false));
    }

    #[test]
    fn uia_a_pane_or_nothing_cannot_tell() {
        assert_eq!(uia(Some(50033), None, false), None);
        assert_eq!(uia(None, None, false), None);
    }

    #[test]
    fn tail_keeps_the_last_characters_whole() {
        assert_eq!(tail("word "), "word ");
        let long = "é".repeat(BEFORE_MAX + 5);
        assert_eq!(tail(&long).chars().count(), BEFORE_MAX);
    }

    #[test]
    fn ax_secure_subrole_is_secure_and_secure_input_fails_closed_only_when_unreadable() {
        assert!(ax_secure(Some("AXSecureTextField"), Some(true), false));
        assert!(ax_secure(None, None, true));
        assert!(ax_secure(Some("AXUnknown"), None, true));
        assert!(!ax_secure(Some("AXTextField"), Some(true), true));
        assert!(!ax_secure(None, None, false));
    }

    #[test]
    fn atspi_password_text_is_secure() {
        assert!(atspi_secure("password text"));
        assert!(!atspi_secure("entry"));
    }

    #[test]
    fn atspi_editable_state_or_a_terminal_takes_typing() {
        assert_eq!(atspi("entry", true), Some(true));
        assert_eq!(atspi("terminal", false), Some(true));
    }

    #[test]
    fn atspi_a_named_control_is_not_for_typing() {
        assert_eq!(atspi("list item", false), Some(false));
        assert_eq!(atspi("push button", false), Some(false));
    }

    #[test]
    fn atspi_a_container_or_no_answer_cannot_tell() {
        assert_eq!(atspi("document web", false), None);
        assert_eq!(atspi("", false), None);
    }
}
