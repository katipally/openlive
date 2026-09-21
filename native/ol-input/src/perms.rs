//! Permission probes and requests. Nothing here runs implicitly: the hook and
//! the injector stay uninitialised until onboarding asks for them, so no
//! prompt appears before the user has been told what it is for.

use crate::platform::current as platform;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub accessibility: bool,
    /// Whether this process may post keystrokes and clicks. A separate grant
    /// from `accessibility`, and the two disagree often enough to matter.
    pub post_events: bool,
    pub microphone: &'static str,
    pub screen_recording: bool,
}

fn microphone() -> &'static str {
    match platform::microphone_status() {
        0 => "undetermined",
        1 => "restricted",
        2 => "denied",
        _ => "granted",
    }
}

pub fn status() -> Status {
    Status {
        accessibility: platform::accessibility_ok(),
        post_events: platform::post_events_ok(),
        microphone: microphone(),
        screen_recording: platform::screen_recording_ok(),
    }
}

/// Shows the system prompt. macOS never calls back, so the caller polls
/// `status()` until it flips or gives up.
pub fn request_accessibility() -> bool {
    platform::request_accessibility()
}

/// Prompts, exactly like `request_accessibility`, so only onboarding calls it.
pub fn request_post_events() -> bool {
    platform::request_post_events()
}

pub fn request_microphone() -> &'static str {
    platform::request_microphone();
    microphone()
}

pub fn request_screen_recording() -> bool {
    platform::request_screen_recording()
}
