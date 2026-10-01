//! The Backend contract on Windows, method for method with the macOS backend:
//! the same element-first actions, the same refusals before posted input, the
//! same report of how each action ran and whether it was read back.

use crate::capture::Capturer;
use crate::input;
use crate::shot::Px;
use crate::uia::{self, Node, Source, Uia};
use crate::win::{self, Window};
use openlive_cu_core::backend::{own_root, within, Action, Backend, Button, ClickAt, Direction, Observation, Resolved};
use openlive_cu_core::protocol::{ActionReport, AppInfo, Grant, Rect, WindowInfo};
use openlive_cu_core::tree::{pretty_action, render, tree_text};
use openlive_cu_core::{CuError, ErrorCode};
use std::collections::HashMap;
use std::path::PathBuf;
use std::thread::sleep;
use std::time::Duration;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow, SetForegroundWindow, ShowWindow, SW_RESTORE};

/// Time for a raised window to take the keyboard before input is posted at it.
const FOCUS_SETTLE: Duration = Duration::from_millis(250);
/// Executables whose tab strips are compacted to the selected tab.
const BROWSERS: &[&str] = &["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe", "zen.exe", "librewolf.exe"];

const POSTED: &str = "input was posted to the screen and cannot be read back; check the state below";

pub struct WindowsBackend {
    uia: Result<Uia, CuError>,
    capturer: Capturer,
    /// The elements of each window's last observation, by window id: what element indexes refer to.
    elements: HashMap<u64, Vec<Node>>,
    own_root: Option<PathBuf>,
}

impl Default for WindowsBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowsBackend {
    /// Call on the thread that will serve requests: COM is joined to the multithreaded apartment here.
    pub fn new() -> Self {
        // SAFETY: process-wide settings made before any window is touched.
        unsafe {
            // The embedded manifest declares this already; a build without it (a test binary) still gets physical pixels.
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        WindowsBackend { uia: Uia::new(), capturer: Capturer::default(), elements: HashMap::new(), own_root: own_root() }
    }

    fn uia(&self) -> Result<&Uia, CuError> {
        self.uia.as_ref().map_err(Clone::clone)
    }

    fn element(&self, target: &Resolved, index: usize) -> Result<&Node, CuError> {
        self.elements.get(&target.window.id).and_then(|e| e.get(index)).ok_or_else(|| CuError::new(
            ErrorCode::ElementNotFound,
            format!("element {index} is not in the last state of this window; call getAppState again and use a fresh index"),
        ))
    }

    /// The point a pointer action lands on: an element's centre, read fresh, or the given point.
    fn point(&self, target: &Resolved, at: ClickAt) -> Result<(f64, f64), CuError> {
        match at {
            ClickAt::Point(x, y) => Ok((x, y)),
            ClickAt::Element(i) => {
                let f = uia::bounds(&self.element(target, i)?.el).ok_or_else(|| CuError::new(
                    ErrorCode::ElementNotClickable,
                    format!("element {i} has no position on screen; pick a parent or child with one, or use coordinates from the picture"),
                ))?;
                Ok((f.x + f.width / 2.0, f.y + f.height / 2.0))
            }
        }
    }

    /// OpenLive itself: this helper, or an app run from where OpenLive is installed.
    fn is_own(&self, pid: u32, procs: &HashMap<u32, win::Process>) -> bool {
        pid == std::process::id()
            || self.own_root.as_deref().is_some_and(|root| procs.get(&pid).and_then(|p| p.path.as_deref()).is_some_and(|p| within(p, root)))
    }

    /// Restore and raise the window. SetForegroundWindow is refused to a
    /// process that is not in front (the documented foreground lock), so UI
    /// Automation's SetFocus, which the app's own provider carries out, is
    /// the second try. Nothing else: no AttachThreadInput, no fake Alt press.
    fn focus(&self, hwnd: HWND) {
        // SAFETY: plain window calls on a handle that may have closed; each fails harmlessly then.
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            if win::foreground() == Some(hwnd) {
                return;
            }
            let _ = SetForegroundWindow(hwnd);
        }
        if win::foreground() != Some(hwnd) {
            if let Ok(uia) = self.uia() {
                uia::focus(uia, hwnd);
            }
        }
        sleep(FOCUS_SETTLE);
    }
}

