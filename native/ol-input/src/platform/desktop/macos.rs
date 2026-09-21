//! macOS capture, window metadata and pointer control.
//!
//! Window metadata comes from `CGWindowListCopyWindowInfo` and
//! `NSWorkspace`, never from a capture, so reading the foreground app costs
//! no screen-recording permission. Window *management* and selected text go
//! through the accessibility API, which the hook already holds the grant for.

use std::ffi::{c_void, CStr};
use std::os::raw::c_char;
use std::process::Command;
use std::ptr;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send, AnyThread};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
#[allow(deprecated)]
use objc2_core_graphics::{
    CGDataProvider, CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayIsMain, CGDisplayMode,
    CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventType, CGGetActiveDisplayList,
    CGImage, CGMouseButton, CGScrollEventUnit, CGWindowImageOption, CGWindowListCopyWindowInfo,
    CGWindowListCreateImage, CGWindowListOption,
};
use objc2_foundation::{NSArray, NSData, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
    VNRequestTextRecognitionLevel,
};

use crate::capture::{Bitmap, Display};
use crate::control::Button;
use crate::coords::{ScreenPoint, Shot};
use crate::ocr::ShotBox;
use crate::platform::macos::{event_source, CFRelease};
use crate::window::WindowInfo;

/// Accessibility value types, from AXValue.h.
const AX_VALUE_CG_POINT: u32 = 1;
const AX_VALUE_CG_SIZE: u32 = 2;
/// Only layer 0 is an ordinary application window. Menus, the dock and the
/// wallpaper all live above or below it and none of them can be acted on.
const NORMAL_WINDOW_LAYER: f64 = 0.0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> *mut c_void;
    fn AXUIElementCreateApplication(pid: i32) -> *mut c_void;
    fn AXUIElementCopyAttributeValue(
        element: *mut c_void,
        attribute: *const c_void,
        value: *mut *mut c_void,
    ) -> i32;
    fn AXUIElementSetAttributeValue(
        element: *mut c_void,
        attribute: *const c_void,
        value: *const c_void,
    ) -> i32;
    fn AXUIElementPerformAction(element: *mut c_void, action: *const c_void) -> i32;
    fn AXValueCreate(value_type: u32, value: *const c_void) -> *mut c_void;
    fn AXValueGetValue(value: *mut c_void, value_type: u32, out: *mut c_void) -> bool;
}

