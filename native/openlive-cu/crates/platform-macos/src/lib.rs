//! The macOS backend: Accessibility for the tree and semantic actions,
//! ScreenCaptureKit for pixels, CGEvent for the input nothing else can do.
//!
//! Decisions adapted from Orca's macOS helper (main.swift; MIT, Copyright (c)
//! 2026 Lovecast Inc.; see THIRD_PARTY_NOTICES): the Chromium allowlist, the
//! AX-first click with a synthetic fallback, text replaced through AXValue
//! before keystrokes are posted, and permission checks that never prompt.
#![cfg(target_os = "macos")]

mod ax;
mod capture;
mod cg;
mod input;

use ax::{Element, Source};
use objc2::rc::Retained;
use objc2_app_kit::{NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};
use objc2_application_services::{kAXTrustedCheckOptionPrompt, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElement};
use objc2_core_foundation::{kCFRunLoopDefaultMode, CFBoolean, CFDictionary, CFNumber, CFRunLoop, CFString, CFType};
use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};
use objc2_foundation::{NSString, NSURL};
use openlive_cu_core::backend::{own_root, within, Action, Backend, Button, ClickAt, Direction, Observation, Resolved};
use openlive_cu_core::keys::Chord;
use openlive_cu_core::protocol::{ActionReport, AppInfo, Grant, Rect, WindowInfo};
use openlive_cu_core::tree::{pretty_action, render, tree_text};
use openlive_cu_core::{CuError, ErrorCode};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

const ACCESSIBILITY_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const SCREEN_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/// Per AX call. The default of six seconds lets one hung app stall a tree walk for minutes.
const AX_TIMEOUT_SECONDS: f32 = 1.0;
/// Time for a raised window to become the key window before input is posted at it.
const FOCUS_SETTLE: Duration = Duration::from_millis(250);
/// Chromium builds its accessibility tree lazily once asked; the first read after asking is otherwise empty.
const CHROMIUM_WARMUP: Duration = Duration::from_millis(400);

/// Chromium and Electron apps expose their tree only when AXManualAccessibility
/// is set. Setting it on native Cocoa apps can collapse their trees to the root,
/// so it is an allowlist, not a default. Editors stay off it: VS Code reads the
/// switch as a screen reader arriving and changes how its editor behaves.
const CHROMIUM_APPS: &[&str] = &[
    "com.google.chrome", "com.microsoft.edgemac", "com.brave.browser", "com.operasoftware.opera",
    "com.vivaldi.vivaldi", "com.github.electron", "com.tinyspeck.slackmacgap", "com.spotify.client",
    "com.hnc.discord", "com.microsoft.teams2", "notion.id",
];
const BROWSERS: &[&str] = &[
    "com.apple.safari", "org.mozilla.firefox", "company.thebrowser.browser", "app.zen-browser.zen",
    "com.google.chrome", "com.microsoft.edgemac", "com.brave.browser", "com.operasoftware.opera", "com.vivaldi.vivaldi",
];

fn starts_with_any(bundle: Option<&str>, list: &[&str]) -> bool {
    bundle.is_some_and(|b| {
        let b = b.to_lowercase();
        list.iter().any(|p| b.starts_with(p))
    })
}

/// Keep the main run loop turning: AppKit refreshes the running-app list there.
pub fn run_main_loop() -> ! {
    loop {
        // SAFETY: reading a framework constant.
        let mode = unsafe { kCFRunLoopDefaultMode };
        if CFRunLoop::run_in_mode(mode, 1.0, false).0 == 1 {
            // Finished: no sources yet. Do not spin.
            sleep(Duration::from_millis(250));
        }
    }
}

pub struct MacBackend {
    /// The elements of each window's last observation, by window id: what element indexes refer to.
    elements: HashMap<u64, Vec<Element>>,
    enhanced: HashSet<i32>,
    /// Pressed by `mouseDown` and not yet released: moves meanwhile are drags.
    held: Option<Button>,
    own_root: Option<PathBuf>,
}

