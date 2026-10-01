//! The wire contract. One JSON object per line in each direction:
//!
//! ```text
//! -> {"id":1,"token":"…","method":"getAppState","params":{"app":"Safari"}}
//! <- {"id":1,"ok":true,"result":{…}}
//! <- {"id":1,"ok":false,"error":{"code":"element_not_found","message":"…"}}
//! ```
//!
//! Field names are camelCase on the wire because the client is TypeScript.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped on any incompatible change. The client refuses a helper that answers another.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(default)]
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Ok { id: u64, ok: bool, result: Value },
    Err { id: u64, ok: bool, error: CuError },
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Response::Ok { id, ok: true, result }
    }
    pub fn err(id: u64, error: CuError) -> Self {
        Response::Err { id, ok: false, error }
    }
}

/// Every failure a client can act on, by name. The message says what to do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthorized,
    InvalidRequest,
    InvalidArgument,
    UnknownMethod,
    UnsupportedPlatform,
    PermissionDenied,
    AppNotFound,
    AppBlocked,
    WindowNotFound,
    WindowNotFocused,
    ElementNotFound,
    ElementNotClickable,
    ValueNotSettable,
    ActionNotSupported,
    ScreenshotFailed,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CuError {
    pub code: ErrorCode,
    pub message: String,
}

impl CuError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CuError { code, message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl std::fmt::Display for CuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for CuError {}

// ── results ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    pub protocol: u32,
    pub version: &'static str,
    pub platform: &'static str,
    /// False on a backend that is not built yet; `reason` says so.
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub pid: u32,
}

/// One OS grant the helper needs, with where the user turns it on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// `accessibility` or `screenRecording`.
    pub id: &'static str,
    pub granted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_url: Option<&'static str>,
    /// How to grant it where there is no settings page to open (Linux).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub active: bool,
}

/// Desktop coordinates as the window server reports them: points on macOS,
/// physical pixels on Windows (the helper is per-monitor DPI aware). Window ids
/// are the platform's own (CGWindowID, HWND, XID), the same ids ol-input's
/// window tools take, so the two can be mixed in one session.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u64,
    pub app_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    pub pid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(flatten)]
    pub frame: Rect,
    pub on_screen: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    /// Base64.
    pub data: String,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// One window as the model sees it: the indexed tree first, the pixels second.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub app: AppInfo,
    pub window: WindowInfo,
    pub tree_text: String,
    pub element_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_element: Option<usize>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<Screenshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot_error: Option<String>,
}

/// How an action was carried out, and whether its effect was read back.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReport {
    /// `accessibility` (an AX/UIA/AT-SPI action), `synthetic` (posted input) or `clipboard`.
    pub path: &'static str,
    pub action_name: String,
    /// True only when the changed state was read back and matched.
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ActionReport {
    pub fn new(path: &'static str, action_name: impl Into<String>, verified: bool) -> Self {
        ActionReport { path, action_name: action_name.into(), verified, detail: None }
    }
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub action: ActionReport,
    /// The window after the action. Absent when it could not be read back; the action itself still ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Snapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_error: Option<String>,
}
