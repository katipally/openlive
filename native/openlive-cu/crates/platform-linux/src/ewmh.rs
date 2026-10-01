//! Window facts as X11 and /proc give them, parsed without a display so they
//! are tested on every OS: EWMH properties, the visible frame of a window,
//! which window is on top at a point, which AT-SPI frame is which X window,
//! and the executable name an app goes by.

use openlive_cu_core::protocol::Rect;
use std::path::Path;

/// left, right, top, bottom, as `_NET_FRAME_EXTENTS` and `_GTK_FRAME_EXTENTS` order them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Extents {
    pub left: u32,
    pub right: u32,
    pub top: u32,
    pub bottom: u32,
}

pub fn extents(values: &[u32]) -> Option<Extents> {
    match values {
        [left, right, top, bottom, ..] => Some(Extents { left: *left, right: *right, top: *top, bottom: *bottom }),
        _ => None,
    }
}

/// What the user sees of a window: its client area grown by the decorations
/// the window manager draws (`_NET_FRAME_EXTENTS`) and shrunk by the shadow a
/// client-side-decorated window draws around itself (`_GTK_FRAME_EXTENTS`).
pub fn visible_frame(client: Rect, wm: Extents, shadow: Extents) -> Rect {
    let f = |v: u32| f64::from(v);
    let x = client.x - f(wm.left) + f(shadow.left);
    let y = client.y - f(wm.top) + f(shadow.top);
    let width = (client.width + f(wm.left) + f(wm.right) - f(shadow.left) - f(shadow.right)).max(1.0);
    let height = (client.height + f(wm.top) + f(wm.bottom) - f(shadow.top) - f(shadow.bottom)).max(1.0);
    Rect { x, y, width, height }
}

/// `WM_CLASS`: two NUL-terminated strings, instance then class.
pub fn wm_class(bytes: &[u8]) -> Option<(String, String)> {
    let mut parts = bytes.split(|b| *b == 0).map(|p| String::from_utf8_lossy(p).into_owned());
    let instance = parts.next().filter(|s| !s.is_empty())?;
    let class = parts.next().filter(|s| !s.is_empty()).unwrap_or_else(|| instance.clone());
    Some((instance, class))
}

/// A text property (`_NET_WM_NAME`, `WM_NAME`), without trailing NULs.
pub fn text(bytes: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(bytes).trim_end_matches('\0').trim().to_owned();
    (!s.is_empty()).then_some(s)
}

pub fn contains(r: &Rect, x: f64, y: f64) -> bool {
    x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

/// The first window, front to back, whose frame holds the point. O(n).
pub fn topmost_at<T: Copy>(front_to_back: &[(T, Rect)], x: f64, y: f64) -> Option<T> {
    front_to_back.iter().find(|(_, r)| contains(r, x, y)).map(|(id, _)| *id)
}

/// The name an app's process goes by, lower case: the executable's file
/// name, or for an interpreter (`python3 /usr/bin/secrets`, `mono KeePass.exe`)
/// the script it runs. Flatpak and Snap executables keep their own names.
pub fn app_id(exe: Option<&Path>, cmdline: &[String]) -> Option<String> {
    let base = |p: &str| Path::new(p).file_name().map(|n| n.to_string_lossy().to_lowercase());
    let exe_name = exe.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_lowercase())
        .or_else(|| cmdline.first().and_then(|c| base(c)))?;
    // A replaced binary reads "name (deleted)" in /proc.
    let exe_name = exe_name.trim_end_matches(" (deleted)").to_owned();
    const INTERPRETERS: &[&str] = &["python", "perl", "ruby", "mono", "java", "node", "gjs", "bash", "sh"];
    if INTERPRETERS.iter().any(|i| exe_name == *i || exe_name.strip_prefix(i).is_some_and(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'))) {
        if let Some(script) = cmdline.iter().skip(1).find(|a| !a.starts_with('-')).and_then(|a| base(a)) {
            return Some(script);
        }
    }
    Some(exe_name)
}

/// An AT-SPI frame offered as the accessible side of an X window.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub title: String,
    pub frame: Option<Rect>,
    pub same_pid: bool,
    pub active: bool,
}

