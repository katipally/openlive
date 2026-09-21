//! Save and restore of the user's clipboard, plus the plain (non-lazy) write
//! used where the platform has no delayed-rendering mechanism.

use arboard::{Clipboard, ImageData};

pub enum Saved {
    Text(String),
    Image(ImageData<'static>),
    Empty,
}

fn clipboard() -> Result<Clipboard, String> {
    Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))
}

/// Text first. Reading an image decodes the whole bitmap, so that only
/// happens when there is no text to take instead.
pub fn save() -> Saved {
    let Ok(mut cb) = clipboard() else {
        return Saved::Empty;
    };
    if let Ok(text) = cb.get_text() {
        return Saved::Text(text);
    }
    match cb.get_image() {
        Ok(image) => Saved::Image(image.to_owned_img()),
        Err(_) => Saved::Empty,
    }
}

pub fn restore(saved: &Saved) -> Result<(), String> {
    let mut cb = clipboard()?;
    match saved {
        Saved::Text(text) => cb.set_text(text.clone()).map_err(|e| e.to_string()),
        Saved::Image(image) => cb.set_image(image.clone()).map_err(|e| e.to_string()),
        Saved::Empty => cb.clear().map_err(|e| e.to_string()),
    }
}

pub fn set_text(text: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use crate::platform::linux;
        if linux::is_wayland() && linux::which("wl-copy").is_some() {
            return linux::wl_copy(text);
        }
    }
    clipboard()?.set_text(text.to_string()).map_err(|e| e.to_string())
}

/// Used for the ownership check: if this no longer matches what we published,
/// the user copied something of their own and it must not be overwritten.
pub fn current_text() -> Option<String> {
    clipboard().ok()?.get_text().ok()
}
