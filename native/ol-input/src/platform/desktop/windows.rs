//! Windows capture, window metadata and pointer control.
//!
//! Coordinates here are physical pixels on the virtual desktop, which is what
//! `SendInput` and `GetWindowRect` both speak, so a capture of a display is
//! one image pixel per screen coordinate and only the model cap changes that.
//! A display's DPI scale is reported for the caller's information and is
//! never applied to a coordinate.

use std::ffi::c_void;

use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, MonitorFromWindow,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HMONITOR,
    MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_MOUSE, KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
    MOUSEEVENTF_HWHEEL, MOUSEINPUT,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW,
    SetForegroundWindow, SetWindowPos, ShowWindow, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_NOSIZE, SWP_NOZORDER, SW_MINIMIZE, SW_RESTORE,
    WM_CLOSE,
};

use crate::capture::{Bitmap, Display};
use crate::control::Button;
use crate::coords::{ScreenPoint, Shot};
use crate::ocr::ShotBox;
use crate::platform::windows::{key_input, send};
use crate::window::WindowInfo;

/// One wheel notch, the unit every Windows app expects a scroll to arrive in.
const WHEEL_DELTA: i32 = 120;
/// SendInput's absolute coordinates are this space, not pixels.
const ABSOLUTE_RANGE: f64 = 65535.0;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _dc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let monitors = &mut *(data.0 as *mut Vec<HMONITOR>);
    monitors.push(monitor);
    true.into()
}

fn monitors() -> Vec<HMONITOR> {
    let mut found: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(collect_monitor),
            LPARAM(&mut found as *mut Vec<HMONITOR> as isize),
        );
    }
    found
}

fn monitor_info(monitor: HMONITOR) -> Option<(RECT, String, bool, f64)> {
    let mut info = MONITORINFOEXW {
        monitorInfo: MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let ok = unsafe {
        GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool()
    };
    if !ok {
        return None;
    }
    let mut dpi_x = 96u32;
    let mut dpi_y = 96u32;
    let _ = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    Some((
        info.monitorInfo.rcMonitor,
        from_wide(&info.szDevice),
        info.monitorInfo.dwFlags & 1 == 1,
        f64::from(dpi_x) / 96.0,
    ))
}

/// The monitor handle is not stable across a display change, so the id is the
/// handle folded into 32 bits and resolved through a fresh enumeration.
fn monitor_id(monitor: HMONITOR) -> u32 {
    (monitor.0 as usize as u64 & 0xFFFF_FFFF) as u32
}

pub fn displays() -> Result<Vec<Display>, String> {
    let displays: Vec<Display> = monitors()
        .into_iter()
        .filter_map(|monitor| {
            let (rect, name, primary, scale) = monitor_info(monitor)?;
            Some(Display {
                id: monitor_id(monitor),
                name,
                origin: ScreenPoint::new(f64::from(rect.left), f64::from(rect.top)),
                width: f64::from(rect.right - rect.left),
                height: f64::from(rect.bottom - rect.top),
                scale,
                primary,
            })
        })
        .collect();
    if displays.is_empty() {
        Err("no displays were reported".into())
    } else {
        Ok(displays)
    }
}

/// Pulls a rectangle of the virtual desktop out of the screen DC. `window`
/// narrows the blit to one window's own DC so an occluded window still
/// captures.
fn grab(origin: ScreenPoint, width: i32, height: i32, window: Option<HWND>) -> Result<Bitmap, String> {
    if width <= 0 || height <= 0 {
        return Err("nothing to capture: the region is empty".into());
    }
    unsafe {
        let source = GetDC(window.unwrap_or_default());
        if source.is_invalid() {
            return Err("could not open a device context for the screen".into());
        }
        let memory = CreateCompatibleDC(source);
        let bitmap = CreateCompatibleBitmap(source, width, height);
        let previous = SelectObject(memory, bitmap);

        let (blit_x, blit_y) = match window {
            Some(_) => (0, 0),
            None => (origin.x as i32, origin.y as i32),
        };
        let blitted =
            BitBlt(memory, 0, 0, width, height, source, blit_x, blit_y, SRCCOPY).is_ok();

        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative height asks GDI for a top-down image, which is the
                // order every consumer of these pixels wants.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        let rows = GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            Some(rgba.as_mut_ptr().cast::<c_void>()),
            &mut header,
            DIB_RGB_COLORS,
        );

        SelectObject(memory, previous);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(memory);
        ReleaseDC(window.unwrap_or_default(), source);

        if !blitted || rows == 0 {
            return Err("the screen capture was refused, which usually means a \
                        protected or secure-desktop window is in front"
                .into());
        }
        for pixel in rgba.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Ok(Bitmap {
            rgba,
            shot: Shot::new(origin, 1.0, width as u32, height as u32),
        })
    }
}