impl Default for MacBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MacBackend {
    pub fn new() -> Self {
        // SAFETY: setting the global AX messaging timeout on the system-wide element.
        unsafe { AXUIElement::new_system_wide().set_messaging_timeout(AX_TIMEOUT_SECONDS) };
        MacBackend { elements: HashMap::new(), enhanced: HashSet::new(), held: None, own_root: own_root() }
    }

    fn element(&self, target: &Resolved, index: usize) -> Result<&Element, CuError> {
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
                let f = ax::frame(self.element(target, i)?).filter(|f| f.width > 0.0 && f.height > 0.0).ok_or_else(|| CuError::new(
                    ErrorCode::ElementNotClickable,
                    format!("element {i} has no position on screen; pick a parent or child with one, or use coordinates from the picture"),
                ))?;
                Ok((f.x + f.width / 2.0, f.y + f.height / 2.0))
            }
        }
    }
}

fn trusted() -> bool {
    // SAFETY: a plain status read.
    unsafe { AXIsProcessTrusted() }
}

fn require_accessibility() -> Result<(), CuError> {
    if trusted() {
        return Ok(());
    }
    Err(CuError::new(
        ErrorCode::PermissionDenied,
        "Accessibility is not allowed for OpenLive Computer Use. The user can allow it in OpenLive's Flow settings under Access; nothing here works until then.",
    ))
}

fn app_info(app: &NSRunningApplication) -> AppInfo {
    AppInfo {
        name: app.localizedName().map(|s| s.to_string()).unwrap_or_default(),
        bundle_id: app.bundleIdentifier().map(|s| s.to_string()),
        pid: app.processIdentifier(),
        active: app.isActive(),
    }
}

fn running() -> Vec<Retained<NSRunningApplication>> {
    NSWorkspace::sharedWorkspace().runningApplications().iter().collect()
}

/// OpenLive itself: this helper, or an app run from where OpenLive is installed.
fn is_own(app: &NSRunningApplication, root: Option<&Path>) -> bool {
    app.processIdentifier() == std::process::id() as i32
        || root.is_some_and(|r| app.executableURL().and_then(|u| u.path()).is_some_and(|p| within(Path::new(&p.to_string()), r)))
}

/// `None` is the app in front, or, when that is OpenLive, the app owning the
/// frontmost window that is not; `pid:<n>`, a bundle id, or a name otherwise.
fn find_app(query: Option<&str>, root: Option<&Path>) -> Result<Retained<NSRunningApplication>, CuError> {
    let not_found = |q: &str| CuError::new(ErrorCode::AppNotFound, format!("no running app matches '{q}'; call listApps for the names and bundle ids"));
    let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) else {
        if let Some(front) = NSWorkspace::sharedWorkspace().frontmostApplication().filter(|a| !is_own(a, root)) {
            return Ok(front);
        }
        // The window list runs front to back.
        return cg::windows().into_iter()
            .filter_map(|w| NSRunningApplication::runningApplicationWithProcessIdentifier(w.pid))
            .find(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular && !is_own(a, root))
            .ok_or_else(|| not_found("the app in front"));
    };
    if let Some(pid) = q.strip_prefix("pid:").and_then(|p| p.trim().parse().ok()) {
        return NSRunningApplication::runningApplicationWithProcessIdentifier(pid).ok_or_else(|| not_found(q));
    }
    let apps = running();
    let info: Vec<AppInfo> = apps.iter().map(|a| app_info(a)).collect();
    let lower = q.to_lowercase();
    let pick = |f: &dyn Fn(&AppInfo) -> bool| info.iter().position(f);
    let exact = pick(&|a| a.bundle_id.as_deref().is_some_and(|b| b.eq_ignore_ascii_case(q)))
        .or_else(|| pick(&|a| a.name.to_lowercase() == lower));
    if let Some(i) = exact {
        return Ok(apps[i].clone());
    }
    let regular: Vec<usize> = (0..apps.len()).filter(|&i| apps[i].activationPolicy() == NSApplicationActivationPolicy::Regular && info[i].name.to_lowercase().contains(&lower)).collect();
    match regular.as_slice() {
        [i] => Ok(apps[*i].clone()),
        [] => Err(not_found(q)),
        many => Err(CuError::new(ErrorCode::AppNotFound, format!(
            "'{q}' matches {}; name one by bundle id",
            many.iter().map(|&i| format!("{} ({})", info[i].name, info[i].bundle_id.as_deref().unwrap_or("no bundle id"))).collect::<Vec<_>>().join(", "),
        ))),
    }
}

