//! The Backend contract on Linux, method for method with the macOS and
//! Windows backends: the same element-first actions, the same refusals before
//! posted input, the same report of how each action ran and whether it was
//! read back. AT-SPI is the tree on both display servers; X11 and Wayland
//! differ in where windows are, how pixels are read and how input is posted.

use crate::atspi::{Frame, Node, Source, A11y};
use crate::clipboard::{self, Previous, XClipboard};
use crate::codes;
use crate::desktop::{self, Compositor, Display};
use crate::ewmh::{self, Candidate};
use crate::roles;
use crate::wayland::Portal;
use crate::x11::{self, XWindow, X11};
use ::image::imageops::{self, FilterType};
use atspi_common::State;
use openlive_cu_core::backend::{own_root, within, Action, Backend, Button, ClickAt, Direction, Observation, Resolved};
use openlive_cu_core::geometry::fit;
use openlive_cu_core::keys::{Chord, Modifiers};
use openlive_cu_core::protocol::{ActionReport, AppInfo, Grant, Rect, WindowInfo};
use openlive_cu_core::tree::{pretty_action, render, tree_text};
use openlive_cu_core::{CuError, ErrorCode};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::thread::sleep;
use std::time::Duration;
use zbus::Connection;

/// Time for a raised window to take the keyboard before input is posted at it.
const FOCUS_SETTLE: Duration = Duration::from_millis(250);
/// Between the parts of a click, as on the other backends.
const PAUSE: Duration = Duration::from_millis(50);
/// How long the target app gets to read the clipboard before the user's own content goes back.
const PASTE_SETTLE: Duration = Duration::from_millis(300);
/// Fewer elements than this in a Chromium window means its renderer accessibility is off.
const CHROMIUM_EMPTY: usize = 8;
const DRAG_STEPS: u32 = 10;

const POSTED: &str = "input was posted to the screen and cannot be read back; check the state below";

/// One window, wherever it came from.
#[derive(Debug, Clone)]
struct Win {
    info: WindowInfo,
    app: AppInfo,
    /// The AT-SPI frame, on Wayland (on X11 it is matched when needed).
    frame: Option<Node>,
    /// Whether the frame's position is real. On Wayland a native client
    /// cannot know where its window is; only XWayland clients can.
    placed: bool,
    active: bool,
}

pub struct LinuxBackend {
    display: Option<Display>,
    desktop: Option<String>,
    session: Result<Connection, CuError>,
    a11y: Option<Result<A11y, String>>,
    x11: Option<Result<X11, CuError>>,
    clipboard: Option<XClipboard>,
    portal: Option<Portal>,
    /// The elements of each window's last observation, by window id: what element indexes refer to.
    elements: HashMap<u64, Vec<Node>>,
    /// The element that had focus in each window's last observation.
    focus: HashMap<u64, usize>,
    own_root: Option<PathBuf>,
}

impl Default for LinuxBackend {
    fn default() -> Self {
        Self::new()
    }
}

/// What /proc says of a process: its app id (see `ewmh::app_id`), its short name, its executable.
fn process(pid: i32) -> (Option<String>, Option<String>, Option<PathBuf>) {
    let dir = PathBuf::from(format!("/proc/{pid}"));
    let exe = std::fs::read_link(dir.join("exe")).ok();
    let cmdline: Vec<String> = std::fs::read(dir.join("cmdline")).unwrap_or_default().split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
    let comm = std::fs::read_to_string(dir.join("comm")).ok().map(|c| c.trim().to_owned()).filter(|c| !c.is_empty());
    (ewmh::app_id(exe.as_deref(), &cmdline), comm, exe)
}

/// A stable id for an AT-SPI window, inside the 53 bits a JavaScript number holds exactly.
fn frame_id(n: &Node) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (n.bus(), n.path()).hash(&mut h);
    h.finish() & ((1 << 53) - 1)
}

fn not_found(q: &str) -> CuError {
    CuError::new(ErrorCode::AppNotFound, format!("no running app matches '{q}'; call listApps for the names and app ids"))
}

fn pasted(lost_image: bool) -> ActionReport {
    let report = ActionReport::new("clipboard", "paste", false);
    if lost_image {
        report.with_detail("the text was pasted, but the clipboard held something other than text before, which could not be put back; check the state below")
    } else {
        report.with_detail(POSTED)
    }
}

fn portal_error(why: String) -> CuError {
    CuError::new(ErrorCode::PermissionDenied, why)
}