fn hwnd(target: &Resolved) -> HWND {
    win::hwnd(target.window.id)
}

fn rect(px: Px) -> Rect {
    Rect { x: f64::from(px.left), y: f64::from(px.top), width: f64::from(px.width()), height: f64::from(px.height()) }
}

fn px(r: Rect) -> Px {
    Px { left: r.x.round() as i32, top: r.y.round() as i32, right: (r.x + r.width).round() as i32, bottom: (r.y + r.height).round() as i32 }
}

fn app_info(pid: u32, p: &win::Process, front: Option<u32>) -> AppInfo {
    AppInfo { name: p.name.clone(), bundle_id: p.exe_name.clone(), pid: pid as i32, active: front == Some(pid) }
}

fn window_info(w: &Window, p: &win::Process) -> WindowInfo {
    WindowInfo { id: win::id(w.hwnd), app_name: p.name.clone(), bundle_id: p.exe_name.clone(), pid: w.pid as i32, title: w.title.clone(), frame: rect(w.frame), on_screen: true }
}

fn not_found(q: &str) -> CuError {
    CuError::new(ErrorCode::AppNotFound, format!("no running app matches '{q}'; call listApps for the names and executables"))
}

/// An app by `pid:<n>`, its executable (with or without `.exe`), or its name; a unique partial name last.
fn find_app(query: &str, windows: &[Window], procs: &HashMap<u32, win::Process>) -> Result<u32, CuError> {
    let q = query.trim();
    if let Some(pid) = q.strip_prefix("pid:").and_then(|p| p.trim().parse::<u32>().ok()) {
        return Ok(pid);
    }
    let lower = q.to_lowercase();
    let mut pids: Vec<u32> = windows.iter().map(|w| w.pid).collect();
    pids.dedup();
    let exe_matches = |p: &win::Process| p.exe_name.as_deref().is_some_and(|e| {
        let e = e.to_lowercase();
        e == lower || e.strip_suffix(".exe") == Some(lower.as_str())
    });
    let exact = pids.iter().copied().find(|pid| procs.get(pid).is_some_and(|p| exe_matches(p) || p.name.to_lowercase() == lower));
    if let Some(pid) = exact {
        return Ok(pid);
    }
    let mut partial: Vec<u32> = pids.into_iter().filter(|pid| procs.get(pid).is_some_and(|p| p.name.to_lowercase().contains(&lower))).collect();
    partial.sort_unstable();
    partial.dedup();
    match partial.as_slice() {
        [pid] => Ok(*pid),
        [] => Err(not_found(q)),
        many => Err(CuError::new(ErrorCode::AppNotFound, format!(
            "'{q}' matches {}; name one by its executable",
            many.iter().map(|pid| { let p = &procs[pid]; format!("{} ({})", p.name, p.exe_name.as_deref().unwrap_or("no executable")) }).collect::<Vec<_>>().join(", "),
        ))),
    }
}

/// Posted keystrokes go to whichever window is in front; refuse rather than type into the wrong app.
fn require_front(target: &Resolved) -> Result<(), CuError> {
    if win::foreground().is_some_and(|h| win::app_pid(h) == target.window.pid as u32 || h == hwnd(target)) {
        return Ok(());
    }
    Err(CuError::new(ErrorCode::WindowNotFocused, format!(
        "Windows kept {} in the background (it only lets the app in front hand over the keyboard), so the keystrokes would land in another app. Ask the user to click into it, then try again.",
        target.app.name,
    )))
}

/// A posted click lands on whatever is on top at that point; refuse when that is not the target app.
fn require_hit(target: &Resolved, at: (f64, f64)) -> Result<(), CuError> {
    if win::root_at(at.0, at.1).is_some_and(|(root, pid)| root == hwnd(target) || pid == target.window.pid as u32) {
        return Ok(());
    }
    Err(CuError::new(ErrorCode::WindowNotFocused, format!(
        "something else is on top of {} at ({:.0}, {:.0}), so the click would land there. Call getAppState again; if it is still covered, ask the user to clear it.",
        target.app.name, at.0, at.1,
    )))
}