fn window_number(el: &AXUIElement) -> Option<u64> {
    ax::attr(el, "AXWindowNumber").and_then(|v| v.downcast_ref::<CFNumber>().and_then(CFNumber::as_i64)).map(|n| n as u64)
}

fn frames_match(a: &Rect, b: &Rect) -> bool {
    (a.x - b.x).abs() <= 2.0 && (a.y - b.y).abs() <= 2.0 && (a.width - b.width).abs() <= 2.0 && (a.height - b.height).abs() <= 2.0
}

/// The AX element of a window the window server knows by id: by its window number, else by its frame.
fn ax_window(app: &AXUIElement, id: u64, frame: &Rect) -> Option<Element> {
    let windows = ax::elements(app, "AXWindows");
    windows.iter().find(|w| window_number(w) == Some(id))
        .or_else(|| windows.iter().find(|w| ax::frame(w).is_some_and(|f| frames_match(&f, frame))))
        .cloned()
}

/// Raise the window and bring its app forward, for input that goes wherever the focus is.
fn focus(target: &Resolved) {
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(target.app.pid) {
        app.unhide();
        #[allow(deprecated)]
        app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
    }
    // SAFETY: AX element for a live pid.
    let app_el = unsafe { AXUIElement::new_application(target.app.pid) };
    // macOS 14's cooperative activation can refuse a background helper; the AX attribute is not refused.
    ax::set_bool(&app_el, "AXFrontmost", true);
    if let Some(w) = ax_window(&app_el, target.window.id, &target.window.frame) {
        ax::perform(&w, "AXRaise");
        ax::set_bool(&w, "AXMain", true);
    }
    sleep(FOCUS_SETTLE);
}

/// Posted keystrokes go to whichever app is in front; refuse rather than type into the wrong one.
fn require_front(target: &Resolved) -> Result<(), CuError> {
    let front = NSWorkspace::sharedWorkspace().frontmostApplication().map(|a| a.processIdentifier());
    if front == Some(target.app.pid) {
        return Ok(());
    }
    Err(CuError::new(ErrorCode::WindowNotFocused, format!(
        "{} could not be brought to the front, so the keystrokes would land in another app. Ask the user to click into it, then try again.",
        target.app.name,
    )))
}

/// A posted click lands on whatever is on top at that point; refuse when that is not the target app.
fn require_hit(target: &Resolved, at: (f64, f64)) -> Result<(), CuError> {
    let mut hit: *const AXUIElement = std::ptr::null();
    // SAFETY: valid out-pointer; a non-null result is +1 retained.
    let err = unsafe { AXUIElement::new_system_wide().copy_element_at_position(at.0 as f32, at.1 as f32, std::ptr::NonNull::from(&mut hit)) };
    let owner = (!hit.is_null() && err == objc2_application_services::AXError::Success)
        // SAFETY: retained by the copy above.
        .then(|| unsafe { objc2_core_foundation::CFRetained::from_raw(std::ptr::NonNull::new_unchecked(hit.cast_mut())) })
        .and_then(|el| ax::pid(&el));
    if owner == Some(target.app.pid) {
        return Ok(());
    }
    Err(CuError::new(ErrorCode::WindowNotFocused, format!(
        "something else is on top of {} at ({:.0}, {:.0}), so the click would land there. Call getAppState again; if it is still covered, ask the user to clear it.",
        target.app.name, at.0, at.1,
    )))
}

const UNASSERTED: &str = "the element's own action ran; whether it did what was meant shows in the state below";
const POSTED: &str = "input was posted to the screen and cannot be read back; check the state below";