impl LinuxBackend {
    pub fn new() -> Self {
        let env = |k: &str| std::env::var(k).ok();
        let display = desktop::display(env("XDG_SESSION_TYPE").as_deref(), env("WAYLAND_DISPLAY").as_deref(), env("DISPLAY").as_deref());
        LinuxBackend {
            display,
            desktop: env("XDG_CURRENT_DESKTOP"),
            session: crate::bus::session(),
            a11y: None,
            x11: None,
            clipboard: None,
            portal: (display == Some(Display::Wayland)).then(Portal::new),
            elements: HashMap::new(),
            focus: HashMap::new(),
            own_root: own_root(),
        }
    }

    fn compositor(&self) -> Compositor {
        desktop::compositor(self.desktop.as_deref())
    }

    /// The accessibility bus, connected on first use and again after a failure.
    fn a11y(&mut self) -> Result<&A11y, String> {
        if !matches!(self.a11y, Some(Ok(_))) {
            let session = self.session.as_ref().map_err(|e| e.message.clone())?;
            self.a11y = Some(crate::bus::a11y(session).map(|conn| A11y { conn }));
        }
        match self.a11y.as_ref() {
            Some(Ok(a)) => Ok(a),
            Some(Err(e)) => Err(e.clone()),
            None => unreachable!("set above"),
        }
    }

    fn x11(&mut self) -> Result<&X11, CuError> {
        if !matches!(self.x11, Some(Ok(_))) {
            self.x11 = Some(X11::connect());
        }
        self.x11.as_ref().expect("set above").as_ref().map_err(Clone::clone)
    }

    fn a11y_enabled(&self) -> bool {
        self.session.as_ref().is_ok_and(crate::bus::a11y_enabled)
    }

    /// Accessibility switched on for the session, unless the desktop is one where an outsider must not flip it.
    fn enable_a11y(&self) {
        if let (Ok(s), true) = (&self.session, desktop::may_enable_a11y(self.desktop.as_deref())) {
            if !crate::bus::a11y_enabled(s) {
                let _ = crate::bus::enable_a11y(s);
            }
        }
    }

    fn a11y_guidance(&self) -> String {
        if desktop::may_enable_a11y(self.desktop.as_deref()) {
            "Allow switches on the desktop's accessibility support (org.a11y.Status). Apps started before that need a restart to show their controls. Chromium and Electron apps also need --force-renderer-accessibility, or ACCESSIBILITY_ENABLED=1 in their environment.".into()
        } else {
            "On Cinnamon, turn on accessibility in System Settings > Accessibility; OpenLive leaves that switch to the desktop there. Apps started before that need a restart.".into()
        }
    }

    fn screen_guidance(&self) -> Option<String> {
        if self.display != Some(Display::Wayland) {
            return None;
        }
        let mut text = "Allow shows the system's screen sharing dialog once: share every screen, and allow remote control so OpenLive can click and type. The approval is kept until revoked in the system's privacy settings.".to_owned();
        if self.compositor() == Compositor::Wlroots {
            text.push_str(" This compositor's portal shares the screen but has no remote control, so OpenLive works through the apps' own accessibility actions and cannot post clicks or keys.");
        }
        if !crate::pipewire::available() {
            text.push_str(" PipeWire's library (libpipewire-0.3) is missing, so no pictures can be taken until it is installed.");
        }
        Some(text)
    }

    fn app_info(&self, pid: Option<i32>, fallback_name: &str, active: bool) -> AppInfo {
        let (id, comm, _) = pid.map(process).unwrap_or_default();
        let name = if fallback_name.trim().is_empty() { comm.clone().or(id.clone()).unwrap_or_else(|| "unknown".into()) } else { fallback_name.to_owned() };
        AppInfo { name, bundle_id: id, pid: pid.unwrap_or(0), active }
    }

    /// OpenLive itself: this helper, or an app run from where OpenLive is installed.
    fn is_own(&self, pid: i32) -> bool {
        pid == std::process::id() as i32
            || self.own_root.as_deref().is_some_and(|root| process(pid).2.is_some_and(|exe| within(&exe, root)))
    }

