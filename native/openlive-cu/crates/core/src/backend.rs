//! What each OS provides. The core parses requests, converts coordinates,
//! encodes pictures and refreshes state after every action; a backend only
//! finds windows, reads trees, captures pixels and delivers input.

use crate::keys::Chord;
use crate::protocol::{ActionReport, AppInfo, CuError, ErrorCode, Grant, WindowInfo};
use ::image::RgbaImage;

/// The app and window a request is about, resolved once per request.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub app: AppInfo,
    pub window: WindowInfo,
}

pub struct Observation {
    pub tree_text: String,
    pub element_count: usize,
    pub focused: Option<usize>,
    pub truncated: bool,
    /// The window's pixels at most `max_long_edge` on the long side, or why there are none.
    pub image: Option<Result<RgbaImage, String>>,
}

/// Where a pointer action lands: an element from the last observation of this
/// window, or a desktop point the core already converted from the picture.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ClickAt {
    Element(usize),
    Point(f64, f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Click { at: ClickAt, button: Button, count: u8 },
    SecondaryAction { element: usize, action: String },
    SetValue { element: usize, value: String },
    TypeText { text: String },
    PasteText { text: String },
    /// `hotkey` marks a chord the model meant as a shortcut (cmd+a), which a
    /// backend may carry out semantically (select all through the AX API).
    PressKey { chord: Chord, hotkey: bool },
    Scroll { at: ClickAt, direction: Direction, pages: f64 },
    Drag { from: ClickAt, to: ClickAt },
}

pub trait Backend {
    /// `macos`, `windows` or `linux`.
    fn platform(&self) -> &'static str;
    /// Why this backend cannot serve yet, or `None` when it can.
    fn unsupported(&self) -> Option<String>;
    /// Must not prompt: it only reads what is already granted.
    fn grants(&self) -> Vec<Grant>;
    /// Ask the OS for one grant (`accessibility`, `screenRecording`) and open its settings page.
    /// The only call that may show a system prompt; the user asked for it.
    fn request_grant(&mut self, id: &str) -> Result<(), CuError>;
    fn list_apps(&mut self) -> Result<Vec<AppInfo>, CuError>;
    fn list_windows(&mut self, app: Option<&str>) -> Result<Vec<WindowInfo>, CuError>;
    /// `app` is a bundle id, a name, or `pid:<n>`; `None` is the app in front.
    /// `window` picks one of its windows; `None` is its focused or main window.
    fn resolve(&mut self, app: Option<&str>, window: Option<u64>) -> Result<Resolved, CuError>;
    /// Read the window's tree, remembering its elements for the next action, and capture it.
    fn observe(&mut self, target: &Resolved, screenshot: bool, max_long_edge: u32) -> Result<Observation, CuError>;
    fn act(&mut self, target: &Resolved, action: &Action) -> Result<ActionReport, CuError>;
}

/// Password managers stay out of reach whatever the model is asked to do.
/// macOS bundle ids now; Windows and Linux add their executable and desktop ids.
pub const BLOCKED_APPS: &[&str] = &[
    "com.1password.1password", "com.1password.safari", "com.agilebits.onepassword7",
    "com.bitwarden.desktop", "com.dashlane.dashlanephonefinal", "com.lastpass.lastpass",
    "com.nordsec.nordpass", "me.proton.pass.electron", "me.proton.pass.catalyst",
    "com.apple.keychainaccess", "com.apple.passwords",
];

pub fn refuse_blocked(app: &AppInfo) -> Result<(), CuError> {
    match &app.bundle_id {
        Some(id) if BLOCKED_APPS.contains(&id.to_lowercase().as_str()) => Err(CuError::new(
            ErrorCode::AppBlocked,
            format!("{} holds passwords, so OpenLive does not read or operate it. Ask the user to do this part themselves.", app.name),
        )),
        _ => Ok(()),
    }
}

/// The error every stub backend returns until its phase lands.
pub fn not_yet(platform: &str) -> CuError {
    CuError::new(ErrorCode::UnsupportedPlatform, format!("computer use is not yet supported on {platform}"))
}