/// Replace the selection in the focused text element through AXValue, and read it back.
fn replace_selection(target: &Resolved, text: &str) -> Option<ActionReport> {
    // SAFETY: AX element for a live pid.
    let app = unsafe { AXUIElement::new_application(target.app.pid) };
    let el = ax::element(&app, "AXFocusedUIElement")?;
    if !ax::settable(&el, "AXValue") {
        return None;
    }
    let current = ax::attr(&el, "AXValue")?.downcast_ref::<CFString>()?.to_string();
    let units: Vec<u16> = current.encode_utf16().collect();
    let (loc, len) = ax::selected_range(&el).unwrap_or((units.len() as isize, 0));
    let start = loc.clamp(0, units.len() as isize) as usize;
    let end = (start + len.max(0) as usize).min(units.len());
    let inserted: Vec<u16> = text.encode_utf16().collect();
    let next = String::from_utf16_lossy(&[&units[..start], &inserted, &units[end..]].concat());
    if ax::set(&el, "AXValue", &CFString::from_str(&next)) != objc2_application_services::AXError::Success {
        return None;
    }
    ax::set_selected_range(&el, (start + inserted.len()) as isize, 0);
    (ax::string(&el, "AXValue")? == next).then(|| ActionReport::new("accessibility", "AXReplaceSelection", true))
}

