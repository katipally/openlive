//! Foreground-window metadata, the window list, window management, and the
//! focused element's selected text.
//!
//! `foreground()` runs on the hot path of every Flow turn, so it reads window
//! metadata rather than capturing anything: on macOS that is
//! `CGWindowListCopyWindowInfo` plus `NSWorkspace`, neither of which needs
//! screen recording, and on the platforms where the window *title* is gated
//! the title comes back `None` instead of the whole read failing.

use crate::coords::ScreenPoint;
use crate::platform::desktop::current as platform;

#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub id: u32,
    pub app_name: String,
    /// Bundle id on macOS, executable name elsewhere.
    pub app_id: Option<String>,
    /// `None` when the platform will not give it up without a permission the
    /// user has not granted. Never an empty string standing in for unknown.
    pub title: Option<String>,
    pub pid: u32,
    pub origin: ScreenPoint,
    pub width: f64,
    pub height: f64,
    pub display_id: Option<u32>,
    pub minimized: bool,
}

pub fn foreground() -> Result<Option<WindowInfo>, String> {
    platform::foreground_window()
}

pub fn list() -> Result<Vec<WindowInfo>, String> {
    platform::window_list()
}

pub fn activate(id: u32) -> Result<(), String> {
    platform::activate_window(id)
}

pub fn move_to(id: u32, origin: ScreenPoint) -> Result<(), String> {
    platform::move_window(id, origin)
}

pub fn resize(id: u32, width: f64, height: f64) -> Result<(), String> {
    if width <= 0.0 || height <= 0.0 {
        return Err("a window needs a positive width and height".into());
    }
    platform::resize_window(id, width, height)
}

pub fn minimize(id: u32) -> Result<(), String> {
    platform::minimize_window(id)
}

pub fn close(id: u32) -> Result<(), String> {
    platform::close_window(id)
}

pub fn open_app(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("open_app needs an application name".into());
    }
    platform::open_app(name)
}

pub fn open_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    // A bare path or a javascript: url reaching the system opener is a way to
    // run something that does not look like browsing.
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("open_url only opens http and https urls".into());
    }
    platform::open_url(trimmed)
}

/// The focused element's selected text. `None` means the platform or the app
/// could not tell us, which is not the same as an empty selection.
pub fn selection() -> Option<String> {
    let text = platform::selected_text()?;
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}