fn cfstring(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

fn as_cf(string: &Retained<NSString>) -> *const c_void {
    Retained::as_ptr(string).cast()
}

unsafe fn to_string(object: *mut AnyObject) -> Option<String> {
    if object.is_null() {
        return None;
    }
    let utf8: *const c_char = msg_send![object, UTF8String];
    if utf8.is_null() {
        return None;
    }
    Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
}

unsafe fn entry(dictionary: *mut AnyObject, key: &str) -> *mut AnyObject {
    if dictionary.is_null() {
        return ptr::null_mut();
    }
    let key = cfstring(key);
    msg_send![dictionary, objectForKey: &*key]
}

unsafe fn number(dictionary: *mut AnyObject, key: &str) -> Option<f64> {
    let value = entry(dictionary, key);
    if value.is_null() {
        return None;
    }
    Some(msg_send![value, doubleValue])
}

unsafe fn text(dictionary: *mut AnyObject, key: &str) -> Option<String> {
    to_string(entry(dictionary, key))
}

pub fn displays() -> Result<Vec<Display>, String> {
    let mut count: u32 = 0;
    unsafe { CGGetActiveDisplayList(0, ptr::null_mut(), &mut count) };
    let mut ids = vec![0u32; count as usize];
    unsafe { CGGetActiveDisplayList(count, ids.as_mut_ptr(), &mut count) };
    ids.truncate(count as usize);

    Ok(ids
        .into_iter()
        .map(|id| {
            let bounds = CGDisplayBounds(id);
            let mode = CGDisplayCopyDisplayMode(id);
            let pixel_width = CGDisplayMode::pixel_width(mode.as_deref()) as f64;
            let scale = if bounds.size.width > 0.0 && pixel_width > 0.0 {
                pixel_width / bounds.size.width
            } else {
                1.0
            };
            Display {
                id,
                name: format!("display {id}"),
                origin: ScreenPoint::new(bounds.origin.x, bounds.origin.y),
                width: bounds.size.width,
                height: bounds.size.height,
                scale,
                primary: CGDisplayIsMain(id),
            }
        })
        .collect())
}

/// The scale comes from the image the OS actually produced rather than from
/// the display mode, so a mirrored or scaled display cannot put the
/// coordinate mapping out by a factor.
fn grab(rect: CGRect, option: CGWindowListOption, window_id: u32) -> Result<Bitmap, String> {
    if rect.size.width <= 0.0 || rect.size.height <= 0.0 {
        return Err("nothing to capture: the region is empty".into());
    }
    #[allow(deprecated)]
    let image = CGWindowListCreateImage(rect, option, window_id, CGWindowImageOption::Default)
        .ok_or_else(|| {
            "screen capture returned nothing, which on macOS means the screen-recording \
             permission has not been granted"
                .to_string()
        })?;

    let width = CGImage::width(Some(&image));
    let height = CGImage::height(Some(&image));
    let stride = CGImage::bytes_per_row(Some(&image));
    let provider = CGImage::data_provider(Some(&image));
    let data = CGDataProvider::data(provider.as_deref())
        .ok_or("the captured image had no pixel data")?;
    let bytes = data.to_vec();
    if width == 0 || height == 0 || bytes.len() < stride * height {
        return Err("the captured image was truncated".into());
    }

    // CoreGraphics pads each row out to its own alignment and hands back BGRA.
    let mut rgba = Vec::with_capacity(width * height * 4);
    for row in bytes.chunks_exact(stride).take(height) {
        rgba.extend_from_slice(&row[..width * 4]);
    }
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }

    let scale = width as f64 / rect.size.width;
    Ok(Bitmap {
        rgba,
        shot: Shot::new(
            ScreenPoint::new(rect.origin.x, rect.origin.y),
            scale,
            width as u32,
            height as u32,
        ),
    })
}

pub fn capture_display(id: u32) -> Result<Bitmap, String> {
    grab(CGDisplayBounds(id), CGWindowListOption::OptionOnScreenOnly, 0)
}

pub fn capture_window(id: u32) -> Result<Bitmap, String> {
    let window = window_list()?
        .into_iter()
        .find(|window| window.id == id)
        .ok_or_else(|| format!("no window with id {id}"))?;
    let rect = CGRect::new(
        CGPoint::new(window.origin.x, window.origin.y),
        CGSize::new(window.width, window.height),
    );
    grab(rect, CGWindowListOption::OptionIncludingWindow, id)
}

pub fn capture_region(origin: ScreenPoint, width: f64, height: f64) -> Result<Bitmap, String> {
    let rect = CGRect::new(CGPoint::new(origin.x, origin.y), CGSize::new(width, height));
    grab(rect, CGWindowListOption::OptionOnScreenOnly, 0)
}

fn display_under(point: ScreenPoint) -> Option<u32> {
    displays().ok()?.into_iter().find_map(|display| {
        let inside = point.x >= display.origin.x
            && point.x < display.origin.x + display.width
            && point.y >= display.origin.y
            && point.y < display.origin.y + display.height;
        inside.then_some(display.id)
    })
}

