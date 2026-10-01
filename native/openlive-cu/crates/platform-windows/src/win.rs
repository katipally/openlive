//! Top-level windows, the processes behind them, and what Windows lets this
//! helper do to them: the session it runs in, the input desktop, and UIPI.

use crate::shot::Px;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::PathBuf;
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, WindowFromPoint, GA_ROOT, GWL_EXSTYLE,
    GW_OWNER, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/// Smaller than this on either side is a tooltip or a badge, not a window to work in. The macOS backend's floor.
const MIN_SIDE: i32 = 48;
/// SECURITY_MANDATORY_HIGH_RID: an elevated process.
const HIGH_INTEGRITY: u32 = 0x3000;

/// The low 32 bits of an HWND, the same id ol-input's window tools take.
pub fn id(h: HWND) -> u64 {
    h.0 as usize as u64 & 0xFFFF_FFFF
}

/// HWNDs are 32-bit values sign-extended on 64-bit Windows, so the id round-trips.
pub fn hwnd(id: u64) -> HWND {
    HWND(id as u32 as i32 as isize as *mut c_void)
}

#[derive(Debug, Clone)]
pub struct Window {
    pub hwnd: HWND,
    /// The app's pid: for a UWP app, its own process, not ApplicationFrameHost's.
    pub pid: u32,
    pub title: Option<String>,
    /// The visible frame (DWM extended frame bounds), physical pixels.
    pub frame: Px,
}

fn wide_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|u| *u == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn pid_of(h: HWND) -> u32 {
    let mut pid = 0;
    // SAFETY: valid out-pointer.
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    pid
}

fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 256];
    // SAFETY: the buffer bounds the write.
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn title(h: HWND) -> Option<String> {
    // SAFETY: the buffer is sized from the reported length.
    unsafe {
        let len = GetWindowTextLengthW(h);
        if len <= 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(h, &mut buf);
        Some(String::from_utf16_lossy(&buf[..n.max(0) as usize])).filter(|t| !t.trim().is_empty())
    }
}

/// The visible frame. GetWindowRect also counts the invisible resize borders.
pub fn frame(h: HWND) -> Option<Px> {
    let mut r = RECT::default();
    // SAFETY: `r` is the RECT DWMWA_EXTENDED_FRAME_BOUNDS writes.
    let dwm = unsafe { DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, (&mut r as *mut RECT).cast(), size_of::<RECT>() as u32) };
    if dwm.is_err() {
        // SAFETY: valid out-pointer.
        unsafe { GetWindowRect(h, &mut r) }.ok()?;
    }
    Some(Px { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
}

pub fn window_rect(h: HWND) -> Option<Px> {
    let mut r = RECT::default();
    // SAFETY: valid out-pointer.
    unsafe { GetWindowRect(h, &mut r) }.ok()?;
    Some(Px { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
}

fn cloaked(h: HWND) -> bool {
    let mut c = 0u32;
    // SAFETY: DWMWA_CLOAKED writes a DWORD.
    unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, (&mut c as *mut u32).cast(), 4) }.is_ok() && c != 0
}

/// What Alt+Tab would show: visible, not cloaked (on another virtual desktop,
/// or a suspended UWP frame), unowned or marked as an app window, not a tool
/// window, and not minimized, which is the macOS backend's "on screen".
fn eligible(h: HWND) -> bool {
    // SAFETY: plain reads of a window that may vanish meanwhile; each fails harmlessly then.
    unsafe {
        if !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() || cloaked(h) {
            return false;
        }
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        let app_window = ex & WS_EX_APPWINDOW.0 != 0;
        let owned = GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid());
        app_window || (!owned && ex & (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) == 0)
    }
}

/// A UWP app draws inside an ApplicationFrameHost window; the pid that matters is its CoreWindow's.
pub fn app_pid(h: HWND) -> u32 {
    let pid = pid_of(h);
    if class_name(h) != "ApplicationFrameWindow" {
        return pid;
    }
    let mut found = (pid, 0u32);
    unsafe extern "system" fn core(child: HWND, data: LPARAM) -> BOOL {
        // SAFETY: `data` is the `found` tuple below, alive for the enumeration.
        let found = unsafe { &mut *(data.0 as *mut (u32, u32)) };
        if class_name(child) == "Windows.UI.Core.CoreWindow" && pid_of(child) != found.0 {
            found.1 = pid_of(child);
            return false.into();
        }
        true.into()
    }
    // SAFETY: the callback only touches `found`, which outlives the call.
    unsafe {
        let _ = EnumChildWindows(Some(h), Some(core), LPARAM(&mut found as *mut (u32, u32) as isize));
    }
    if found.1 != 0 { found.1 } else { pid }
}

/// Every window worth working in, front to back: EnumWindows walks the z-order top down. O(w).
pub fn windows() -> Vec<Window> {
    let mut handles: Vec<HWND> = Vec::new();
    unsafe extern "system" fn collect(h: HWND, data: LPARAM) -> BOOL {
        // SAFETY: `data` is `handles` below, alive for the enumeration.
        unsafe { &mut *(data.0 as *mut Vec<HWND>) }.push(h);
        true.into()
    }
    // SAFETY: the callback only pushes into `handles`, which outlives the call.
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut handles as *mut Vec<HWND> as isize));
    }
    handles
        .into_iter()
        .filter(|h| eligible(*h))
        .filter_map(|h| {
            let frame = frame(h)?;
            (frame.width() >= MIN_SIDE && frame.height() >= MIN_SIDE).then(|| Window { hwnd: h, pid: app_pid(h), title: title(h), frame })
        })
        .collect()
}