    /// Every window, front to back where the display server says so.
    fn windows(&mut self) -> Result<Vec<Win>, CuError> {
        match self.display {
            Some(Display::X11) => {
                let x = self.x11()?;
                let active = x.focused();
                let list: Vec<XWindow> = x.windows();
                Ok(list.into_iter().map(|w| {
                    let name = w.class.as_ref().map(|c| c.1.clone()).unwrap_or_default();
                    let app = self.app_info(w.pid, &name, active == Some(w.id));
                    let info = WindowInfo { id: u64::from(w.id), app_name: app.name.clone(), bundle_id: app.bundle_id.clone(), pid: app.pid, title: w.title.clone(), frame: w.frame, on_screen: !w.hidden };
                    Win { info, app, frame: None, placed: true, active: active == Some(w.id) }
                }).collect())
            }
            Some(Display::Wayland) => {
                let frames = self.a11y().map_err(|e| CuError::new(ErrorCode::PermissionDenied, format!("{e}. On Wayland the window list comes from accessibility, so nothing can be listed without it.")))?.frames();
                let desktop = self.portal.as_ref().and_then(Portal::desktop);
                let mut wins: Vec<Win> = frames.into_iter().map(|f: Frame| {
                    let active = f.states.contains(State::Active);
                    let app = self.app_info(f.pid, &f.app_name, active);
                    let size = f.extents.unwrap_or(Rect { x: 0.0, y: 0.0, width: 0.0, height: 0.0 });
                    let placed = size.x != 0.0 || size.y != 0.0;
                    // Unplaced, the window is shown as the whole desktop it is somewhere on.
                    let frame = if placed { size } else { desktop.unwrap_or(size) };
                    let on_screen = f.states.contains(State::Showing) && !f.states.contains(State::Iconified);
                    let title = Some(f.title.clone()).filter(|t| !t.trim().is_empty());
                    let info = WindowInfo { id: frame_id(&f.node), app_name: app.name.clone(), bundle_id: app.bundle_id.clone(), pid: app.pid, title, frame, on_screen };
                    Win { info, app, frame: Some(f.node), placed, active }
                }).collect();
                wins.sort_by_key(|w| (!w.active, !w.info.on_screen));
                Ok(wins)
            }
            None => Err(CuError::new(ErrorCode::UnsupportedPlatform, self.unsupported().unwrap_or_default())),
        }
    }

    /// The pid of an app named by `pid:<n>`, its app id, or its name; a unique partial name last.
    fn find_app(&self, query: &str, wins: &[Win]) -> Result<i32, CuError> {
        let q = query.trim();
        if let Some(pid) = q.strip_prefix("pid:").and_then(|p| p.trim().parse::<i32>().ok()) {
            return Ok(pid);
        }
        let lower = q.to_lowercase();
        let id_matches = |a: &AppInfo| a.bundle_id.as_deref().is_some_and(|b| b == lower || b.strip_suffix(".exe") == Some(lower.as_str()));
        if let Some(w) = wins.iter().find(|w| id_matches(&w.app) || w.app.name.to_lowercase() == lower) {
            return Ok(w.app.pid);
        }
        let mut partial: Vec<&AppInfo> = wins.iter().map(|w| &w.app).filter(|a| a.name.to_lowercase().contains(&lower)).collect();
        partial.sort_by_key(|a| a.pid);
        partial.dedup_by_key(|a| a.pid);
        match partial.as_slice() {
            [a] => Ok(a.pid),
            [] => Err(not_found(q)),
            many => Err(CuError::new(ErrorCode::AppNotFound, format!(
                "'{q}' matches {}; name one by its app id",
                many.iter().map(|a| format!("{} ({})", a.name, a.bundle_id.as_deref().unwrap_or("no app id"))).collect::<Vec<_>>().join(", "),
            ))),
        }
    }

    fn win(&mut self, target: &Resolved) -> Option<Win> {
        self.windows().ok()?.into_iter().find(|w| w.info.id == target.window.id)
    }

    /// The AT-SPI frame of a window: its own on Wayland, the best match on X11.
    fn frame_node(&mut self, target: &Resolved) -> Option<Node> {
        if self.display == Some(Display::Wayland) {
            return self.win(target).and_then(|w| w.frame);
        }
        let a11y = self.a11y().ok()?;
        let frames = a11y.frames();
        let candidates: Vec<Candidate> = frames.iter().map(|f| Candidate {
            title: f.title.clone(),
            frame: f.extents,
            same_pid: f.pid.is_some() && f.pid == Some(target.app.pid),
            active: f.states.contains(State::Active),
        }).collect();
        ewmh::best_frame(target.window.title.as_deref(), &target.window.frame, target.app.active, &candidates).map(|i| frames[i].node.clone())
    }

    fn element(&self, target: &Resolved, index: usize) -> Result<&Node, CuError> {
        self.elements.get(&target.window.id).and_then(|e| e.get(index)).ok_or_else(|| CuError::new(
            ErrorCode::ElementNotFound,
            format!("element {index} is not in the last state of this window; call getAppState again and use a fresh index"),
        ))
    }

    /// Whether element positions read as screen positions in this window.
    fn placed(&mut self, target: &Resolved) -> bool {
        self.display == Some(Display::X11) || self.win(target).is_some_and(|w| w.placed)
    }