unsafe fn window_from(dictionary: *mut AnyObject) -> Option<WindowInfo> {
    let bounds = entry(dictionary, "kCGWindowBounds");
    let id = number(dictionary, "kCGWindowNumber")? as u32;
    let pid = number(dictionary, "kCGWindowOwnerPID").unwrap_or_default() as u32;
    let origin = ScreenPoint::new(number(bounds, "X")?, number(bounds, "Y")?);
    Some(WindowInfo {
        id,
        app_name: text(dictionary, "kCGWindowOwnerName").unwrap_or_default(),
        app_id: bundle_id(pid),
        // Absent rather than empty when the screen-recording grant is
        // missing: macOS drops the key instead of denying the whole read.
        title: text(dictionary, "kCGWindowName").filter(|title| !title.is_empty()),
        pid,
        origin,
        width: number(bounds, "Width")?,
        height: number(bounds, "Height")?,
        // The centre, not the corner: a window straddling the top of the
        // screen has an origin that is on no display at all.
        display_id: display_under(ScreenPoint::new(
            origin.x + number(bounds, "Width")? / 2.0,
            origin.y + number(bounds, "Height")? / 2.0,
        )),
        minimized: number(dictionary, "kCGWindowIsOnscreen").unwrap_or(1.0) == 0.0,
    })
}

fn bundle_id(pid: u32) -> Option<String> {
    unsafe {
        let app: *mut AnyObject = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid as i32,
        ];
        if app.is_null() {
            return None;
        }
        to_string(msg_send![app, bundleIdentifier])
    }
}

pub fn window_list() -> Result<Vec<WindowInfo>, String> {
    let option = CGWindowListOption::OptionOnScreenOnly
        | CGWindowListOption::ExcludeDesktopElements;
    let info = CGWindowListCopyWindowInfo(option, 0).ok_or("the window list was unavailable")?;
    let array: *mut AnyObject = objc2_core_foundation::CFRetained::as_ptr(&info).as_ptr().cast();
    let mut windows = Vec::new();
    unsafe {
        let count: usize = msg_send![array, count];
        for index in 0..count {
            let dictionary: *mut AnyObject = msg_send![array, objectAtIndex: index];
            if number(dictionary, "kCGWindowLayer") != Some(NORMAL_WINDOW_LAYER) {
                continue;
            }
            if let Some(window) = window_from(dictionary) {
                windows.push(window);
            }
        }
    }
    Ok(windows)
}

pub fn foreground_window() -> Result<Option<WindowInfo>, String> {
    let pid = unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return Ok(None);
        }
        let pid: i32 = msg_send![app, processIdentifier];
        pid as u32
    };
    // The list is front to back, so the frontmost app's first entry is the
    // window the user is actually in.
    Ok(window_list()?.into_iter().find(|window| window.pid == pid))
}

fn ax_app_for(id: u32) -> Result<(*mut c_void, WindowInfo), String> {
    let window = window_list()?
        .into_iter()
        .find(|window| window.id == id)
        .ok_or_else(|| format!("no window with id {id}"))?;
    let app = unsafe { AXUIElementCreateApplication(window.pid as i32) };
    if app.is_null() {
        return Err("the accessibility API would not open that application".into());
    }
    Ok((app, window))
}

/// Accessibility has no notion of a CGWindowID, so the right AXWindow is the
/// one sitting exactly where the window server says this one is.
fn ax_window(id: u32) -> Result<*mut c_void, String> {
    let (app, window) = ax_app_for(id)?;
    let attribute = cfstring("AXWindows");
    let mut value: *mut c_void = ptr::null_mut();
    let status = unsafe { AXUIElementCopyAttributeValue(app, as_cf(&attribute), &mut value) };
    unsafe { CFRelease(app.cast()) };
    if status != 0 || value.is_null() {
        return Err("that application exposes no accessible windows".into());
    }
    let array: *mut AnyObject = value.cast();
    let mut found = ptr::null_mut();
    unsafe {
        let count: usize = msg_send![array, count];
        for index in 0..count {
            let candidate: *mut c_void = msg_send![array, objectAtIndex: index];
            if ax_point(candidate, "AXPosition")
                .is_some_and(|point| point.x == window.origin.x && point.y == window.origin.y)
            {
                found = candidate;
                break;
            }
        }
        if found.is_null() && count > 0 {
            found = msg_send![array, objectAtIndex: 0usize];
        }
        if !found.is_null() {
            let _: *mut AnyObject = msg_send![found.cast::<AnyObject>(), retain];
        }
        CFRelease(value.cast());
    }
    if found.is_null() {
        Err("that application exposes no accessible windows".into())
    } else {
        Ok(found)
    }
}