pub fn capture_display(id: u32) -> Result<Bitmap, String> {
    let display = displays()?
        .into_iter()
        .find(|display| display.id == id)
        .ok_or_else(|| format!("no display with id {id}"))?;
    grab(display.origin, display.width as i32, display.height as i32, None)
}

pub fn capture_window(id: u32) -> Result<Bitmap, String> {
    let window = window_list()?
        .into_iter()
        .find(|window| window.id == id)
        .ok_or_else(|| format!("no window with id {id}"))?;
    grab(
        window.origin,
        window.width as i32,
        window.height as i32,
        Some(hwnd(id)),
    )
}

pub fn capture_region(origin: ScreenPoint, width: f64, height: f64) -> Result<Bitmap, String> {
    grab(origin, width as i32, height as i32, None)
}

fn hwnd(id: u32) -> HWND {
    HWND(id as usize as *mut c_void)
}

fn window_id(window: HWND) -> u32 {
    (window.0 as usize as u64 & 0xFFFF_FFFF) as u32
}

fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 260];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let path = from_wide(&buffer[..length as usize]);
        Some(path.rsplit('\\').next().unwrap_or(&path).to_string())
    }
}

fn describe(window: HWND) -> Option<WindowInfo> {
    unsafe {
        if !IsWindowVisible(window).as_bool() {
            return None;
        }
        let mut rect = RECT::default();
        GetWindowRect(window, &mut rect).ok()?;
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        let length = GetWindowTextLengthW(window);
        let title = if length > 0 {
            let mut buffer = vec![0u16; length as usize + 1];
            let written = GetWindowTextW(window, &mut buffer);
            (written > 0).then(|| from_wide(&buffer))
        } else {
            None
        };
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        let name = process_name(pid);
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        Some(WindowInfo {
            id: window_id(window),
            app_name: name.clone().unwrap_or_default(),
            app_id: name,
            title,
            pid,
            origin: ScreenPoint::new(f64::from(rect.left), f64::from(rect.top)),
            width: f64::from(rect.right - rect.left),
            height: f64::from(rect.bottom - rect.top),
            display_id: (!monitor.is_invalid()).then(|| monitor_id(monitor)),
            minimized: IsIconic(window).as_bool(),
        })
    }
}

unsafe extern "system" fn collect_window(window: HWND, data: LPARAM) -> BOOL {
    let windows = &mut *(data.0 as *mut Vec<WindowInfo>);
    if let Some(info) = describe(window) {
        // An untitled window is a tool window or a ghost, never something a
        // user would name or a model should act on.
        if info.title.is_some() {
            windows.push(info);
        }
    }
    true.into()
}

pub fn window_list() -> Result<Vec<WindowInfo>, String> {
    let mut found: Vec<WindowInfo> = Vec::new();
    unsafe {
        EnumWindows(
            Some(collect_window),
            LPARAM(&mut found as *mut Vec<WindowInfo> as isize),
        )
        .map_err(|e| e.message())?;
    }
    Ok(found)
}

pub fn foreground_window() -> Result<Option<WindowInfo>, String> {
    let window = unsafe { GetForegroundWindow() };
    if window.is_invalid() {
        return Ok(None);
    }
    Ok(describe(window))
}

pub fn activate_window(id: u32) -> Result<(), String> {
    unsafe {
        let window = hwnd(id);
        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }
        if SetForegroundWindow(window).as_bool() {
            Ok(())
        } else {
            Err("Windows refused to bring that window to the front, which it does \
                 when the calling process does not own the current foreground"
                .into())
        }
    }
}