    /// The point a pointer action lands on: an element's centre, read fresh, or the given point.
    fn point(&mut self, target: &Resolved, at: ClickAt) -> Result<(f64, f64), CuError> {
        let i = match at {
            ClickAt::Point(x, y) => return Ok((x, y)),
            ClickAt::Element(i) => i,
        };
        if !self.placed(target) {
            return Err(CuError::new(ErrorCode::ElementNotClickable, format!(
                "on Wayland {} does not say where its window is, so element {i} cannot be aimed at; use its position in the picture instead",
                target.app.name,
            )));
        }
        let node = self.element(target, i)?.clone();
        let a11y = self.a11y().map_err(CuError::internal)?;
        let f = a11y.extents(&node).ok_or_else(|| CuError::new(
            ErrorCode::ElementNotClickable,
            format!("element {i} has no position on screen; pick a parent or child with one, or use coordinates from the picture"),
        ))?;
        Ok((f.x + f.width / 2.0, f.y + f.height / 2.0))
    }

    /// Raise the window and give it the keyboard: `_NET_ACTIVE_WINDOW` on
    /// X11; on Wayland only the app's own GrabFocus, since no client may
    /// activate another's window. Nothing else.
    fn focus(&mut self, target: &Resolved) {
        if let Some(Ok(x)) = self.x11.as_ref().filter(|_| self.display == Some(Display::X11)) {
            let id = target.window.id as u32;
            if x.focused() != Some(id) {
                x.activate(id);
                sleep(FOCUS_SETTLE);
            }
            return;
        }
        if let Some(frame) = self.frame_node(target) {
            if let Ok(a11y) = self.a11y() {
                if !a11y.states(&frame).contains(State::Active) && a11y.grab_focus(&frame) {
                    sleep(FOCUS_SETTLE);
                }
            }
        }
    }

    /// Posted keystrokes go to whichever window has the keyboard; refuse rather than type into the wrong app.
    fn require_front(&mut self, target: &Resolved) -> Result<(), CuError> {
        let front = match self.display {
            Some(Display::X11) => {
                let focused = self.x11()?.focused();
                let wins = self.windows().unwrap_or_default();
                focused == Some(target.window.id as u32) || wins.iter().any(|w| w.active && w.app.pid == target.app.pid && w.app.pid != 0)
            }
            _ => self.frame_node(target).is_some_and(|f| self.a11y().is_ok_and(|a| a.states(&f).contains(State::Active))),
        };
        if front {
            return Ok(());
        }
        let why = if self.display == Some(Display::Wayland) { "Wayland only lets the user switch windows" } else { "the window manager kept it in the background" };
        Err(CuError::new(ErrorCode::WindowNotFocused, format!(
            "{} is not the window in front ({why}), so the keystrokes would land in another app. Ask the user to click into it, then try again.",
            target.app.name,
        )))
    }

    /// A posted click lands on whatever is on top at that point; refuse when that is not the target app.
    /// Wayland names no window at a point, so there the picture, which shows what is on top, is the check.
    fn require_hit(&mut self, target: &Resolved, at: (f64, f64)) -> Result<(), CuError> {
        if self.display != Some(Display::X11) {
            return Ok(());
        }
        let wins = self.x11()?.windows();
        let hit = x11::window_at(&wins, at);
        let pid = |id: u32| wins.iter().find(|w| w.id == id).and_then(|w| w.pid);
        if hit.is_some_and(|h| u64::from(h) == target.window.id || (pid(h).is_some() && pid(h) == Some(target.app.pid))) {
            return Ok(());
        }
        Err(CuError::new(ErrorCode::WindowNotFocused, format!(
            "something else is on top of {} at ({:.0}, {:.0}), so the click would land there. Call getAppState again; if it is still covered, ask the user to clear it.",
            target.app.name, at.0, at.1,
        )))
    }

    fn portal(&self) -> Result<&Portal, CuError> {
        self.portal.as_ref().ok_or_else(|| CuError::internal("no portal session outside Wayland"))
    }

    // ── posted input, per display server ────────────────────────────────────

    fn move_to(&mut self, p: (f64, f64)) -> Result<(), CuError> {
        match self.display {
            Some(Display::X11) => self.x11()?.move_to(p),
            _ => self.portal()?.pointer_to(p.0, p.1).map_err(portal_error),
        }
    }

    fn button(&mut self, button: Button, down: bool) -> Result<(), CuError> {
        match self.display {
            Some(Display::X11) => self.x11()?.button(codes::x_button(button), down),
            _ => self.portal()?.button(codes::evdev_button(button), down).map_err(portal_error),
        }
    }

    fn click(&mut self, at: (f64, f64), button: Button, count: u8) -> Result<(), CuError> {
        if self.display == Some(Display::X11) {
            return self.x11()?.click(at, codes::x_button(button), count);
        }
        self.move_to(at)?;
        sleep(PAUSE);
        for _ in 0..count {
            self.button(button, true)?;
            sleep(PAUSE);
            self.button(button, false)?;
            sleep(PAUSE);
        }
        Ok(())
    }

