//! From a pixel in the picture the model was shown to a point on the desktop.
//!
//! The screenshot is of one window, scaled to fit the image policy, so a pixel
//! maps onto the window's frame by one factor per axis. That is the whole
//! conversion, and it lives here so no backend redoes it differently.

use crate::protocol::{CuError, Rect};

/// The window an image was taken of and the size it was delivered at.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShotGeometry {
    /// Desktop points.
    pub frame: Rect,
    /// Image pixels.
    pub width: u32,
    pub height: u32,
}

impl ShotGeometry {
    /// A point in the image to desktop points. A point outside the image is
    /// refused: it is what a model sends when it answers in the display's
    /// resolution instead of the picture's, and clicking there hits whatever
    /// happens to be underneath.
    pub fn to_screen(&self, x: f64, y: f64) -> Result<(f64, f64), CuError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(CuError::invalid(format!("({x}, {y}) is not a position in the picture")));
        }
        let (w, h) = (f64::from(self.width), f64::from(self.height));
        if x < 0.0 || y < 0.0 || x > w || y > h {
            return Err(CuError::invalid(format!(
                "({}, {}) is outside the {} by {} picture of this window; use that picture's coordinates",
                x.round(), y.round(), self.width, self.height
            )));
        }
        Ok((self.frame.x + x * self.frame.width / w, self.frame.y + y * self.frame.height / h))
    }
}

/// The largest size within `max_long_edge` with the same aspect ratio. Never upscales.
pub fn fit(width: u32, height: u32, max_long_edge: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= max_long_edge || long == 0 {
        return (width.max(1), height.max(1));
    }
    let scale = f64::from(max_long_edge) / f64::from(long);
    let shrink = |v: u32| ((f64::from(v) * scale).round() as u32).max(1);
    (shrink(width), shrink(height))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Rect = Rect { x: 100.0, y: 50.0, width: 800.0, height: 600.0 };

    #[test]
    fn maps_pixels_onto_the_window_frame() {
        // A 2x Retina window captured at 1280 wide: 1.6 pixels per point.
        let shot = ShotGeometry { frame: WINDOW, width: 1280, height: 960 };
        assert_eq!(shot.to_screen(0.0, 0.0).unwrap(), (100.0, 50.0));
        assert_eq!(shot.to_screen(640.0, 480.0).unwrap(), (500.0, 350.0));
        assert_eq!(shot.to_screen(1280.0, 960.0).unwrap(), (900.0, 650.0));
    }

    #[test]
    fn refuses_points_off_the_picture() {
        let shot = ShotGeometry { frame: WINDOW, width: 1280, height: 960 };
        assert!(shot.to_screen(1281.0, 10.0).is_err());
        assert!(shot.to_screen(-1.0, 10.0).is_err());
        assert!(shot.to_screen(f64::NAN, 10.0).is_err());
    }

    #[test]
    fn fits_the_long_edge_and_keeps_the_aspect() {
        assert_eq!(fit(2560, 1600, 1280), (1280, 800));
        assert_eq!(fit(1200, 3000, 1280), (512, 1280));
        assert_eq!(fit(800, 600, 1280), (800, 600));
        assert_eq!(fit(5000, 1, 1280), (1280, 1));
        assert_eq!(fit(0, 0, 1280), (1, 1));
    }
}
