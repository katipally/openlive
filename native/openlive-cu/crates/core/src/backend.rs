//! What each OS provides. The core parses requests, converts coordinates,
//! encodes pictures and refreshes state after every action; a backend only
//! finds windows, reads trees, captures pixels and delivers input.

use crate::keys::Chord;
use crate::protocol::{ActionReport, AppInfo, CuError, ErrorCode, Grant, WindowInfo};
use ::image::RgbaImage;
use std::path::{Path, PathBuf};

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
    /// The pointer alone, for a hover state. While a button is held it drags.
    Move { at: ClickAt },
    /// Half a click, for a gesture `click` and `drag` cannot express. A backend
    /// remembers the held button so a `Move` before the `MouseUp` drags.
    MouseDown { at: ClickAt, button: Button },
    MouseUp { at: ClickAt, button: Button },
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

/// Password managers stay out of reach whatever the model is asked to do: macOS
/// bundle ids, then Windows executables (the id the Windows backend reports),
/// then Linux executables (the id the Linux backend reports, the script's name
/// for an app an interpreter runs, so GNOME Secrets reads `secrets`).
pub const BLOCKED_APPS: &[&str] = &[
    "com.1password.1password", "com.1password.safari", "com.agilebits.onepassword7",
    "com.bitwarden.desktop", "com.dashlane.dashlanephonefinal", "com.lastpass.lastpass",
    "com.nordsec.nordpass", "me.proton.pass.electron", "me.proton.pass.catalyst",
    "com.apple.keychainaccess", "com.apple.passwords",
    "1password.exe", "bitwarden.exe", "dashlane.exe", "lastpass.exe", "nordpass.exe", "proton pass.exe",
    "keepass.exe", "keepassxc.exe", "enpass.exe", "roboform.exe", "keeper.exe", "passwordsafe.exe",
    "keepassxc", "keepassx", "keepass2", "1password", "bitwarden", "enpass", "nordpass", "proton-pass", "protonpass",
    "seahorse", "secrets", "gnome-passwordsafe", "kwalletmanager5", "kwalletmanager", "pwsafe", "keeperpasswordmanager",
    "buttercup", "padloc", "qtpass",
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

/// Where OpenLive itself runs from (`OPENLIVE_CU_OWN_ROOT`, set by the client).
/// An app whose executable lies inside is OpenLive's own window, never the
/// default target: in Chat the window in front is OpenLive's.
pub fn own_root() -> Option<PathBuf> {
    std::env::var_os("OPENLIVE_CU_OWN_ROOT").filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Whether `path` lies inside `root`, component by component. Case is ignored
/// where the file system ignores it by default (macOS and Windows).
pub fn within(path: &Path, root: &Path) -> bool {
    let fold = |c: std::path::Component| {
        let s = c.as_os_str().to_string_lossy().into_owned();
        if cfg!(any(target_os = "macos", windows)) { s.to_lowercase() } else { s }
    };
    let mut parts = path.components().map(fold);
    root.components().count() > 0 && root.components().map(fold).all(|r| parts.next().as_ref() == Some(&r))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_compares_whole_components() {
        assert!(within(Path::new("/Applications/OpenLive.app/Contents/MacOS/OpenLive"), Path::new("/Applications/OpenLive.app")));
        assert!(within(Path::new("/Applications/OpenLive.app"), Path::new("/Applications/OpenLive.app/")));
        assert!(!within(Path::new("/Applications/OpenLive.app.old/x"), Path::new("/Applications/OpenLive.app")));
        assert!(!within(Path::new("/Applications"), Path::new("/Applications/OpenLive.app")));
        assert!(!within(Path::new("/x"), Path::new("")));
        if cfg!(any(target_os = "macos", windows)) {
            assert!(within(Path::new("/applications/openlive.app/x"), Path::new("/Applications/OpenLive.app")));
        }
    }

    #[test]
    fn blocks_linux_password_managers_by_executable() {
        for id in ["keepassxc", "bitwarden", "1password", "seahorse", "secrets"] {
            let app = AppInfo { name: id.into(), bundle_id: Some(id.into()), pid: 1, active: false };
            assert_eq!(refuse_blocked(&app).unwrap_err().code, ErrorCode::AppBlocked, "{id}");
        }
    }

    #[test]
    fn blocks_windows_password_managers_by_executable() {
        let app = AppInfo { name: "KeePassXC".into(), bundle_id: Some("KeePassXC.exe".into()), pid: 1, active: false };
        assert_eq!(refuse_blocked(&app).unwrap_err().code, ErrorCode::AppBlocked);
    }
}