    fn drag(&mut self, from: (f64, f64), to: (f64, f64)) -> Result<(), CuError> {
        if self.display == Some(Display::X11) {
            return self.x11()?.drag(from, to);
        }
        let point = |t: f64| (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
        self.move_to(from)?;
        sleep(PAUSE);
        self.button(Button::Left, true)?;
        sleep(PAUSE);
        let moved = (1..=DRAG_STEPS).try_for_each(|step| {
            sleep(Duration::from_millis(15));
            self.move_to(point(f64::from(step) / f64::from(DRAG_STEPS)))
        });
        // Released even when a move failed: a button left down breaks the user's next click.
        let released = self.button(Button::Left, false);
        moved.and(released)
    }

    fn scroll(&mut self, at: (f64, f64), direction: Direction, pages: f64) -> Result<(), CuError> {
        let notches = codes::notches(pages);
        if self.display == Some(Display::X11) {
            return self.x11()?.scroll(at, codes::wheel_button(direction), notches);
        }
        self.move_to(at)?;
        sleep(PAUSE);
        let (axis, sign) = match direction {
            Direction::Up => (0, -1),
            Direction::Down => (0, 1),
            Direction::Left => (1, -1),
            Direction::Right => (1, 1),
        };
        self.portal()?.axis(axis, sign * notches as i32).map_err(portal_error)
    }

    /// Keysyms pressed in turn, with `held` (modifier keysyms) down around them all.
    fn keys(&mut self, held: &[u32], keysyms: &[u32]) -> Result<(), CuError> {
        if self.display == Some(Display::X11) {
            return self.x11()?.press_keysyms(held, keysyms);
        }
        let portal = self.portal()?;
        let mut down: Vec<u32> = Vec::new();
        let run = (|| -> Result<(), String> {
            for m in held {
                portal.keysym(*m, true)?;
                down.push(*m);
            }
            for (i, k) in keysyms.iter().enumerate() {
                portal.keysym(*k, true)?;
                portal.keysym(*k, false)?;
                if (i + 1) % 16 == 0 {
                    sleep(Duration::from_millis(8));
                }
            }
            Ok(())
        })();
        // Modifiers always come back up: a stuck control key breaks the user's next keystroke.
        for m in down.iter().rev() {
            let _ = portal.keysym(*m, false);
        }
        run.map_err(portal_error)
    }

    fn chord(&mut self, chord: &Chord) -> Result<(), CuError> {
        let key = codes::key_keysym(&chord.key).ok_or_else(|| CuError::invalid(format!("unknown key '{}'", chord.key)))?;
        self.keys(&codes::modifier_keysyms(chord.modifiers), &[key])
    }

    /// The element with keyboard focus in the window: the one the last
    /// observation saw, if it still has it, else a fresh search.
    fn focused_element(&mut self, target: &Resolved) -> Option<Node> {
        let last = self.focus.get(&target.window.id).and_then(|i| self.elements.get(&target.window.id)?.get(*i)).cloned();
        let a11y = self.a11y().ok()?;
        if let Some(n) = last.filter(|n| a11y.states(n).contains(State::Focused)) {
            return Some(n);
        }
        let frame = self.frame_node(target)?;
        self.a11y().ok()?.focused_in(&frame)
    }

    fn paste(&mut self, target: &Resolved, text: &str) -> Result<ActionReport, CuError> {
        let ctrl_v = Chord { modifiers: Modifiers { ctrl: true, ..Default::default() }, key: "v".into() };
        if self.display == Some(Display::X11) {
            let clip = match self.clipboard.take() {
                Some(c) => c,
                None => XClipboard::start().map_err(|e| CuError::internal(format!("the clipboard could not be opened: {e}")))?,
            };
            let previous = clip.read();
            if !clip.own(text) {
                self.clipboard = Some(clip);
                return Err(CuError::internal("another app is holding the clipboard; try again in a moment"));
            }
            let pressed = self.chord(&ctrl_v);
            sleep(PASTE_SETTLE);
            let lost_image = previous == Previous::Unreadable;
            clip.restore(previous);
            self.clipboard = Some(clip);
            pressed?;
            return Ok(pasted(lost_image));
        }
        let portal_input = self.portal.as_ref().is_some_and(Portal::has_input);
        if clipboard::wl_clipboard() && portal_input {
            let previous = clipboard::wl_read();
            if clipboard::wl_write(text) {
                let pressed = self.chord(&ctrl_v);
                sleep(PASTE_SETTLE);
                let lost_image = previous == Previous::Unreadable;
                clipboard::wl_restore(previous);
                pressed?;
                return Ok(pasted(lost_image));
            }
        }
        self.focus(target);
        self.require_front(target)?;
        self.keys(&[], &codes::typed(text))?;
        Ok(ActionReport::new("synthetic", "typeText", false).with_detail(
            "Wayland lets only the focused app set the clipboard and wl-clipboard (wl-copy) is not installed, so the text was typed instead; check the state below",
        ))
    }

    fn observation_without_tree(&mut self, target: &Resolved, why: &str, screenshot: bool, max: u32) -> Observation {
        let title = target.window.title.as_deref().unwrap_or(&target.app.name);
        let id = target.app.bundle_id.as_ref().map(|b| format!("{b}, ")).unwrap_or_default();
        let tree_text = format!("App: {} ({id}pid {})\nWindow: \"{title}\"\n\n{why}", target.app.name, target.app.pid);
        Observation { tree_text, element_count: 0, focused: None, truncated: false, image: screenshot.then(|| self.capture(target, max)) }
    }

    fn capture(&mut self, target: &Resolved, max: u32) -> Result<::image::RgbaImage, String> {
        let frame = target.window.frame;
        let img = match self.display {
            Some(Display::X11) => self.x11().map_err(|e| e.message)?.capture(frame)?,
            _ => self.portal.as_ref().ok_or("no portal")?.capture(frame)?,
        };
        let (w, h) = fit(img.width(), img.height(), max);
        Ok(if (w, h) == img.dimensions() { img } else { imageops::resize(&img, w, h, FilterType::Triangle) })
    }
}

impl Backend for LinuxBackend {
    fn platform(&self) -> &'static str {
        "linux"
    }