/// What Windows itself forbids, said plainly, before any input is posted.
fn require_reachable(target: &Resolved) -> Result<(), CuError> {
    if !win::input_desktop() {
        return Err(CuError::new(ErrorCode::PermissionDenied, "The screen is locked or a Windows security prompt is showing, so input cannot reach any app. Ask the user to unlock or answer the prompt, then try again."));
    }
    if win::uipi_blocked(target.window.pid as u32) {
        return Err(CuError::new(ErrorCode::PermissionDenied, uipi_message(&target.app.name)));
    }
    Ok(())
}

fn uipi_message(app: &str) -> String {
    format!("{app} runs as administrator, and Windows does not let an app that is not (OpenLive) read or operate it: input to it is dropped and its accessibility tree is withheld. Ask the user to do this part themselves, or to reopen {app} without administrator rights.")
}

impl Backend for WindowsBackend {
    fn platform(&self) -> &'static str {
        "windows"
    }

    fn unsupported(&self) -> Option<String> {
        win::session_zero().then(|| "OpenLive Computer Use is running in session 0, the service session, which has no desktop to see or operate. It has to run in the signed-in user's session.".into())
    }

    /// Windows has no per-app grant to give, so both read as allowed while there is a desktop to work on.
    fn grants(&self) -> Vec<Grant> {
        let desktop = !win::session_zero() && win::input_desktop();
        vec![
            Grant { id: "accessibility", granted: desktop, settings_url: None, detail: None },
            Grant { id: "screenRecording", granted: desktop, settings_url: None, detail: None },
        ]
    }

    fn request_grant(&mut self, id: &str) -> Result<(), CuError> {
        match id {
            "accessibility" | "screenRecording" => Ok(()),
            other => Err(CuError::invalid(format!("unknown permission '{other}'"))),
        }
    }

    fn list_apps(&mut self) -> Result<Vec<AppInfo>, CuError> {
        let windows = win::windows();
        let procs = win::processes(windows.iter().map(|w| w.pid));
        let front = win::foreground().map(win::app_pid);
        let mut apps: Vec<AppInfo> = procs.iter().map(|(pid, p)| app_info(*pid, p, front)).collect();
        apps.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(apps)
    }

    fn list_windows(&mut self, app: Option<&str>) -> Result<Vec<WindowInfo>, CuError> {
        let windows = win::windows();
        let procs = win::processes(windows.iter().map(|w| w.pid));
        let only = app.map(|q| find_app(q, &windows, &procs)).transpose()?;
        Ok(windows.iter().filter(|w| only.is_none_or(|p| p == w.pid)).map(|w| window_info(w, &procs[&w.pid])).collect())
    }

    fn resolve(&mut self, app: Option<&str>, window: Option<u64>) -> Result<Resolved, CuError> {
        let windows = win::windows();
        let procs = win::processes(windows.iter().map(|w| w.pid));
        let front = win::foreground();
        let chosen = match app.map(str::trim).filter(|q| !q.is_empty()) {
            // The window in front, or, when that is OpenLive's own, the frontmost one that is not.
            None => {
                let front_window = windows.iter().find(|w| Some(w.hwnd) == front).filter(|w| !self.is_own(w.pid, &procs));
                front_window.or_else(|| windows.iter().find(|w| !self.is_own(w.pid, &procs))).ok_or_else(|| not_found("the app in front"))?
            }
            Some(q) => {
                let pid = find_app(q, &windows, &procs)?;
                let mine: Vec<&Window> = windows.iter().filter(|w| w.pid == pid).collect();
                let name = procs.get(&pid).map_or_else(|| format!("pid {pid}"), |p| p.name.clone());
                match window {
                    Some(id) => mine.into_iter().find(|w| win::id(w.hwnd) == id).ok_or_else(|| CuError::new(
                        ErrorCode::WindowNotFound,
                        format!("{name} has no window {id} on screen; call listWindows for its windows"),
                    ))?,
                    None => mine.iter().find(|w| Some(w.hwnd) == front).or(mine.first()).copied().ok_or_else(|| CuError::new(
                        ErrorCode::WindowNotFound,
                        format!("{name} has no window on screen (it may be minimized, or on another virtual desktop)"),
                    ))?,
                }
            }
        };
        let p = &procs[&chosen.pid];
        let front_pid = front.map(win::app_pid);
        Ok(Resolved { app: app_info(chosen.pid, p, front_pid), window: window_info(chosen, p) })
    }

    fn observe(&mut self, target: &Resolved, screenshot: bool, max_long_edge: u32) -> Result<Observation, CuError> {
        let h = hwnd(target);
        // SAFETY: a plain read.
        if !unsafe { IsWindow(Some(h)) }.as_bool() {
            return Err(CuError::new(ErrorCode::WindowNotFound, format!("{}'s window has closed; call getAppState again", target.app.name)));
        }
        let uia = self.uia()?;
        let root = uia.window(h)?;
        let focused = uia.focused();
        let exe = target.app.bundle_id.as_deref().map(str::to_lowercase);
        let browser = exe.as_deref().is_some_and(|e| BROWSERS.contains(&e));
        let rendered = render(&mut Source { uia }, root, focused.as_ref(), browser);
        let title = target.window.title.as_deref().unwrap_or(&target.app.name);
        let mut tree_text = tree_text(&target.app.name, target.app.bundle_id.as_deref(), target.app.pid, title, &rendered);
        if win::uipi_blocked(target.window.pid as u32) {
            tree_text.push_str(&format!("\n\n{}", uipi_message(&target.app.name)));
        }
        let (element_count, focused, truncated) = (rendered.records.len(), rendered.focused, rendered.truncated);
        self.elements.insert(target.window.id, rendered.records);
        let image = screenshot.then(|| self.capturer.window(h, px(target.window.frame), max_long_edge));
        Ok(Observation { tree_text, element_count, focused, truncated, image })
    }

    fn act(&mut self, target: &Resolved, action: &Action) -> Result<ActionReport, CuError> {
        require_reachable(target)?;
        let h = hwnd(target);
        let synthetic = |name: &str| ActionReport::new("synthetic", name, false).with_detail(POSTED);
        match action {
            Action::Click { at: ClickAt::Element(i), button: button @ (Button::Left | Button::Right), count: 1 } => {
                let el = &self.element(target, *i)?.el;
                let done = if *button == Button::Right { uia::show_menu(el) } else { uia::press(el) };
                if let Some(report) = done {
                    return Ok(report);
                }
                let at = self.point(target, ClickAt::Element(*i))?;
                self.focus(h);
                require_hit(target, at)?;
                input::click(at, *button, 1)?;
                Ok(synthetic("click").with_detail(format!("element {i} has no action of its own, so a click was posted at its centre; check the state below")))
            }
            Action::Click { at, button, count } => {
                let at = self.point(target, *at)?;
                self.focus(h);
                require_hit(target, at)?;
                input::click(at, *button, *count)?;
                Ok(synthetic("click"))
            }
            Action::SecondaryAction { element, action: wanted } => {
                let el = &self.element(target, *element)?.el;
                let names = crate::roles::actions(uia::patterns(el));
                let Some(name) = names.iter().find(|a| a.eq_ignore_ascii_case(wanted) || pretty_action(a).eq_ignore_ascii_case(wanted.trim())) else {
                    return Err(CuError::new(ErrorCode::ActionNotSupported, format!(
                        "element {element} has no action '{wanted}'; it has: {}",
                        names.iter().map(|a| pretty_action(a)).collect::<Vec<_>>().join(", "),
                    )));
                };
                let done = match name.as_str() {
                    "AXPress" => uia::press(el),
                    "AXExpand" => uia::expand_or_collapse(el, Some(true)),
                    "AXCollapse" => uia::expand_or_collapse(el, Some(false)),
                    "AXShowMenu" => uia::show_menu(el),
                    "AXScrollUpByPage" => uia::scroll(el, true, false, 1),
                    "AXScrollDownByPage" => uia::scroll(el, true, true, 1),
                    "AXScrollLeftByPage" => uia::scroll(el, false, false, 1),
                    "AXScrollRightByPage" => uia::scroll(el, false, true, 1),
                    _ => None,
                };
                done.ok_or_else(|| CuError::internal(format!("{} failed on element {element}", pretty_action(name))))
            }
            Action::SetValue { element, value } => uia::set_value(&self.element(target, *element)?.el, *element, value),
            Action::TypeText { text } => {
                self.focus(h);
                require_front(target)?;
                input::type_text(text)?;
                Ok(synthetic("typeText"))
            }
            Action::PasteText { text } => {
                self.focus(h);
                require_front(target)?;
                input::paste(text)?;
                Ok(ActionReport::new("clipboard", "paste", false).with_detail(POSTED))
            }
            Action::PressKey { chord, hotkey } => {
                self.focus(h);
                require_front(target)?;
                input::press(chord)?;
                Ok(synthetic(if *hotkey { "hotkey" } else { "pressKey" }))
            }
            Action::Scroll { at, direction, pages } => {
                if let ClickAt::Element(i) = at {
                    let el = &self.element(target, *i)?.el;
                    let p = uia::patterns(el);
                    let vertical = matches!(direction, Direction::Up | Direction::Down);
                    let able = if vertical { p.scroll_vertical } else { p.scroll_horizontal };
                    if pages.fract() == 0.0 && able {
                        if let Some(report) = uia::scroll(el, vertical, matches!(direction, Direction::Down | Direction::Right), *pages as u32) {
                            return Ok(report);
                        }
                    }
                }
                let at = self.point(target, *at)?;
                require_hit(target, at)?;
                input::scroll(at, *direction, *pages)?;
                Ok(synthetic("scroll"))
            }
            Action::Drag { from, to } => {
                let (from, to) = (self.point(target, *from)?, self.point(target, *to)?);
                self.focus(h);
                require_hit(target, from)?;
                input::drag(from, to)?;
                Ok(synthetic("drag"))
            }
            Action::Move { at } => {
                let at = self.point(target, *at)?;
                require_hit(target, at)?;
                input::move_to(at)?;
                Ok(synthetic("move"))
            }
            Action::MouseDown { at, button } => {
                let at = self.point(target, *at)?;
                self.focus(h);
                require_hit(target, at)?;
                input::press_button(at, *button, true)?;
                Ok(synthetic("mouseDown"))
            }
            Action::MouseUp { at, button } => {
                // No hit test: a button left down breaks the user's next click wherever the pointer is.
                let at = self.point(target, *at)?;
                input::press_button(at, *button, false)?;
                Ok(synthetic("mouseUp"))
            }
        }
    }
}

