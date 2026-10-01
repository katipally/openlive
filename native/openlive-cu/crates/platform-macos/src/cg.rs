//! The window server's list of windows: ids, owners, frames and z-order.

use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFNumber, CFString, CFType, CGRect};
use objc2_core_graphics::{
    kCGWindowAlpha, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowName, kCGWindowNumber,
    kCGWindowOwnerName, kCGWindowOwnerPID, CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo,
    CGWindowListOption,
};
use openlive_cu_core::protocol::Rect;

/// Smaller than this on either side is a tooltip, a badge or a drag shadow, not a window to work in.
const MIN_SIDE: f64 = 48.0;

#[derive(Debug, Clone)]
pub struct CgWindow {
    pub id: u32,
    pub pid: i32,
    pub owner: String,
    /// Withheld by the window server without Screen Recording.
    pub title: Option<String>,
    pub frame: Rect,
    pub on_screen: bool,
}

/// Normal windows on screen, front to back. O(w) in the window server's list.
pub fn windows() -> Vec<CgWindow> {
    let opts = CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(opts, 0) else { return Vec::new() };
    let list: &CFArray<CFDictionary> = unsafe { list.cast_unchecked() };
    list.iter().filter_map(|d| {
        // SAFETY: every entry of the window list is a CFString-keyed dictionary.
        let d: &CFDictionary<CFString, CFType> = unsafe { &*(&*d as *const CFDictionary as *const CFDictionary<CFString, CFType>) };
        let get = |k: &CFString| d.get(k);
        let num = |k: &CFString| get(k).and_then(|v| v.downcast_ref::<CFNumber>().and_then(CFNumber::as_f64));
        let text = |k: &CFString| get(k).and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string())).filter(|s| !s.is_empty());
        // SAFETY: the window server's own keys.
        unsafe {
            if num(kCGWindowLayer)? != 0.0 || num(kCGWindowAlpha).unwrap_or(1.0) <= 0.01 {
                return None;
            }
            let bounds = get(kCGWindowBounds)?;
            let mut rect = CGRect::default();
            if !CGRectMakeWithDictionaryRepresentation(Some(bounds.downcast_ref::<CFDictionary>()?), &mut rect) {
                return None;
            }
            if rect.size.width < MIN_SIDE || rect.size.height < MIN_SIDE {
                return None;
            }
            Some(CgWindow {
                id: num(kCGWindowNumber)? as u32,
                pid: num(kCGWindowOwnerPID)? as i32,
                owner: text(kCGWindowOwnerName).unwrap_or_default(),
                title: text(kCGWindowName),
                frame: Rect { x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height },
                on_screen: get(kCGWindowIsOnscreen).and_then(|v| v.downcast_ref::<CFBoolean>().map(|b| b.as_bool())).unwrap_or(true),
            })
        }
    }).collect()
}
