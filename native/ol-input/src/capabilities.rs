//! What this machine can actually do, right now.
//!
//! Flow is required to degrade honestly, and this is the function the UI
//! reads to do it. Everything that can change while the app runs (a
//! permission being granted, secure input coming on, the foreground window
//! turning out to be elevated) is read on every call; everything that cannot
//! (which engine, which tools are installed) is resolved once.

use std::sync::OnceLock;

use crate::inject::Method;
use crate::platform::current as platform;
use crate::platform::desktop::current as desktop;

#[derive(Debug, Clone, PartialEq)]
pub struct Capabilities {
    /// The global hook can run, which on macOS means Accessibility is granted.
    pub hook: bool,
    /// Typing and clicking reach other apps. False means every event this
    /// process posts is discarded without a word, so nothing may claim to
    /// have typed or clicked.
    pub post_events: bool,
    /// "paste" or "type".
    pub injection: &'static str,
    pub capture: bool,
    pub capture_backend: &'static str,
    pub ocr: bool,
    pub ocr_engine: &'static str,
    pub selection: bool,
    pub selection_backend: &'static str,
    pub window_control: bool,
    /// False when injecting into the window in front would be silently
    /// dropped, which on Windows is what a non-elevated process gets.
    pub elevated_window_injection: bool,
    pub secure_input: bool,
    /// "x11" or "wayland" on Linux, absent elsewhere.
    pub session: Option<&'static str>,
    /// Which of the external tools Linux needs were actually found.
    pub tools: Vec<String>,
}

/// Installing a tool or a language pack mid-session is not a case worth a
/// probe on every turn, and the probes shell out or build an OCR engine.
fn static_parts() -> &'static (bool, Vec<String>) {
    static PARTS: OnceLock<(bool, Vec<String>)> = OnceLock::new();
    PARTS.get_or_init(|| (desktop::ocr_available(), desktop::external_tools()))
}

pub fn probe() -> Capabilities {
    let (ocr, tools) = static_parts();
    Capabilities {
        hook: platform::accessibility_ok(),
        post_events: platform::post_events_ok(),
        injection: match Method::default_for_platform() {
            Method::Paste => "paste",
            Method::Type => "type",
        },
        capture: desktop::capture_ok(),
        capture_backend: desktop::capture_backend(),
        ocr: *ocr,
        ocr_engine: desktop::ocr_engine(),
        selection: desktop::selection_ok(),
        selection_backend: desktop::selection_backend(),
        window_control: desktop::window_control_ok(),
        elevated_window_injection: desktop::elevated_injection_ok(),
        secure_input: platform::secure_input_active(),
        session: desktop::session_kind(),
        tools: tools.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_probe_answers_the_same_way_twice() {
        assert_eq!(probe(), probe());
    }

    #[test]
    fn a_probe_names_its_backends() {
        let capabilities = probe();
        assert!(!capabilities.capture_backend.is_empty());
        assert!(!capabilities.ocr_engine.is_empty());
        assert!(!capabilities.selection_backend.is_empty());
    }
}
