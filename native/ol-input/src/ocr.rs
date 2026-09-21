//! Text extraction with bounding boxes.
//!
//! The platform's own engine does the work: Vision on macOS, the Windows OCR
//! API, and tesseract on Linux when it happens to be installed. No model is
//! bundled, so on a Linux box without tesseract the capability is reported
//! absent rather than faked.

use crate::coords::{ScreenPoint, Shot};
use crate::platform::desktop::current as platform;

#[derive(Debug, Clone, PartialEq)]
pub struct TextBox {
    pub text: String,
    /// 0 to 1. Engines that do not report one say 1.0.
    pub confidence: f32,
    /// Where the text is on the desktop, so a caller can click it without
    /// having to know which image it came out of.
    pub origin: ScreenPoint,
    pub width: f64,
    pub height: f64,
}

/// Boxes in the image's own pixels, as every engine reports them, before
/// they are lifted back into screen space.
pub struct ShotBox {
    pub text: String,
    pub confidence: f32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn read(png: &[u8], shot: Shot) -> Result<Vec<TextBox>, String> {
    if png.is_empty() {
        return Err("ocr needs an image".into());
    }
    let boxes = platform::ocr(png, f64::from(shot.width), f64::from(shot.height))?;
    Ok(boxes
        .into_iter()
        .map(|found| TextBox {
            text: found.text,
            confidence: found.confidence,
            origin: shot.to_screen(crate::coords::ShotPoint::new(found.x, found.y)),
            width: found.width / shot.scale,
            height: found.height / shot.scale,
        })
        .collect())
}