impl Backend for MacBackend {
    fn platform(&self) -> &'static str {
        "macos"
    }

    fn unsupported(&self) -> Option<String> {
        None
    }

    fn grants(&self) -> Vec<Grant> {
        vec![
            Grant { id: "accessibility", granted: trusted(), settings_url: Some(ACCESSIBILITY_URL), detail: None },
            Grant { id: "screenRecording", granted: CGPreflightScreenCaptureAccess(), settings_url: Some(SCREEN_URL), detail: None },
        ]
    }

    fn request_grant(&mut self, id: &str) -> Result<(), CuError> {
        let url = match id {
            "accessibility" => {
                // SAFETY: a one-key options dictionary, as the API documents.
                unsafe {
                    let opts = CFDictionary::<CFString, CFType>::from_slices(&[kAXTrustedCheckOptionPrompt], &[CFBoolean::new(true).as_ref()]);
                    AXIsProcessTrustedWithOptions(Some(opts.as_opaque()));
                }
                ACCESSIBILITY_URL
            }
            "screenRecording" => {
                CGRequestScreenCaptureAccess();
                SCREEN_URL
            }
            other => return Err(CuError::invalid(format!("unknown permission '{other}'"))),
        };
        if let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) {
            NSWorkspace::sharedWorkspace().openURL(&url);
        }
        Ok(())
    }

    fn list_apps(&mut self) -> Result<Vec<AppInfo>, CuError> {
        let mut apps: Vec<AppInfo> = running().iter().filter(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular).map(|a| app_info(a)).collect();
        apps.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(apps)
    }

    fn list_windows(&mut self, app: Option<&str>) -> Result<Vec<WindowInfo>, CuError> {
        let only = app.map(|q| find_app(Some(q), None).map(|a| a.processIdentifier())).transpose()?;
        let mut bundles: HashMap<i32, Option<String>> = HashMap::new();
        Ok(cg::windows().into_iter().filter(|w| only.is_none_or(|p| p == w.pid)).map(|w| {
            let bundle_id = bundles.entry(w.pid).or_insert_with(|| {
                NSRunningApplication::runningApplicationWithProcessIdentifier(w.pid).and_then(|a| a.bundleIdentifier()).map(|s| s.to_string())
            }).clone();
            WindowInfo { id: u64::from(w.id), app_name: w.owner, bundle_id, pid: w.pid, title: w.title, frame: w.frame, on_screen: w.on_screen }
        }).collect())
    }

    fn resolve(&mut self, app: Option<&str>, window: Option<u64>) -> Result<Resolved, CuError> {
        let running = find_app(app, self.own_root.as_deref())?;
        let info = app_info(&running);
        let mine: Vec<cg::CgWindow> = cg::windows().into_iter().filter(|w| w.pid == info.pid).collect();
        // SAFETY: AX element for a live pid.
        let app_el = unsafe { AXUIElement::new_application(info.pid) };
        let chosen = match window {
            Some(id) => mine.iter().find(|w| u64::from(w.id) == id).ok_or_else(|| CuError::new(
                ErrorCode::WindowNotFound,
                format!("{} has no window {id} on screen; call listWindows for its windows", info.name),
            ))?,
            None => {
                let preferred = ["AXFocusedWindow", "AXMainWindow"].iter().filter_map(|a| ax::element(&app_el, a)).find_map(|w| {
                    let (n, f) = (window_number(&w), ax::frame(&w));
                    mine.iter().find(|c| Some(u64::from(c.id)) == n || f.is_some_and(|f| frames_match(&f, &c.frame)))
                });
                // The window list runs front to back, so its first is the one on top.
                preferred.or(mine.first()).ok_or_else(|| CuError::new(
                    ErrorCode::WindowNotFound,
                    format!("{} has no window on screen (it may be minimized, hidden, or on another Space)", info.name),
                ))?
            }
        };
        let title = chosen.title.clone().or_else(|| {
            ax_window(&app_el, u64::from(chosen.id), &chosen.frame).and_then(|w| ax::string(&w, "AXTitle")).filter(|t| !t.is_empty())
        });
        let window = WindowInfo { id: u64::from(chosen.id), app_name: info.name.clone(), bundle_id: info.bundle_id.clone(), pid: info.pid, title, frame: chosen.frame, on_screen: chosen.on_screen };
        Ok(Resolved { app: info, window })
    }

    fn observe(&mut self, target: &Resolved, screenshot: bool, max_long_edge: u32) -> Result<Observation, CuError> {
        require_accessibility()?;
        let bundle = target.app.bundle_id.as_deref();
        // SAFETY: AX element for a live pid.
        let app_el = unsafe { AXUIElement::new_application(target.app.pid) };
        if starts_with_any(bundle, CHROMIUM_APPS) && self.enhanced.insert(target.app.pid) {
            ax::set_bool(&app_el, "AXManualAccessibility", true);
            ax::set_bool(&app_el, "AXEnhancedUserInterface", true);
            sleep(CHROMIUM_WARMUP);
        }
        let window = ax_window(&app_el, target.window.id, &target.window.frame).ok_or_else(|| CuError::new(
            ErrorCode::WindowNotFound,
            format!("{}'s window is not readable through Accessibility right now; call getAppState again", target.app.name),
        ))?;
        let focused = ax::element(&app_el, "AXFocusedUIElement");
        let rendered = render(&mut Source::new(), window, focused.as_ref(), starts_with_any(bundle, BROWSERS));
        let title = target.window.title.as_deref().unwrap_or(&target.app.name);
        let tree_text = tree_text(&target.app.name, bundle, target.app.pid, title, &rendered);
        let (element_count, focused, truncated) = (rendered.records.len(), rendered.focused, rendered.truncated);
        self.elements.insert(target.window.id, rendered.records);
        let image = screenshot.then(|| capture::window(target.window.id as u32, target.window.frame, max_long_edge));
        Ok(Observation { tree_text, element_count, focused, truncated, image })
    }

    fn act(&mut self, target: &Resolved, action: &Action) -> Result<ActionReport, CuError> {
        require_accessibility()?;
        let synthetic = |name: &str| ActionReport::new("synthetic", name, false).with_detail(POSTED);
        match action {
            Action::Click { at: ClickAt::Element(i), button, count: 1 } if *button != Button::Middle => {
                let el = self.element(target, *i)?;
                let tries: &[&str] = if *button == Button::Right { &["AXShowMenu"] } else { &["AXPress", "AXConfirm", "AXOpen"] };
                if let Some(done) = tries.iter().find(|a| ax::perform(el, a)) {
                    return Ok(ActionReport::new("accessibility", *done, false).with_detail(UNASSERTED));
                }
                let at = self.point(target, ClickAt::Element(*i))?;
                focus(target);
                require_hit(target, at)?;
                input::click(at, *button, 1)?;
                Ok(synthetic("click").with_detail(format!("element {i} has no press action, so a click was posted at its centre; check the state below")))
            }
            Action::Click { at, button, count } => {
                let at = self.point(target, *at)?;
                focus(target);
                require_hit(target, at)?;
                input::click(at, *button, *count)?;
                Ok(synthetic("click"))
            }
            Action::SecondaryAction { element, action: wanted } => {
                let el = self.element(target, *element)?;
                let names = ax::actions(el);
                let Some(name) = names.iter().find(|a| a.eq_ignore_ascii_case(wanted) || pretty_action(a).eq_ignore_ascii_case(wanted.trim())) else {
                    return Err(CuError::new(ErrorCode::ActionNotSupported, format!(
                        "element {element} has no action '{wanted}'; it has: {}",
                        names.iter().map(|a| pretty_action(a)).collect::<Vec<_>>().join(", "),
                    )));
                };
                if !ax::perform(el, name) {
                    return Err(CuError::internal(format!("{name} failed on element {element}")));
                }
                Ok(ActionReport::new("accessibility", name.clone(), false).with_detail(UNASSERTED))
            }
            Action::SetValue { element, value } => set_value(self.element(target, *element)?, *element, value),
            Action::TypeText { text } => {
                if let Some(done) = replace_selection(target, text) {
                    return Ok(done);
                }
                focus(target);
                require_front(target)?;
                input::type_text(text)?;
                Ok(synthetic("typeText"))
            }
            Action::PasteText { text } => {
                if let Some(done) = replace_selection(target, text) {
                    return Ok(done);
                }
                focus(target);
                require_front(target)?;
                input::paste(text)?;
                Ok(ActionReport::new("clipboard", "paste", false).with_detail(POSTED))
            }
            Action::PressKey { chord, hotkey } => {
                if *hotkey && is_select_all(chord) && select_all(target) {
                    return Ok(ActionReport::new("accessibility", "AXSelectAll", true));
                }
                focus(target);
                require_front(target)?;
                input::press(chord)?;
                Ok(synthetic(if *hotkey { "hotkey" } else { "pressKey" }))
            }
            Action::Scroll { at, direction, pages } => {
                if let ClickAt::Element(i) = at {
                    let el = self.element(target, *i)?;
                    let name = format!("AXScroll{}ByPage", match direction { Direction::Up => "Up", Direction::Down => "Down", Direction::Left => "Left", Direction::Right => "Right" });
                    if pages.fract() == 0.0 && ax::actions(el).contains(&name) {
                        for _ in 0..(*pages as u32) {
                            ax::perform(el, &name);
                        }
                        return Ok(ActionReport::new("accessibility", name, false).with_detail(UNASSERTED));
                    }
                }
                let at = self.point(target, *at)?;
                require_hit(target, at)?;
                input::scroll(at, *direction, *pages)?;
                Ok(synthetic("scroll"))
            }
            Action::Drag { from, to } => {
                let (from, to) = (self.point(target, *from)?, self.point(target, *to)?);
                focus(target);
                require_hit(target, from)?;
                input::drag(from, to)?;
                Ok(synthetic("drag"))
            }
            Action::Move { at } => {
                let at = self.point(target, *at)?;
                require_hit(target, at)?;
                input::move_to(at, self.held)?;
                Ok(synthetic("move"))
            }
            Action::MouseDown { at, button } => {
                let at = self.point(target, *at)?;
                focus(target);
                require_hit(target, at)?;
                input::press_button(at, *button, true)?;
                self.held = Some(*button);
                Ok(synthetic("mouseDown"))
            }
            Action::MouseUp { at, button } => {
                // No hit test: a button left down breaks the user's next click wherever the pointer is.
                let at = self.point(target, *at)?;
                input::press_button(at, *button, false)?;
                self.held = None;
                Ok(synthetic("mouseUp"))
            }
        }
    }
}