pub fn move_window(id: u32, origin: ScreenPoint) -> Result<(), String> {
    unsafe {
        SetWindowPos(
            hwnd(id),
            None,
            origin.x as i32,
            origin.y as i32,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER,
        )
        .map_err(|e| e.message())
    }
}

pub fn resize_window(id: u32, width: f64, height: f64) -> Result<(), String> {
    let window = window_list()?
        .into_iter()
        .find(|window| window.id == id)
        .ok_or_else(|| format!("no window with id {id}"))?;
    unsafe {
        SetWindowPos(
            hwnd(id),
            None,
            window.origin.x as i32,
            window.origin.y as i32,
            width as i32,
            height as i32,
            SWP_NOZORDER,
        )
        .map_err(|e| e.message())
    }
}

pub fn minimize_window(id: u32) -> Result<(), String> {
    let _ = unsafe { ShowWindow(hwnd(id), SW_MINIMIZE) };
    Ok(())
}

pub fn close_window(id: u32) -> Result<(), String> {
    unsafe { PostMessageW(hwnd(id), WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(|e| e.message()) }
}

fn shell_execute(verb: &str, target: &str) -> Result<(), String> {
    let verb = wide(verb);
    let target = wide(target);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW returns a fake HINSTANCE; anything at or below 32 is an
    // error code rather than a handle.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("Windows would not open \"{}\"", from_wide(&target)))
    }
}

pub fn open_app(name: &str) -> Result<(), String> {
    shell_execute("open", name)
}

pub fn open_url(url: &str) -> Result<(), String> {
    shell_execute("open", url)
}

/// UI Automation is the only way to read a selection out of an arbitrary app.
/// Every failure along the way is `None`, because a control that exposes no
/// text pattern has not told us the selection is empty.
pub fn selected_text() -> Option<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL).ok()?;
        let focused = automation.GetFocusedElement().ok()?;
        let pattern = focused.GetCurrentPattern(UIA_TextPatternId).ok()?;
        let text: IUIAutomationTextPattern = pattern.cast().ok()?;
        let ranges = text.GetSelection().ok()?;
        let count = ranges.Length().ok()?;
        let mut out = String::new();
        for index in 0..count {
            if let Ok(range) = ranges.GetElement(index) {
                if let Ok(value) = range.GetText(-1) {
                    out.push_str(&value.to_string());
                }
            }
        }
        Some(out)
    }
}

fn is_elevated(pid: u32) -> Option<bool> {
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::OpenProcessToken;
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut token = windows::Win32::Foundation::HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok();
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0u32;
        let ok = opened
            && GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut TOKEN_ELEVATION as *mut c_void),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            )
            .is_ok();
        if opened {
            let _ = CloseHandle(token);
        }
        let _ = CloseHandle(process);
        ok.then_some(elevation.TokenIsElevated != 0)
    }
}

fn we_are_elevated() -> bool {
    is_elevated(std::process::id()).unwrap_or(false)
}