    fn unsupported(&self) -> Option<String> {
        if self.display.is_none() {
            return Some("there is no graphical session here (neither WAYLAND_DISPLAY nor DISPLAY is set); OpenLive Computer Use needs to run inside the user's desktop session".into());
        }
        self.session.as_ref().err().map(|e| e.message.clone())
    }

    /// Reads only: nothing here prompts or starts a session.
    fn grants(&self) -> Vec<Grant> {
        // IsEnabled answers only when the accessibility bus launcher runs, so it covers both.
        let a11y = self.a11y_enabled();
        let screen = match &self.portal {
            Some(p) => p.phase().granted(p.stored()),
            None => self.display.is_some(),
        };
        vec![
            Grant { id: "accessibility", granted: a11y, settings_url: None, detail: (!a11y).then(|| self.a11y_guidance()) },
            Grant { id: "screenRecording", granted: screen, settings_url: None, detail: if screen { None } else { self.screen_guidance() } },
        ]
    }

    fn request_grant(&mut self, id: &str) -> Result<(), CuError> {
        match id {
            "accessibility" => {
                self.enable_a11y();
                self.a11y = None;
                Ok(())
            }
            "screenRecording" => {
                if let Some(p) = &self.portal {
                    p.ask();
                }
                Ok(())
            }
            other => Err(CuError::invalid(format!("unknown permission '{other}'"))),
        }
    }

    fn list_apps(&mut self) -> Result<Vec<AppInfo>, CuError> {
        let mut apps: Vec<AppInfo> = Vec::new();
        for w in self.windows()? {
            match apps.iter_mut().find(|a| a.pid == w.app.pid && a.name == w.app.name) {
                Some(a) => a.active |= w.app.active,
                None => apps.push(w.app),
            }
        }
        apps.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(apps)
    }

    fn list_windows(&mut self, app: Option<&str>) -> Result<Vec<WindowInfo>, CuError> {
        let wins = self.windows()?;
        let only = app.map(|q| self.find_app(q, &wins)).transpose()?;
        Ok(wins.into_iter().filter(|w| only.is_none_or(|p| p == w.app.pid)).map(|w| w.info).collect())
    }

    fn resolve(&mut self, app: Option<&str>, window: Option<u64>) -> Result<Resolved, CuError> {
        // A kept approval is brought back before the frame is decided: on Wayland the frame may be the desktop it shares.
        if let Some(p) = self.portal.as_ref().filter(|p| p.stored()) {
            p.restore_quietly();
        }
        let wins = self.windows()?;
        let chosen = match app.map(str::trim).filter(|q| !q.is_empty()) {
            // The window in front, or, when that is OpenLive's own, the frontmost one that is not.
            None => wins.iter().find(|w| w.active && !self.is_own(w.app.pid))
                .or_else(|| wins.iter().find(|w| w.info.on_screen && !self.is_own(w.app.pid)))
                .ok_or_else(|| not_found("the app in front"))?,
            Some(q) => {
                let pid = self.find_app(q, &wins)?;
                let mine: Vec<&Win> = wins.iter().filter(|w| w.app.pid == pid).collect();
                let name = mine.first().map_or_else(|| format!("pid {pid}"), |w| w.app.name.clone());
                match window {
                    Some(id) => mine.into_iter().find(|w| w.info.id == id).ok_or_else(|| CuError::new(
                        ErrorCode::WindowNotFound,
                        format!("{name} has no window {id} on screen; call listWindows for its windows"),
                    ))?,
                    None => mine.iter().find(|w| w.active).or_else(|| mine.iter().find(|w| w.info.on_screen)).or(mine.first()).copied().ok_or_else(|| CuError::new(
                        ErrorCode::WindowNotFound,
                        format!("{name} has no window on screen (it may be minimized, or on another workspace)"),
                    ))?,
                }
            }
        };
        Ok(Resolved { app: chosen.app.clone(), window: chosen.info.clone() })
    }