fn ax_point(element: *mut c_void, attribute: &str) -> Option<CGPoint> {
    let name = cfstring(attribute);
    let mut value: *mut c_void = ptr::null_mut();
    let status = unsafe { AXUIElementCopyAttributeValue(element, as_cf(&name), &mut value) };
    if status != 0 || value.is_null() {
        return None;
    }
    let mut point = CGPoint::new(0.0, 0.0);
    let ok = unsafe {
        AXValueGetValue(value, AX_VALUE_CG_POINT, (&mut point as *mut CGPoint).cast())
    };
    unsafe { CFRelease(value.cast()) };
    ok.then_some(point)
}

fn ax_set(element: *mut c_void, attribute: &str, value_type: u32, raw: *const c_void) -> Result<(), String> {
    let name = cfstring(attribute);
    let value = unsafe { AXValueCreate(value_type, raw) };
    if value.is_null() {
        return Err("could not build an accessibility value".into());
    }
    let status = unsafe { AXUIElementSetAttributeValue(element, as_cf(&name), value) };
    unsafe { CFRelease(value.cast()) };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("the application refused to set {attribute} (AXError {status})"))
    }
}

pub fn move_window(id: u32, origin: ScreenPoint) -> Result<(), String> {
    let window = ax_window(id)?;
    let point = CGPoint::new(origin.x, origin.y);
    let result = ax_set(window, "AXPosition", AX_VALUE_CG_POINT, (&point as *const CGPoint).cast());
    unsafe { CFRelease(window.cast()) };
    result
}

pub fn resize_window(id: u32, width: f64, height: f64) -> Result<(), String> {
    let window = ax_window(id)?;
    let size = CGSize::new(width, height);
    let result = ax_set(window, "AXSize", AX_VALUE_CG_SIZE, (&size as *const CGSize).cast());
    unsafe { CFRelease(window.cast()) };
    result
}

pub fn minimize_window(id: u32) -> Result<(), String> {
    let window = ax_window(id)?;
    let attribute = cfstring("AXMinimized");
    let value: *mut AnyObject = unsafe { msg_send![class!(NSNumber), numberWithBool: true] };
    let status =
        unsafe { AXUIElementSetAttributeValue(window, as_cf(&attribute), value.cast()) };
    unsafe { CFRelease(window.cast()) };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("that window refused to minimize (AXError {status})"))
    }
}

pub fn close_window(id: u32) -> Result<(), String> {
    let window = ax_window(id)?;
    let attribute = cfstring("AXCloseButton");
    let mut button: *mut c_void = ptr::null_mut();
    let status = unsafe { AXUIElementCopyAttributeValue(window, as_cf(&attribute), &mut button) };
    unsafe { CFRelease(window.cast()) };
    if status != 0 || button.is_null() {
        return Err("that window has no close button".into());
    }
    let press = cfstring("AXPress");
    let status = unsafe { AXUIElementPerformAction(button, as_cf(&press)) };
    unsafe { CFRelease(button.cast()) };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("that window refused to close (AXError {status})"))
    }
}

pub fn activate_window(id: u32) -> Result<(), String> {
    let (app, window) = ax_app_for(id)?;
    unsafe { CFRelease(app.cast()) };
    let raised = ax_window(id).map(|element| {
        let action = cfstring("AXRaise");
        let status = unsafe { AXUIElementPerformAction(element, as_cf(&action)) };
        unsafe { CFRelease(element.cast()) };
        status == 0
    });
    let activated = unsafe {
        let running: *mut AnyObject = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: window.pid as i32,
        ];
        if running.is_null() {
            false
        } else {
            const ACTIVATE_IGNORING_OTHER_APPS: usize = 1 << 1;
            msg_send![running, activateWithOptions: ACTIVATE_IGNORING_OTHER_APPS]
        }
    };
    if activated || raised.unwrap_or(false) {
        Ok(())
    } else {
        Err("that window would not come to the front".into())
    }
}