/// A process that is not elevated cannot send input to a window that is: UIPI
/// drops it and `SendInput` still reports success. Saying so is the only
/// honest outcome.
pub fn guard_injection() -> Result<(), String> {
    let window = unsafe { GetForegroundWindow() };
    if window.is_invalid() {
        return Ok(());
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    if pid == 0 || pid == std::process::id() {
        return Ok(());
    }
    match is_elevated(pid) {
        // The query itself being refused is the usual symptom of an elevated
        // target, so it counts as one.
        None if !we_are_elevated() => Err(ELEVATED.into()),
        Some(true) if !we_are_elevated() => Err(ELEVATED.into()),
        _ => Ok(()),
    }
}

const ELEVATED: &str =
    "the focused window is running elevated and OpenLive is not, so Windows will \
     silently discard any input sent to it: restart OpenLive as administrator or \
     switch to a window that is not elevated";

pub fn elevated_injection_ok() -> bool {
    we_are_elevated()
}

fn virtual_screen() -> (f64, f64, f64, f64) {
    unsafe {
        (
            f64::from(GetSystemMetrics(SM_XVIRTUALSCREEN)),
            f64::from(GetSystemMetrics(SM_YVIRTUALSCREEN)),
            f64::from(GetSystemMetrics(SM_CXVIRTUALSCREEN)).max(1.0),
            f64::from(GetSystemMetrics(SM_CYVIRTUALSCREEN)).max(1.0),
        )
    }
}

fn mouse_input(flags: u32, point: Option<ScreenPoint>, data: i32) -> INPUT {
    let (dx, dy, absolute) = match point {
        Some(point) => {
            let (left, top, width, height) = virtual_screen();
            (
                (((point.x - left) * ABSOLUTE_RANGE) / width).round() as i32,
                (((point.y - top) * ABSOLUTE_RANGE) / height).round() as i32,
                MOUSEEVENTF_ABSOLUTE.0 | MOUSEEVENTF_MOVE.0,
            )
        }
        None => (0, 0, 0),
    };
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS(
                    flags | absolute,
                ),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn button_flags(button: Button, down: bool) -> u32 {
    match (button, down) {
        (Button::Left, true) => MOUSEEVENTF_LEFTDOWN.0,
        (Button::Left, false) => MOUSEEVENTF_LEFTUP.0,
        (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN.0,
        (Button::Right, false) => MOUSEEVENTF_RIGHTUP.0,
        (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN.0,
        (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP.0,
    }
}

pub fn mouse_move(point: ScreenPoint) -> Result<(), String> {
    send(&[mouse_input(0, Some(point), 0)])
}

pub fn mouse_click(point: ScreenPoint, button: Button, count: u32) -> Result<(), String> {
    mouse_move(point)?;
    for _ in 0..count {
        send(&[
            mouse_input(button_flags(button, true), None, 0),
            mouse_input(button_flags(button, false), None, 0),
        ])?;
    }
    Ok(())
}

pub fn mouse_button(point: ScreenPoint, button: Button, down: bool) -> Result<(), String> {
    mouse_move(point)?;
    send(&[mouse_input(button_flags(button, down), None, 0)])
}

pub fn mouse_drag_to(point: ScreenPoint, _button: Button) -> Result<(), String> {
    mouse_move(point)
}

pub fn scroll(point: ScreenPoint, horizontal: i32, vertical: i32) -> Result<(), String> {
    mouse_move(point)?;
    if vertical != 0 {
        send(&[mouse_input(MOUSEEVENTF_WHEEL.0, None, vertical * WHEEL_DELTA)])?;
    }
    if horizontal != 0 {
        send(&[mouse_input(MOUSEEVENTF_HWHEEL.0, None, horizontal * WHEEL_DELTA)])?;
    }
    Ok(())
}

/// Virtual-key codes for the keys a chord is built from. Letters and digits
/// resolve through the active layout instead, so a chord means the same key a
/// user would press.
fn virtual_key(key: handy_keys::Key) -> Option<u16> {
    use handy_keys::Key::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    Some(match key {
        Return => VK_RETURN.0,
        Tab => VK_TAB.0,
        Space => VK_SPACE.0,
        Delete => VK_BACK.0,
        ForwardDelete => VK_DELETE.0,
        Escape => VK_ESCAPE.0,
        Home => VK_HOME.0,
        End => VK_END.0,
        PageUp => VK_PRIOR.0,
        PageDown => VK_NEXT.0,
        LeftArrow => VK_LEFT.0,
        RightArrow => VK_RIGHT.0,
        UpArrow => VK_UP.0,
        DownArrow => VK_DOWN.0,
        F1 => VK_F1.0, F2 => VK_F2.0, F3 => VK_F3.0, F4 => VK_F4.0, F5 => VK_F5.0,
        F6 => VK_F6.0, F7 => VK_F7.0, F8 => VK_F8.0, F9 => VK_F9.0, F10 => VK_F10.0,
        F11 => VK_F11.0, F12 => VK_F12.0,
        other => {
            let name = format!("{other:?}").to_lowercase();
            let character = name.chars().next()?;
            let scan = unsafe { VkKeyScanW(character as u16) };
            if scan == -1 {
                return None;
            }
            (scan as u16) & 0xFF
        }
    })
}

pub fn key_chord(chord: &str) -> Result<(), String> {
    use std::str::FromStr;
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT};

    let binding = crate::binding::Binding::from_str(chord)?;
    let hotkey = binding.hotkey();
    let mut modifiers = Vec::new();
    for (group, key) in [
        (handy_keys::Modifiers::CTRL, VK_CONTROL),
        (handy_keys::Modifiers::SHIFT, VK_SHIFT),
        (handy_keys::Modifiers::OPT, VK_MENU),
        (handy_keys::Modifiers::CMD, VK_LWIN),
    ] {
        if hotkey.modifiers.intersects(group) {
            modifiers.push(key.0);
        }
    }
    let key = hotkey
        .key
        .ok_or_else(|| format!("\"{chord}\" is only modifiers, so there is nothing to press"))?;
    let key = virtual_key(key).ok_or_else(|| format!("\"{chord}\" has no key on this layout"))?;

    let mut inputs: Vec<INPUT> = modifiers
        .iter()
        .map(|vk| key_input(*vk, 0, Default::default()))
        .collect();
    inputs.push(key_input(key, 0, Default::default()));
    inputs.push(key_input(key, 0, KEYEVENTF_KEYUP));
    inputs.extend(modifiers.iter().rev().map(|vk| key_input(*vk, 0, KEYEVENTF_KEYUP)));
    send(&inputs)
}

pub fn ocr(png: &[u8], _width: f64, _height: f64) -> Result<Vec<ShotBox>, String> {
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    let stream = InMemoryRandomAccessStream::new().map_err(|e| e.message())?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| e.message())?;
    writer.WriteBytes(png).map_err(|e| e.message())?;
    writer.StoreAsync().map_err(|e| e.message())?.get().map_err(|e| e.message())?;
    writer.FlushAsync().map_err(|e| e.message())?.get().map_err(|e| e.message())?;
    stream.Seek(0).map_err(|e| e.message())?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| e.message())?
        .get()
        .map_err(|e| e.message())?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| e.message())?
        .get()
        .map_err(|e| e.message())?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| {
        "Windows has no OCR language pack installed for the current user".to_string()
    })?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| e.message())?
        .get()
        .map_err(|e| e.message())?;

    let mut found = Vec::new();
    for line in result.Lines().map_err(|e| e.message())?.into_iter() {
        let text = line.Text().map_err(|e| e.message())?.to_string();
        let words = line.Words().map_err(|e| e.message())?;
        let mut rect: Option<windows::Foundation::Rect> = None;
        for word in words.into_iter() {
            let Ok(bounds) = word.BoundingRect() else { continue };
            rect = Some(match rect {
                None => bounds,
                Some(current) => {
                    let left = current.X.min(bounds.X);
                    let top = current.Y.min(bounds.Y);
                    let right = (current.X + current.Width).max(bounds.X + bounds.Width);
                    let bottom = (current.Y + current.Height).max(bounds.Y + bounds.Height);
                    windows::Foundation::Rect {
                        X: left,
                        Y: top,
                        Width: right - left,
                        Height: bottom - top,
                    }
                }
            });
        }
        let Some(rect) = rect else { continue };
        found.push(ShotBox {
            text,
            // The Windows engine reports no per-line confidence.
            confidence: 1.0,
            x: f64::from(rect.X),
            y: f64::from(rect.Y),
            width: f64::from(rect.Width),
            height: f64::from(rect.Height),
        });
    }
    Ok(found)
}

pub fn ocr_available() -> bool {
    windows::Media::Ocr::OcrEngine::TryCreateFromUserProfileLanguages().is_ok()
}

pub fn ocr_engine() -> &'static str {
    "windows-ocr"
}

pub fn capture_ok() -> bool {
    true
}

pub fn capture_backend() -> &'static str {
    "gdi"
}

pub fn selection_ok() -> bool {
    true
}

pub fn selection_backend() -> &'static str {
    "ui-automation"
}

pub fn window_control_ok() -> bool {
    true
}

pub fn external_tools() -> Vec<String> {
    Vec::new()
}

pub fn session_kind() -> Option<&'static str> {
    None
}