    fn observe(&mut self, target: &Resolved, screenshot: bool, max_long_edge: u32) -> Result<Observation, CuError> {
        self.enable_a11y();
        if let Err(why) = self.a11y() {
            let note = format!("No accessibility tree: {why}. {}", self.a11y_guidance());
            return Ok(self.observation_without_tree(target, &note, screenshot, max_long_edge));
        }
        let Some(root) = self.frame_node(target) else {
            let note = format!("{} shows no accessibility tree for this window. It may not support accessibility (older toolkits do not), or it started before accessibility was switched on and needs a restart. Work from the picture.", target.app.name);
            return Ok(self.observation_without_tree(target, &note, screenshot, max_long_edge));
        };
        let placed = self.placed(target);
        let a11y = self.a11y().map_err(CuError::internal)?;
        let toolkit = a11y.toolkit(&root);
        let browser = target.app.bundle_id.as_deref().is_some_and(|b| roles::BROWSERS.contains(&b));
        let marker = Node::focus_marker();
        let rendered = render(&mut Source::new(a11y), root, Some(&marker), browser);
        let title = target.window.title.as_deref().unwrap_or(&target.app.name);
        let mut text = tree_text(&target.app.name, target.app.bundle_id.as_deref(), target.app.pid, title, &rendered);
        if toolkit.as_deref() == Some("Chromium") && rendered.records.len() < CHROMIUM_EMPTY {
            text.push_str(&format!("\n\n{} is built on Chromium, which shows its controls to accessibility only when started with --force-renderer-accessibility (or with ACCESSIBILITY_ENABLED=1 in its environment). Ask the user to restart it that way; until then, work from the picture.", target.app.name));
        }
        if !placed {
            text.push_str(&format!("\n\nOn Wayland {} does not say where its window is, so the picture shows the whole screen and x, y are positions in it. Elements act through their own actions; to aim at one by position, use the picture.", target.app.name));
        }
        let (element_count, focused, truncated) = (rendered.records.len(), rendered.focused, rendered.truncated);
        self.elements.insert(target.window.id, rendered.records);
        match focused {
            Some(i) => self.focus.insert(target.window.id, i),
            None => self.focus.remove(&target.window.id),
        };
        let image = screenshot.then(|| self.capture(target, max_long_edge));
        Ok(Observation { tree_text: text, element_count, focused, truncated, image })
    }

