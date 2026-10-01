//! Which desktop the helper runs in, read from the environment the session
//! sets, so the answer is tested on every OS.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Display {
    X11,
    Wayland,
}

/// Wayland when the session says so or a Wayland socket is named; X11 when
/// only `DISPLAY` is. Under Wayland, `DISPLAY` is XWayland, which sees X
/// clients alone, so it never decides.
pub fn display(session_type: Option<&str>, wayland_display: Option<&str>, x_display: Option<&str>) -> Option<Display> {
    let set = |v: Option<&str>| v.is_some_and(|v| !v.trim().is_empty());
    match session_type.map(str::to_lowercase).as_deref() {
        Some("wayland") => return Some(Display::Wayland),
        Some("x11") if set(x_display) => return Some(Display::X11),
        _ => {}
    }
    if set(wayland_display) {
        Some(Display::Wayland)
    } else if set(x_display) {
        Some(Display::X11)
    } else {
        None
    }
}

/// `XDG_CURRENT_DESKTOP` is a colon-separated list (`ubuntu:GNOME`).
fn names(desktop: Option<&str>) -> impl Iterator<Item = String> + '_ {
    desktop.unwrap_or_default().split([':', ';']).map(|d| d.trim().to_lowercase())
}

/// Cinnamon derives its toolkit-accessibility setting from the screen reader
/// one and can loop rewriting both when an outsider flips `IsEnabled`, as Cua
/// Driver found (MIT, Copyright (c) 2025 Cua AI, Inc.; see THIRD_PARTY_NOTICES).
/// There the user switches accessibility on in System Settings instead.
pub fn may_enable_a11y(desktop: Option<&str>) -> bool {
    !names(desktop).any(|d| d == "cinnamon" || d == "x-cinnamon")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compositor {
    Gnome,
    Kde,
    /// sway, Hyprland, river, labwc, Wayfire, niri: xdg-desktop-portal-wlr or
    /// -hyprland, with ScreenCast but no RemoteDesktop.
    Wlroots,
    Other,
}

pub fn compositor(desktop: Option<&str>) -> Compositor {
    let all: Vec<String> = names(desktop).collect();
    let has = |n: &str| all.iter().any(|d| d == n);
    if has("gnome") || has("unity") || has("budgie") || has("pantheon") {
        Compositor::Gnome
    } else if has("kde") {
        Compositor::Kde
    } else if ["sway", "hyprland", "river", "labwc", "wayfire", "niri", "wlroots"].iter().any(|n| has(n)) {
        Compositor::Wlroots
    } else {
        Compositor::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_display_server() {
        assert_eq!(display(Some("wayland"), Some("wayland-0"), Some(":0")), Some(Display::Wayland));
        assert_eq!(display(Some("x11"), None, Some(":0")), Some(Display::X11));
        assert_eq!(display(None, Some("wayland-0"), Some(":0")), Some(Display::Wayland));
        assert_eq!(display(Some("tty"), None, Some(":1")), Some(Display::X11));
        assert_eq!(display(Some("x11"), None, Some("")), None);
        assert_eq!(display(None, None, None), None);
    }

    #[test]
    fn leaves_cinnamon_alone() {
        assert!(may_enable_a11y(Some("ubuntu:GNOME")));
        assert!(may_enable_a11y(None));
        assert!(!may_enable_a11y(Some("X-Cinnamon")));
        assert!(!may_enable_a11y(Some("GNOME:cinnamon")));
    }

    #[test]
    fn names_the_compositor() {
        assert_eq!(compositor(Some("ubuntu:GNOME")), Compositor::Gnome);
        assert_eq!(compositor(Some("KDE")), Compositor::Kde);
        assert_eq!(compositor(Some("sway")), Compositor::Wlroots);
        assert_eq!(compositor(Some("Hyprland")), Compositor::Wlroots);
        assert_eq!(compositor(None), Compositor::Other);
    }
}