/// Write the type the element already holds (a slider wants a number, a checkbox a boolean) and read it back.
fn set_value(el: &AXUIElement, index: usize, value: &str) -> Result<ActionReport, CuError> {
    if !ax::settable(el, "AXValue") {
        return Err(CuError::new(ErrorCode::ValueNotSettable, format!("element {index} does not take a value; click into it and type instead")));
    }
    let current = ax::attr(el, "AXValue");
    let number = current.as_ref().and_then(|c| c.downcast_ref::<CFNumber>()).and(value.trim().parse::<f64>().ok());
    let boolean = current.as_ref().and_then(|c| c.downcast_ref::<CFBoolean>()).and(match value.trim() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    });
    let err = match (number, boolean) {
        (Some(n), _) => ax::set(el, "AXValue", &CFNumber::new_f64(n)),
        (_, Some(b)) => ax::set_bool(el, "AXValue", b),
        _ => ax::set(el, "AXValue", &CFString::from_str(value)),
    };
    if err != objc2_application_services::AXError::Success {
        return Err(CuError::new(ErrorCode::ValueNotSettable, format!("element {index} refused the value (AX error {})", err.0)));
    }
    let back = ax::string(el, "AXValue");
    let verified = match (back.as_deref(), number, boolean) {
        (Some(b), Some(n), _) => b.parse::<f64>().is_ok_and(|v| (v - n).abs() < 1e-6),
        (Some(b), None, Some(v)) => b == if v { "1" } else { "0" },
        (Some(b), None, None) => b == value,
        (None, ..) => false,
    };
    let report = ActionReport::new("accessibility", "AXSetValue", verified);
    Ok(if verified { report } else { report.with_detail(format!("the element now reads {:?}", back.unwrap_or_default())) })
}