/// The top-level window in front, as Windows reports it.
pub fn foreground() -> Option<HWND> {
    // SAFETY: plain reads.
    let h = unsafe { GetForegroundWindow() };
    (!h.is_invalid()).then(|| unsafe { GetAncestor(h, GA_ROOT) })
}

/// The top-level window under a desktop point, and its app's pid.
pub fn root_at(x: f64, y: f64) -> Option<(HWND, u32)> {
    // SAFETY: plain reads.
    unsafe {
        let h = WindowFromPoint(POINT { x: x.round() as i32, y: y.round() as i32 });
        if h.is_invalid() {
            return None;
        }
        let root = GetAncestor(h, GA_ROOT);
        Some((root, app_pid(root)))
    }
}

fn exe_path(pid: u32) -> Option<PathBuf> {
    // SAFETY: the handle is closed on every path; the buffer bounds the write.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        ok.then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

/// The executable's FileDescription ("Google Chrome" for chrome.exe), what a person calls the app.
fn description(exe: &std::path::Path) -> Option<String> {
    let path = wide(&exe.to_string_lossy());
    // SAFETY: the version block is sized by the first call and outlives every pointer VerQueryValueW returns into it.
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(path.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut block = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(path.as_ptr()), None, size, block.as_mut_ptr().cast()).ok()?;
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let translation = wide("\\VarFileInfo\\Translation");
        if !VerQueryValueW(block.as_ptr().cast(), PCWSTR(translation.as_ptr()), &mut ptr, &mut len).as_bool() || len < 4 {
            return None;
        }
        let [lang, codepage] = *(ptr as *const [u16; 2]);
        let key = wide(&format!("\\StringFileInfo\\{lang:04x}{codepage:04x}\\FileDescription"));
        if !VerQueryValueW(block.as_ptr().cast(), PCWSTR(key.as_ptr()), &mut ptr, &mut len).as_bool() || len == 0 {
            return None;
        }
        Some(wide_string(std::slice::from_raw_parts(ptr as *const u16, len as usize))).filter(|d| !d.trim().is_empty())
    }
}

/// A process as an app: its name and its executable's file name, which stands in for a bundle id.
#[derive(Debug, Clone)]
pub struct Process {
    pub name: String,
    pub exe_name: Option<String>,
    pub path: Option<PathBuf>,
}

/// Name lookups cost a file read each, so one listing reads each pid once.
pub fn processes(pids: impl IntoIterator<Item = u32>) -> HashMap<u32, Process> {
    let mut out = HashMap::new();
    for pid in pids {
        out.entry(pid).or_insert_with(|| {
            let path = exe_path(pid);
            let exe_name = path.as_ref().and_then(|p| p.file_name()).map(|f| f.to_string_lossy().into_owned());
            let stem = path.as_ref().and_then(|p| p.file_stem()).map(|f| f.to_string_lossy().into_owned());
            let name = path.as_deref().and_then(description).or(stem).unwrap_or_else(|| format!("pid {pid}"));
            Process { name, exe_name, path }
        });
    }
    out
}

/// A Windows service runs in session 0, which has no desktop to see or drive.
pub fn session_zero() -> bool {
    let mut session = 1u32;
    // SAFETY: valid out-pointer.
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) }.is_ok() && session == 0
}

/// False while the workstation is locked or a UAC prompt holds the secure
/// desktop: input then reaches no app, and posting it does nothing useful.
pub fn input_desktop() -> bool {
    // SAFETY: the desktop handle is closed at once.
    unsafe {
        match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) {
            Ok(d) => {
                let _ = CloseDesktop(d);
                true
            }
            Err(_) => false,
        }
    }
}

fn integrity_of(process: HANDLE) -> Option<u32> {
    // SAFETY: the token is closed on every path; the label buffer is sized by the first call.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let read = GetTokenInformation(token, TokenIntegrityLevel, Some(buf.as_mut_ptr().cast()), len, &mut len);
        let _ = CloseHandle(token);
        read.ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        Some(*GetSidSubAuthority(label.Label.Sid, u32::from(count).checked_sub(1)?))
    }
}

/// Whether User Interface Privilege Isolation stands between this helper and
/// `pid`: its integrity is above ours, as an app run as administrator is to a
/// helper that is not. Windows then drops posted input silently and serves
/// UI Automation only a husk. A token this helper may not even read is one it
/// may not drive either, unless the helper is elevated itself.
pub fn uipi_blocked(pid: u32) -> bool {
    // SAFETY: the pseudo handle needs no closing; the opened one is closed.
    unsafe {
        let ours = integrity_of(GetCurrentProcess()).unwrap_or(0);
        let theirs = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok().and_then(|p| {
            let level = integrity_of(p);
            let _ = CloseHandle(p);
            level
        });
        match theirs {
            Some(level) => level > ours,
            None => ours < HIGH_INTEGRITY,
        }
    }
}