fn open(args: &[&str]) -> Result<(), String> {
    let status = Command::new("open").args(args).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open exited with {status}"))
    }
}

pub fn open_app(name: &str) -> Result<(), String> {
    open(&["-a", name])
}

pub fn open_url(url: &str) -> Result<(), String> {
    open(&[url])
}

pub fn selected_text() -> Option<String> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        return None;
    }
    let focused_key = cfstring("AXFocusedUIElement");
    let mut focused: *mut c_void = ptr::null_mut();
    let status = unsafe { AXUIElementCopyAttributeValue(system, as_cf(&focused_key), &mut focused) };
    unsafe { CFRelease(system.cast()) };
    if status != 0 || focused.is_null() {
        return None;
    }
    let selected_key = cfstring("AXSelectedText");
    let mut selected: *mut c_void = ptr::null_mut();
    let status =
        unsafe { AXUIElementCopyAttributeValue(focused, as_cf(&selected_key), &mut selected) };
    unsafe { CFRelease(focused.cast()) };
    if status != 0 || selected.is_null() {
        return None;
    }
    let text = unsafe { to_string(selected.cast()) };
    unsafe { CFRelease(selected.cast()) };
    text
}

/// macOS has no equivalent of Windows' elevated-window block: an app allowed to
/// post events can inject anywhere. Whether it is allowed is a separate grant
/// from Accessibility, and a process without it has every event it posts
/// dropped in silence, so it is checked here rather than discovered by the user.
pub fn guard_injection() -> Result<(), String> {
    if crate::platform::macos::post_events_ok() {
        return Ok(());
    }
    Err(NO_POST_EVENTS.into())
}

const NO_POST_EVENTS: &str =
    "macOS is not letting OpenLive send keystrokes or clicks, so anything it \
     types or clicks is thrown away before it reaches an app: open System \
     Settings > Privacy & Security > Accessibility, switch OpenLive off and \
     back on (add it if it is not listed), then restart OpenLive";

pub fn elevated_injection_ok() -> bool {
    true
}

fn cg_button(button: Button) -> CGMouseButton {
    match button {
        Button::Left => CGMouseButton::Left,
        Button::Right => CGMouseButton::Right,
        Button::Middle => CGMouseButton::Center,
    }
}

