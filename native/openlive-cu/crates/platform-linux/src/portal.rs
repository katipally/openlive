//! The bookkeeping of the xdg-desktop-portal session that gives the helper
//! the screen and the input on Wayland, kept free of D-Bus so it is tested on
//! every OS: where the restore token lives, what a portal answer means, and
//! when a session may start without the user being asked.
//!
//! One RemoteDesktop session carries both: its devices (keyboard and
//! pointer) and its screen-cast streams. The portal shows its consent dialog
//! the first time; `persist_mode` 2 asks it to remember the answer until the
//! user revokes it, and every start returns a single-use restore token that
//! starts the next session without a dialog. Where the RemoteDesktop portal
//! is missing (xdg-desktop-portal-wlr) the session is a ScreenCast one, with
//! its own token, and there is no posted input.

use openlive_cu_core::protocol::Rect;
use std::path::PathBuf;

/// RemoteDesktop device types.
pub const KEYBOARD: u32 = 1;
pub const POINTER: u32 = 2;
/// ScreenCast source type and cursor mode.
pub const MONITOR: u32 = 1;
pub const CURSOR_HIDDEN: u32 = 1;
/// Persist until the user revokes it.
pub const PERSIST_UNTIL_REVOKED: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Screen and input in one session.
    RemoteDesktop,
    /// Screen only.
    ScreenCast,
}

/// A restore token and the kind of session it restores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub kind: Kind,
    pub token: String,
}

impl Stored {
    pub fn parse(text: &str) -> Option<Stored> {
        let (kind, token) = text.trim().split_once(' ')?;
        let kind = match kind {
            "remote-desktop" => Kind::RemoteDesktop,
            "screencast" => Kind::ScreenCast,
            _ => return None,
        };
        let token = token.trim();
        // Portals hand out UUIDs; anything with whitespace or control characters is not one of theirs.
        (!token.is_empty() && token.len() <= 256 && token.chars().all(|c| c.is_ascii_graphic())).then(|| Stored { kind, token: token.to_owned() })
    }

    pub fn format(&self) -> String {
        let kind = match self.kind {
            Kind::RemoteDesktop => "remote-desktop",
            Kind::ScreenCast => "screencast",
        };
        format!("{kind} {}\n", self.token)
    }
}

/// The path OpenLive names in `OPENLIVE_CU_PORTAL_TOKEN` (its home's
/// `state/portal-token`), else, for a helper run on its own,
/// `$XDG_STATE_HOME/openlive/computer-use/portal-token`, or under
/// `~/.local/state` when that is unset, as the XDG base directory spec says.
pub fn token_path(named: Option<&str>, state_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    if let Some(n) = named.filter(|n| n.starts_with('/')) {
        return Some(PathBuf::from(n));
    }
    let base = match state_home.filter(|s| s.starts_with('/')) {
        Some(s) => PathBuf::from(s),
        None => PathBuf::from(home.filter(|h| !h.is_empty())?).join(".local").join("state"),
    };
    Some(base.join("openlive").join("computer-use").join("portal-token"))
}

/// The object path a portal request answers on, which the caller subscribes
/// to before it calls: the sender's unique name without the colon, dots as underscores.
pub fn request_path(unique_name: &str, token: &str) -> String {
    format!("/org/freedesktop/portal/desktop/request/{}/{token}", unique_name.trim_start_matches(':').replace('.', "_"))
}

/// What a `Request::Response` code means, as an error for anything but success.
pub fn response(code: u32) -> Result<(), String> {
    match code {
        0 => Ok(()),
        1 => Err("the screen sharing request was declined".into()),
        _ => Err("the screen sharing request was cancelled by the system".into()),
    }
}

/// Where the session stands.
#[derive(Debug, Clone, PartialEq)]
pub enum Phase {
    /// No session, none being asked for.
    Idle,
    /// The consent dialog is up, or a restore is under way.
    Asking,
    /// Running, with these streams; `input` when the devices were granted.
    Active { input: bool },
    /// The last attempt failed, and why.
    Failed(String),
}

impl Phase {
    /// What the Access settings show: allowed once a session runs or a token is
    /// kept to start one without asking. Never starts anything.
    pub fn granted(&self, stored: bool) -> bool {
        matches!(self, Phase::Active { .. }) || stored
    }