fn is_select_all(chord: &Chord) -> bool {
    let m = chord.modifiers;
    chord.key == "a" && m.meta && !m.ctrl && !m.alt && !m.shift
}

/// Select everything in the focused text element through the AX API, and read the selection back.
fn select_all(target: &Resolved) -> bool {
    // SAFETY: AX element for a live pid.
    let app = unsafe { AXUIElement::new_application(target.app.pid) };
    let Some(el) = ax::element(&app, "AXFocusedUIElement") else { return false };
    let Some(len) = ax::string(&el, "AXValue").map(|v| v.encode_utf16().count() as isize) else { return false };
    ax::set_selected_range(&el, 0, len) && ax::selected_range(&el) == Some((0, len))
}

/// Against this machine's real windows, read-only, and never where a grant is
/// missing (asking would prompt). Run by hand: `cargo test -p openlive-cu-macos -- --ignored`.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn reads_and_captures_the_front_window_without_changing_it() {
        if !trusted() || !CGPreflightScreenCaptureAccess() {
            eprintln!("skipped: Accessibility or Screen Recording is not granted");
            return;
        }
        let Some(w) = cg::windows().into_iter().next() else { return eprintln!("skipped: no window on screen") };
        // Rendered directly, so no Chromium accessibility switch is flipped on the app.
        let app = unsafe { AXUIElement::new_application(w.pid) };
        let window = ax_window(&app, u64::from(w.id), &w.frame).expect("the window has an AX element");
        let rendered = render(&mut Source::new(), window, None, false);
        assert!(!rendered.records.is_empty());
        println!("{}", rendered.lines.iter().take(15).cloned().collect::<Vec<_>>().join("\n"));
        let image = capture::window(w.id, w.frame, openlive_cu_core::image::MAX_LONG_EDGE).expect("captured");
        assert!(image.width().max(image.height()) <= openlive_cu_core::image::MAX_LONG_EDGE);
        assert!(image.pixels().any(|p| p.0 != [0, 0, 0, 0]), "the picture is not blank");
        let encoded = openlive_cu_core::image::encode(image).expect("encoded");
        println!("{} {}x{} {} bytes", encoded.mime, encoded.width, encoded.height, encoded.bytes.len());
    }
}
