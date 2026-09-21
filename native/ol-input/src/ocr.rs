//! Text extraction with bounding boxes.
//!
//! The platform's own engine does the work: Vision on macOS, the Windows OCR
//! API, and tesseract on Linux when it happens to be installed. No model is
//! bundled, so on a Linux box without tesseract the capability is reported
//! absent rather than faked.

use crate::coords::{Shot, ShotPoint};
use crate::platform::desktop::current as platform;

#[derive(Debug, Clone, PartialEq)]
pub struct TextBox {
    pub text: String,
    /// 0 to 1. Engines that do not report one say 1.0.
    pub confidence: f32,
    /// Where the text sits in the image it was read from, which is the one
    /// space a caller ever points in. `shot_to_screen` is what turns it into
    /// something clickable, exactly as for a pixel the model picked itself.
    pub origin: ShotPoint,
    pub width: f64,
    pub height: f64,
}

/// Boxes in the image's own pixels, as every engine reports them and as
/// they are handed out.
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
    Ok(boxes.into_iter().map(found).collect())
}

/// The engine already read the image, so there is nothing to convert: doing it
/// here as well would move every box by the display's scale factor.
fn found(read: ShotBox) -> TextBox {
    TextBox {
        text: read.text,
        confidence: read.confidence,
        origin: ShotPoint::new(read.x, read.y),
        width: read.width,
        height: read.height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::ScreenPoint;

    /// A 2880x1800 retina display capped to 1024 for the model.
    fn retina() -> Shot {
        Shot::new(ScreenPoint::new(0.0, 0.0), 2.0, 2880, 1800)
            .capped(crate::coords::MODEL_MAX_WIDTH, crate::coords::MODEL_MAX_HEIGHT)
    }

    #[test]
    fn a_box_stays_in_the_image_the_engine_read() {
        let button = found(ShotBox {
            text: "Send".into(),
            confidence: 1.0,
            x: 500.0,
            y: 300.0,
            width: 40.0,
            height: 20.0,
        });
        assert_eq!(button.origin, ShotPoint::new(500.0, 300.0));
        assert_eq!(button.width, 40.0);

        // And converting it once, the way a click does, lands on the button.
        let shot = retina();
        assert_eq!(shot.to_shot(shot.to_screen(button.origin)), button.origin);
    }
}
