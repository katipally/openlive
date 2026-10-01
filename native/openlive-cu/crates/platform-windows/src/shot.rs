//! Which part of a captured window picture is the window the model is told about.
//!
//! The frame the helper reports is the DWM extended frame, what the user sees.
//! GetWindowRect adds the invisible resize borders Windows 10 and 11 draw
//! around a window, and PrintWindow (and, for some windows, Windows.Graphics.
//! Capture) delivers that larger rectangle. Cropping to the visible frame keeps
//! a pixel in the picture on the desktop point the core maps it to.

/// A rectangle in physical desktop pixels, as Win32 RECT has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Px {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Px {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

/// `(x, y, width, height)` of the visible frame inside an image of the window,
/// or `None` when the image matches neither rectangle and is scaled whole.
pub fn crop(image: (u32, u32), window: Px, frame: Px) -> Option<(u32, u32, u32, u32)> {
    let size = |r: Px| (r.width().max(0) as u32, r.height().max(0) as u32);
    let (fw, fh) = size(frame);
    if image == (fw, fh) {
        return Some((0, 0, fw, fh));
    }
    if image != size(window) {
        return None;
    }
    let x = (frame.left - window.left).max(0) as u32;
    let y = (frame.top - window.top).max(0) as u32;
    Some((x, y, fw.min(image.0.saturating_sub(x)), fh.min(image.1.saturating_sub(y))))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Px = Px { left: 93, top: 50, right: 1107, bottom: 857 };
    const FRAME: Px = Px { left: 100, top: 50, right: 1100, bottom: 850 };

    #[test]
    fn crops_the_invisible_borders_off_a_full_window_picture() {
        assert_eq!(crop((1014, 807), WINDOW, FRAME), Some((7, 0, 1000, 800)));
    }

    #[test]
    fn a_picture_of_the_frame_is_taken_whole() {
        assert_eq!(crop((1000, 800), WINDOW, FRAME), Some((0, 0, 1000, 800)));
    }

    #[test]
    fn anything_else_is_scaled() {
        assert_eq!(crop((500, 400), WINDOW, FRAME), None);
    }
}