    /// Whether a session may be started now without anyone having asked for
    /// one: only from a kept token, which restores without a dialog.
    pub fn may_restore(&self, stored: bool) -> bool {
        stored && matches!(self, Phase::Idle | Phase::Failed(_))
    }
}

/// A stream as the portal describes it: its node, and its `position` and `size`
/// when given. Both are needed to place it; a lone stream works without.
pub fn stream(node: u32, position: Option<(i32, i32)>, size: Option<(i32, i32)>) -> crate::geom::Stream {
    let area = match (position, size) {
        (Some((x, y)), Some((w, h))) if w > 0 && h > 0 => Some(Rect { x: f64::from(x), y: f64::from(y), width: f64::from(w), height: f64::from(h) }),
        // A monitor stream with a size but no position is the only monitor shared.
        (None, Some((w, h))) if w > 0 && h > 0 => Some(Rect { x: 0.0, y: 0.0, width: f64::from(w), height: f64::from(h) }),
        _ => None,
    };
    crate::geom::Stream { node, area }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip_and_refuse_junk() {
        let s = Stored { kind: Kind::RemoteDesktop, token: "0c5e1b5a-73f4-4bb1-9e2c-1f2e3d4c5b6a".into() };
        assert_eq!(Stored::parse(&s.format()), Some(s));
        assert_eq!(Stored::parse("screencast abc").unwrap().kind, Kind::ScreenCast);
        assert_eq!(Stored::parse("remote-desktop "), None);
        assert_eq!(Stored::parse("other abc"), None);
        assert_eq!(Stored::parse("screencast a\u{7}b"), None);
        assert_eq!(Stored::parse(""), None);
    }

    #[test]
    fn the_token_lives_where_openlive_says_else_in_xdg_state() {
        assert_eq!(token_path(Some("/h/state/portal-token"), Some("/s"), Some("/home/u")).unwrap(), PathBuf::from("/h/state/portal-token"));
        // A relative name is not a place; the helper falls back as if run on its own.
        assert_eq!(token_path(Some("rel"), Some("/s"), Some("/home/u")).unwrap(), PathBuf::from("/s/openlive/computer-use/portal-token"));
        assert_eq!(token_path(None, Some("/s"), Some("/home/u")).unwrap(), PathBuf::from("/s/openlive/computer-use/portal-token"));
        assert_eq!(token_path(None, None, Some("/home/u")).unwrap(), PathBuf::from("/home/u/.local/state/openlive/computer-use/portal-token"));
        // A relative XDG_STATE_HOME is invalid by the spec and ignored.
        assert_eq!(token_path(None, Some("rel"), Some("/home/u")).unwrap(), PathBuf::from("/home/u/.local/state/openlive/computer-use/portal-token"));
        assert_eq!(token_path(None, None, None), None);
    }

    #[test]
    fn request_paths_follow_the_sender() {
        assert_eq!(request_path(":1.42", "openlive7"), "/org/freedesktop/portal/desktop/request/1_42/openlive7");
    }

    #[test]
    fn responses() {
        assert!(response(0).is_ok());
        assert!(response(1).unwrap_err().contains("declined"));
        assert!(response(2).is_err());
    }

    #[test]
    fn a_session_starts_unasked_only_from_a_kept_token() {
        assert!(!Phase::Idle.may_restore(false));
        assert!(Phase::Idle.may_restore(true));
        assert!(Phase::Failed("x".into()).may_restore(true));
        assert!(!Phase::Asking.may_restore(true));
        assert!(!Phase::Active { input: true }.may_restore(true));
        assert!(Phase::Active { input: false }.granted(false));
        assert!(Phase::Idle.granted(true));
        assert!(!Phase::Asking.granted(false));
    }

    #[test]
    fn streams_place_themselves() {
        assert_eq!(stream(5, Some((1920, 0)), Some((1280, 1024))).area, Some(Rect { x: 1920.0, y: 0.0, width: 1280.0, height: 1024.0 }));
        assert_eq!(stream(5, None, Some((800, 600))).area, Some(Rect { x: 0.0, y: 0.0, width: 800.0, height: 600.0 }));
        assert_eq!(stream(5, Some((0, 0)), None).area, None);
        assert_eq!(stream(5, Some((0, 0)), Some((0, 10))).area, None);
    }
}