/// Against this machine's real windows, read-only: handshake-level facts, the
/// window list, and one tree read. Nothing is clicked or typed. CI's Windows
/// runner has an interactive session; elsewhere the checks that need a desktop skip.
/// Run: `cargo test -p openlive-cu-windows -- --ignored`.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn reads_the_desktop_without_changing_it() {
        let mut b = WindowsBackend::new();
        assert_eq!(b.platform(), "windows");
        println!("unsupported: {:?}", b.unsupported());
        let grants = b.grants();
        assert_eq!(grants.iter().map(|g| g.id).collect::<Vec<_>>(), ["accessibility", "screenRecording"]);
        if b.unsupported().is_some() {
            return eprintln!("skipped the rest: no desktop in this session");
        }
        let windows = b.list_windows(None).expect("listed");
        println!("{} windows", windows.len());
        for w in &windows {
            assert!(w.frame.width >= 48.0 && w.frame.height >= 48.0, "{w:?}");
        }
        assert!(b.list_apps().is_ok());
        let Some(w) = windows.first() else { return eprintln!("skipped the tree: no window on screen") };
        let target = b.resolve(Some(&format!("pid:{}", w.pid)), Some(w.id)).expect("resolved");
        let seen = b.observe(&target, false, openlive_cu_core::image::MAX_LONG_EDGE).expect("observed");
        println!("{}", seen.tree_text.lines().take(15).collect::<Vec<_>>().join("\n"));
        assert!(seen.element_count > 0);
    }
}