    fn act(&mut self, target: &Resolved, action: &Action) -> Result<ActionReport, CuError> {
        let synthetic = |name: &str| ActionReport::new("synthetic", name, false).with_detail(POSTED);
        match action {
            Action::Click { at: ClickAt::Element(i), button: button @ (Button::Left | Button::Right), count: 1 } => {
                let node = self.element(target, *i)?.clone();
                if let Ok(a11y) = self.a11y() {
                    let f = a11y.facts(&node);
                    let done = if *button == Button::Right {
                        roles::index_of(&f.actions, "AXShowMenu", f.states).and_then(|k| a11y.press(&node, k, &f.actions[k]))
                    } else {
                        let selected = roles::is_selectable_item(f.role).then(|| a11y.select(&node)).flatten();
                        selected.or_else(|| roles::press_index(&f.actions).and_then(|k| a11y.press(&node, k, &f.actions[k])))
                    };
                    if let Some(report) = done {
                        return Ok(report);
                    }
                }
                let at = self.point(target, ClickAt::Element(*i))?;
                self.focus(target);
                self.require_hit(target, at)?;
                self.click(at, *button, 1)?;
                Ok(synthetic("click").with_detail(format!("element {i} has no action of its own, so a click was posted at its centre; check the state below")))
            }
            Action::Click { at, button, count } => {
                let at = self.point(target, *at)?;
                self.focus(target);
                self.require_hit(target, at)?;
                self.click(at, *button, *count)?;
                Ok(synthetic("click"))
            }
            Action::SecondaryAction { element, action: wanted } => {
                let node = self.element(target, *element)?.clone();
                let a11y = self.a11y().map_err(CuError::internal)?;
                let f = a11y.facts(&node);
                let names = roles::actions(&f.actions, f.states);
                let Some(name) = names.iter().find(|a| a.eq_ignore_ascii_case(wanted) || pretty_action(a).eq_ignore_ascii_case(wanted.trim())) else {
                    return Err(CuError::new(ErrorCode::ActionNotSupported, format!(
                        "element {element} has no action '{wanted}'; it has: {}",
                        names.iter().map(|a| pretty_action(a)).collect::<Vec<_>>().join(", "),
                    )));
                };
                let k = roles::index_of(&f.actions, name, f.states).ok_or_else(|| CuError::internal(format!("{} vanished from element {element}", pretty_action(name))))?;
                a11y.press(&node, k, &f.actions[k]).ok_or_else(|| CuError::internal(format!("{} failed on element {element}", pretty_action(name))))
            }
            Action::SetValue { element, value } => {
                let node = self.element(target, *element)?.clone();
                self.a11y().map_err(CuError::internal)?.set_value(&node, *element, value)
            }
            Action::TypeText { text } => {
                if let Some(n) = self.focused_element(target) {
                    if let Some(done) = self.a11y().ok().and_then(|a| a.insert(&n, text)) {
                        return Ok(done);
                    }
                }
                self.focus(target);
                self.require_front(target)?;
                self.keys(&[], &codes::typed(text))?;
                Ok(synthetic("typeText"))
            }
            Action::PasteText { text } => {
                if let Some(n) = self.focused_element(target) {
                    if let Some(done) = self.a11y().ok().and_then(|a| a.insert(&n, text)) {
                        return Ok(done);
                    }
                }
                self.focus(target);
                self.require_front(target)?;
                self.paste(target, text)
            }
            Action::PressKey { chord, hotkey } => {
                let m = chord.modifiers;
                if *hotkey && chord.key == "a" && m.ctrl && !m.meta && !m.alt && !m.shift {
                    if let Some(n) = self.focused_element(target) {
                        if self.a11y().is_ok_and(|a| a.select_all(&n)) {
                            return Ok(ActionReport::new("accessibility", "selectAll", true));
                        }
                    }
                }
                self.focus(target);
                self.require_front(target)?;
                self.chord(chord)?;
                Ok(synthetic(if *hotkey { "hotkey" } else { "pressKey" }))
            }
            Action::Scroll { at, direction, pages } => {
                let at = self.point(target, *at)?;
                self.require_hit(target, at)?;
                self.scroll(at, *direction, *pages)?;
                Ok(synthetic("scroll"))
            }
            Action::Drag { from, to } => {
                let (from, to) = (self.point(target, *from)?, self.point(target, *to)?);
                self.focus(target);
                self.require_hit(target, from)?;
                self.drag(from, to)?;
                Ok(synthetic("drag"))
            }
            Action::Move { at } => {
                let at = self.point(target, *at)?;
                self.require_hit(target, at)?;
                self.move_to(at)?;
                Ok(synthetic("move"))
            }
            Action::MouseDown { at, button } => {
                let at = self.point(target, *at)?;
                self.focus(target);
                self.require_hit(target, at)?;
                self.move_to(at)?;
                sleep(PAUSE);
                self.button(*button, true)?;
                Ok(synthetic("mouseDown"))
            }
            Action::MouseUp { at, button } => {
                // No hit test: a button left down breaks the user's next click wherever the pointer is.
                let at = self.point(target, *at)?;
                self.move_to(at)?;
                sleep(PAUSE);
                self.button(*button, false)?;
                Ok(synthetic("mouseUp"))
            }
        }
    }
}

/// Against this session's real desktop, read-only: handshake-level facts, the
/// window list, and one tree read. Nothing is clicked or typed. CI's Linux job
/// runs it under Xvfb with an accessibility bus; elsewhere what needs a
/// desktop skips. Run: `cargo test -p openlive-cu-linux -- --ignored`.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn reads_the_desktop_without_changing_it() {
        let mut b = LinuxBackend::new();
        assert_eq!(b.platform(), "linux");
        if let Some(why) = b.unsupported() {
            return eprintln!("skipped: {why}");
        }
        let grants = b.grants();
        assert_eq!(grants.iter().map(|g| g.id).collect::<Vec<_>>(), ["accessibility", "screenRecording"]);
        let windows = b.list_windows(None).expect("listed");
        println!("{} windows", windows.len());
        assert!(b.list_apps().is_ok());
        let Some(w) = windows.first() else { return eprintln!("skipped the tree: no window on screen") };
        let target = b.resolve(Some(&format!("pid:{}", w.pid)), Some(w.id)).expect("resolved");
        let seen = b.observe(&target, b.display == Some(Display::X11), openlive_cu_core::image::MAX_LONG_EDGE).expect("observed");
        println!("{}", seen.tree_text.lines().take(20).collect::<Vec<_>>().join("\n"));
        if let Some(Err(why)) = &seen.image {
            println!("no picture: {why}");
        }
    }
}