/// Which frame is the X window: the same process first, then a frame in the
/// same place, then the same title, then the active one. `None` when nothing
/// is plausible. O(n).
pub fn best_frame(title: Option<&str>, frame: &Rect, active: bool, candidates: &[Candidate]) -> Option<usize> {
    let near = |r: &Option<Rect>| r.is_some_and(|r| {
        // Server-side decorations put the AT-SPI frame inside the X frame, by a title bar at most.
        (r.x - frame.x).abs() <= 64.0 && (r.y - frame.y).abs() <= 64.0 && (r.width - frame.width).abs() <= 64.0 && (r.height - frame.height).abs() <= 96.0
    });
    let score = |c: &Candidate| {
        let titled = title.is_some_and(|t| !t.is_empty() && c.title == t);
        let s = (c.same_pid as u32) * 8 + (near(&c.frame) as u32) * 4 + (titled as u32) * 2 + (active && c.active) as u32;
        // A frame that matches on nothing but the process is still the only one an app with one window has.
        (s >= 4 || (c.same_pid && (titled || near(&c.frame) || candidates.iter().filter(|o| o.same_pid).count() == 1))).then_some(s)
    };
    candidates.iter().enumerate().filter_map(|(i, c)| score(c).map(|s| (s, i))).max_by_key(|(s, i)| (*s, std::cmp::Reverse(*i))).map(|(_, i)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLIENT: Rect = Rect { x: 100.0, y: 80.0, width: 800.0, height: 600.0 };

    #[test]
    fn frames_grow_by_decorations_and_shrink_by_shadows() {
        let wm = extents(&[2, 2, 30, 2]).unwrap();
        assert_eq!(visible_frame(CLIENT, wm, Extents::default()), Rect { x: 98.0, y: 50.0, width: 804.0, height: 632.0 });
        let shadow = extents(&[24, 24, 20, 28]).unwrap();
        assert_eq!(visible_frame(CLIENT, Extents::default(), shadow), Rect { x: 124.0, y: 100.0, width: 752.0, height: 552.0 });
        assert_eq!(extents(&[1, 2]), None);
    }

    #[test]
    fn parses_class_and_titles() {
        assert_eq!(wm_class(b"keepassxc\0KeePassXC\0"), Some(("keepassxc".into(), "KeePassXC".into())));
        assert_eq!(wm_class(b"xterm\0"), Some(("xterm".into(), "xterm".into())));
        assert_eq!(wm_class(b""), None);
        assert_eq!(text(b"Inbox \xe2\x80\x94 Mail\0").as_deref(), Some("Inbox \u{2014} Mail"));
        assert_eq!(text(b"\0"), None);
    }

    #[test]
    fn the_front_window_wins_the_point() {
        let windows = [(1u32, Rect { x: 0.0, y: 0.0, width: 100.0, height: 100.0 }), (2, Rect { x: 0.0, y: 0.0, width: 500.0, height: 500.0 })];
        assert_eq!(topmost_at(&windows, 50.0, 50.0), Some(1));
        assert_eq!(topmost_at(&windows, 200.0, 50.0), Some(2));
        assert_eq!(topmost_at(&windows, 100.0, 50.0), Some(2));
        assert_eq!(topmost_at(&windows, 600.0, 50.0), None);
    }

    #[test]
    fn names_an_app_by_its_executable_or_script() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(app_id(Some(Path::new("/usr/bin/keepassxc")), &s(&["keepassxc"])).as_deref(), Some("keepassxc"));
        assert_eq!(app_id(Some(Path::new("/usr/bin/python3.12")), &s(&["python3", "-O", "/app/bin/secrets"])).as_deref(), Some("secrets"));
        assert_eq!(app_id(Some(Path::new("/usr/bin/mono")), &s(&["mono", "/opt/KeePass/KeePass.exe"])).as_deref(), Some("keepass.exe"));
        assert_eq!(app_id(Some(Path::new("/opt/1Password/1password (deleted)")), &[]).as_deref(), Some("1password"));
        assert_eq!(app_id(None, &s(&["/snap/bitwarden/123/bitwarden"])).as_deref(), Some("bitwarden"));
        assert_eq!(app_id(Some(Path::new("/usr/bin/pythonista")), &s(&["pythonista", "x"])).as_deref(), Some("pythonista"));
        assert_eq!(app_id(None, &[]), None);
    }

    #[test]
    fn matches_an_x_window_to_its_accessible_frame() {
        let frame = Rect { x: 98.0, y: 50.0, width: 804.0, height: 632.0 };
        let c = |title: &str, at: Option<Rect>, same_pid: bool| Candidate { title: title.into(), frame: at, same_pid, active: false };
        let inside = Some(Rect { x: 100.0, y: 80.0, width: 800.0, height: 600.0 });
        // Two windows of one app: the one in the same place wins over the same title elsewhere.
        let cands = [c("Doc", Some(Rect { x: 900.0, y: 0.0, width: 300.0, height: 300.0 }), true), c("Other", inside, true)];
        assert_eq!(best_frame(Some("Doc"), &frame, false, &cands), Some(1));
        // A flatpak's pids differ: place and title still find it.
        assert_eq!(best_frame(Some("Doc"), &frame, false, &[c("Doc", inside, false)]), Some(0));
        // An app's only frame is it, wherever the toolkit says it is.
        assert_eq!(best_frame(None, &frame, false, &[c("", None, true)]), Some(0));
        // Nothing alike.
        assert_eq!(best_frame(Some("Doc"), &frame, false, &[c("Else", None, false)]), None);
    }
}
