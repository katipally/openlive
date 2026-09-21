//! Windows delayed rendering. A hidden message-only window owns the clipboard
//! and publishes CF_UNICODETEXT with a null handle; the text is only rendered
//! when a consumer asks for it, and that request is the receipt.

use std::ffi::c_void;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Instant;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_DESTROYCLIPBOARD,
    WM_RENDERALLFORMATS, WM_RENDERFORMAT, WNDCLASSW,
};

use super::Receipt;

struct Promise {
    text: Vec<u16>,
    receipt: Arc<Receipt>,
    started: Instant,
}

static PROMISE: Mutex<Option<Promise>> = Mutex::new(None);
static OWNER: AtomicIsize = AtomicIsize::new(0);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Renders the promised text into a moveable global block, which the
/// clipboard then owns. Ownership passes with SetClipboardData, so the
/// allocation is deliberately not freed here.
fn render() -> Option<()> {
    let guard = PROMISE.lock().ok()?;
    let promise = guard.as_ref()?;
    let bytes = promise.text.len() * std::mem::size_of::<u16>();
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes).ok()?;
        let target = GlobalLock(handle);
        if target.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(promise.text.as_ptr(), target.cast::<u16>(), promise.text.len());
        let _ = GlobalUnlock(handle);
        SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(handle.0 as *mut c_void)).ok()?;
    }
    promise.receipt.mark_read(promise.started.elapsed());
    Some(())
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_RENDERFORMAT | WM_RENDERALLFORMATS => {
            // WM_RENDERALLFORMATS arrives with the clipboard closed.
            let opened = msg == WM_RENDERALLFORMATS && OpenClipboard(hwnd).is_ok();
            render();
            if opened {
                let _ = CloseClipboard();
            }
            LRESULT(0)
        }
        WM_DESTROYCLIPBOARD => {
            if let Ok(mut promise) = PROMISE.lock() {
                *promise = None;
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// One message-only window per process, on its own pumped thread. Created on
/// first use so nothing is spawned for a session that never pastes.
fn owner_window() -> Result<HWND, String> {
    static THREAD: OnceLock<Result<isize, String>> = OnceLock::new();
    let handle = THREAD.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || unsafe {
            let class_name = wide("OpenLiveFlowClipboardOwner");
            let instance = match GetModuleHandleW(None) {
                Ok(instance) => instance,
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                    return;
                }
            };
            let class = WNDCLASSW {
                lpfnWndProc: Some(wnd_proc),
                hInstance: HINSTANCE::from(instance),
                lpszClassName: PCWSTR(class_name.as_ptr()),
                ..Default::default()
            };
            RegisterClassW(&class);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(class_name.as_ptr()),
                PCWSTR(class_name.as_ptr()),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                None,
                HINSTANCE::from(instance),
                None,
            );
            match hwnd {
                Ok(hwnd) => {
                    OWNER.store(hwnd.0 as isize, Ordering::SeqCst);
                    let _ = tx.send(Ok(hwnd.0 as isize));
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
        rx.recv().unwrap_or_else(|e| Err(e.to_string()))
    });
    handle
        .as_ref()
        .map(|h| HWND(*h as *mut c_void))
        .map_err(|e| e.clone())
}

pub fn publish(text: &str, receipt: Arc<Receipt>, started: Instant) -> Result<(), String> {
    let hwnd = owner_window()?;
    *PROMISE.lock().map_err(|_| "clipboard promise lock poisoned")? = Some(Promise {
        text: wide(text),
        receipt,
        started,
    });
    unsafe {
        OpenClipboard(hwnd).map_err(|e| format!("could not open the clipboard: {e}"))?;
        let result = EmptyClipboard()
            .map_err(|e| format!("could not empty the clipboard: {e}"))
            // A null handle is what makes this a promise rather than a value.
            .and_then(|()| {
                SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(std::ptr::null_mut()))
                    .map(|_| ())
                    .map_err(|e| format!("could not publish the clipboard promise: {e}"))
            });
        let _ = CloseClipboard();
        result
    }
}