fn post(
    event_type: CGEventType,
    point: ScreenPoint,
    button: Button,
    click_state: Option<i64>,
) -> Result<(), String> {
    let source = event_source();
    let event = CGEvent::new_mouse_event(
        source.as_deref(),
        event_type,
        CGPoint::new(point.x, point.y),
        cg_button(button),
    )
    .ok_or("could not create a mouse event")?;
    if let Some(state) = click_state {
        CGEvent::set_integer_value_field(Some(&event), CGEventField::MouseEventClickState, state);
    }
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

fn down_up(button: Button) -> (CGEventType, CGEventType, CGEventType) {
    match button {
        Button::Left => (
            CGEventType::LeftMouseDown,
            CGEventType::LeftMouseUp,
            CGEventType::LeftMouseDragged,
        ),
        Button::Right => (
            CGEventType::RightMouseDown,
            CGEventType::RightMouseUp,
            CGEventType::RightMouseDragged,
        ),
        Button::Middle => (
            CGEventType::OtherMouseDown,
            CGEventType::OtherMouseUp,
            CGEventType::OtherMouseDragged,
        ),
    }
}

pub fn mouse_move(point: ScreenPoint) -> Result<(), String> {
    post(CGEventType::MouseMoved, point, Button::Left, None)
}

pub fn mouse_click(point: ScreenPoint, button: Button, count: u32) -> Result<(), String> {
    let (down, up, _) = down_up(button);
    mouse_move(point)?;
    for click in 1..=count {
        // The click state is what makes the second press a double click
        // rather than two separate ones.
        post(down, point, button, Some(i64::from(click)))?;
        post(up, point, button, Some(i64::from(click)))?;
    }
    Ok(())
}

pub fn mouse_button(point: ScreenPoint, button: Button, down: bool) -> Result<(), String> {
    let (press, release, _) = down_up(button);
    post(if down { press } else { release }, point, button, Some(1))
}

pub fn mouse_drag_to(point: ScreenPoint, button: Button) -> Result<(), String> {
    let (_, _, dragged) = down_up(button);
    post(dragged, point, button, Some(1))
}

pub fn scroll(point: ScreenPoint, horizontal: i32, vertical: i32) -> Result<(), String> {
    mouse_move(point)?;
    let source = event_source();
    let event = CGEvent::new_scroll_wheel_event2(
        source.as_deref(),
        CGScrollEventUnit::Pixel,
        2,
        vertical,
        horizontal,
        0,
    )
    .ok_or("could not create a scroll event")?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

pub fn key_chord(chord: &str) -> Result<(), String> {
    use std::str::FromStr;
    let binding = crate::binding::Binding::from_str(chord)?;
    let hotkey = binding.hotkey();
    let mut flags = CGEventFlags::empty();
    let mut modifier_keycodes = Vec::new();
    for (group, flag, keycode) in [
        (handy_keys::Modifiers::CMD, CGEventFlags::MaskCommand, 55u16),
        (handy_keys::Modifiers::SHIFT, CGEventFlags::MaskShift, 56),
        (handy_keys::Modifiers::OPT, CGEventFlags::MaskAlternate, 58),
        (handy_keys::Modifiers::CTRL, CGEventFlags::MaskControl, 59),
    ] {
        if hotkey.modifiers.intersects(group) {
            flags |= flag;
            modifier_keycodes.push(keycode);
        }
    }
    let Some(key) = hotkey.key else {
        return Err(format!("\"{chord}\" is only modifiers, so there is nothing to press"));
    };
    let keycode = crate::platform::macos::virtual_keycode(key)
        .ok_or_else(|| format!("\"{chord}\" has no keycode on this layout"))?;
    crate::platform::macos::send_chord(keycode, flags, &modifier_keycodes)
}

pub fn ocr(png: &[u8], width: f64, height: f64) -> Result<Vec<ShotBox>, String> {
    let data = NSData::with_bytes(png);
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    let requests = NSArray::from_slice(&[&*request as &VNRequest]);
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &objc2_foundation::NSDictionary::new(),
    );
    handler
        .performRequests_error(&requests)
        .map_err(|e| format!("Vision could not read that image: {e}"))?;

    let Some(results) = request.results() else {
        return Ok(Vec::new());
    };
    // Vision reports a normalised box with its origin at the bottom left, so
    // the height is flipped back into image pixels here.
    let mut found = Vec::new();
    for observation in results.iter() {
        let Ok(observation) = observation.downcast::<VNRecognizedTextObservation>() else {
            continue;
        };
        let candidates = observation.topCandidates(1);
        let Some(candidate) = candidates.iter().next() else {
            continue;
        };
        let rect = unsafe { observation.boundingBox() };
        found.push(ShotBox {
            text: candidate.string().to_string(),
            confidence: candidate.confidence(),
            x: rect.origin.x * width,
            y: (1.0 - rect.origin.y - rect.size.height) * height,
            width: rect.size.width * width,
            height: rect.size.height * height,
        });
    }
    Ok(found)
}

pub fn ocr_available() -> bool {
    true
}

pub fn ocr_engine() -> &'static str {
    "vision"
}

pub fn capture_ok() -> bool {
    crate::platform::macos::screen_recording_ok()
}

pub fn capture_backend() -> &'static str {
    "coregraphics"
}

pub fn selection_ok() -> bool {
    crate::platform::macos::accessibility_ok()
}

pub fn selection_backend() -> &'static str {
    "accessibility"
}

pub fn window_control_ok() -> bool {
    crate::platform::macos::accessibility_ok()
}

pub fn external_tools() -> Vec<String> {
    Vec::new()
}

pub fn session_kind() -> Option<&'static str> {
    None
}
