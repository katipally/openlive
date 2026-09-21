//! Screenshot space and screen space, kept apart by the type system.
//!
//! A `ScreenPoint` is a logical desktop coordinate: the same units the window
//! manager and the synthetic-input APIs speak, with the primary display's
//! top-left at the origin and other displays anywhere around it, including at
//! negative coordinates. A `ShotPoint` is a pixel inside one captured image.
//! On a retina display the two differ by a factor of two, on Windows often by
//! 1.25 or 1.5, and after capping for the model by whatever that took. They
//! are separate structs rather than aliases so a coordinate cannot reach the
//! injection layer without passing through a `Shot`.

/// The model never sees an image larger than this. One `min()` scale keeps
/// the aspect ratio, and the capped size is what gets advertised.
pub const MODEL_MAX_WIDTH: u32 = 1024;
pub const MODEL_MAX_HEIGHT: u32 = 768;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShotPoint {
    pub x: f64,
    pub y: f64,
}

impl ScreenPoint {
    pub fn new(x: f64, y: f64) -> ScreenPoint {
        ScreenPoint { x, y }
    }
}

impl ShotPoint {
    pub fn new(x: f64, y: f64) -> ShotPoint {
        ShotPoint { x, y }
    }
}

/// The geometry a captured image is in: where its top-left sits on the
/// desktop, how many image pixels one logical point buys, and how big the
/// image is. Every image handed out carries one of these.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shot {
    pub origin: ScreenPoint,
    pub scale: f64,
    pub width: u32,
    pub height: u32,
}

impl Shot {
    pub fn new(origin: ScreenPoint, scale: f64, width: u32, height: u32) -> Shot {
        Shot { origin, scale, width, height }
    }

    pub fn to_screen(&self, point: ShotPoint) -> ScreenPoint {
        ScreenPoint {
            x: self.origin.x + point.x / self.scale,
            y: self.origin.y + point.y / self.scale,
        }
    }

    pub fn to_shot(&self, point: ScreenPoint) -> ShotPoint {
        ShotPoint {
            x: (point.x - self.origin.x) * self.scale,
            y: (point.y - self.origin.y) * self.scale,
        }
    }

    /// Never above 1: an image smaller than the cap is left alone rather than
    /// upscaled into a bigger payload carrying no more detail.
    pub fn cap_factor(&self, max_width: u32, max_height: u32) -> f64 {
        if self.width == 0 || self.height == 0 {
            return 1.0;
        }
        let horizontal = f64::from(max_width) / f64::from(self.width);
        let vertical = f64::from(max_height) / f64::from(self.height);
        horizontal.min(vertical).min(1.0)
    }

    /// The geometry of this image resized to fit the cap. Both the advertised
    /// size and the scale move by the same factor, so a point returned
    /// against the capped image converts straight back to screen space.
    pub fn capped(&self, max_width: u32, max_height: u32) -> Shot {
        let factor = self.cap_factor(max_width, max_height);
        Shot {
            origin: self.origin,
            scale: self.scale * factor,
            width: scaled_length(self.width, factor),
            height: scaled_length(self.height, factor),
        }
    }
}

fn scaled_length(length: u32, factor: f64) -> u32 {
    if length == 0 {
        return 0;
    }
    (f64::from(length) * factor).round().max(1.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1.0
    }

    #[test]
    fn a_retina_display_round_trips_at_two_shot_pixels_per_point() {
        let shot = Shot::new(ScreenPoint::new(0.0, 0.0), 2.0, 2880, 1800);
        let screen = shot.to_screen(ShotPoint::new(1000.0, 600.0));
        assert_eq!(screen, ScreenPoint::new(500.0, 300.0));
        assert_eq!(shot.to_shot(screen), ShotPoint::new(1000.0, 600.0));
    }

    #[test]
    fn a_non_integer_windows_scale_round_trips() {
        let shot = Shot::new(ScreenPoint::new(0.0, 0.0), 1.5, 2880, 1620);
        let screen = shot.to_screen(ShotPoint::new(600.0, 300.0));
        assert_eq!(screen, ScreenPoint::new(400.0, 200.0));
        assert_eq!(shot.to_shot(screen), ShotPoint::new(600.0, 300.0));
    }

    #[test]
    fn a_display_left_of_the_primary_keeps_its_negative_origin() {
        let shot = Shot::new(ScreenPoint::new(-1920.0, -200.0), 1.0, 1920, 1080);
        assert_eq!(shot.to_screen(ShotPoint::new(0.0, 0.0)), ScreenPoint::new(-1920.0, -200.0));
        assert_eq!(shot.to_screen(ShotPoint::new(1920.0, 1080.0)), ScreenPoint::new(0.0, 880.0));
        assert_eq!(
            shot.to_shot(ScreenPoint::new(-960.0, 340.0)),
            ShotPoint::new(960.0, 540.0)
        );
    }

    #[test]
    fn a_portrait_display_caps_on_its_height() {
        let shot = Shot::new(ScreenPoint::new(0.0, 0.0), 1.0, 1080, 1920);
        let capped = shot.capped(MODEL_MAX_WIDTH, MODEL_MAX_HEIGHT);
        assert_eq!(capped.height, MODEL_MAX_HEIGHT);
        assert_eq!(capped.width, 432);
        let aspect = |s: &Shot| f64::from(s.width) / f64::from(s.height);
        assert!((aspect(&capped) - aspect(&shot)).abs() < 0.01);
    }

    #[test]
    fn a_display_larger_than_the_cap_shrinks_on_one_factor() {
        let shot = Shot::new(ScreenPoint::new(0.0, 0.0), 2.0, 3840, 2160);
        let capped = shot.capped(MODEL_MAX_WIDTH, MODEL_MAX_HEIGHT);
        assert_eq!(capped.width, MODEL_MAX_WIDTH);
        assert_eq!(capped.height, 576);
        assert_eq!(capped.scale, 2.0 * (1024.0 / 3840.0));
    }

    #[test]
    fn a_display_smaller_than_the_cap_is_not_upscaled() {
        let shot = Shot::new(ScreenPoint::new(0.0, 0.0), 1.0, 800, 600);
        let capped = shot.capped(MODEL_MAX_WIDTH, MODEL_MAX_HEIGHT);
        assert_eq!(capped, shot);
    }

    #[test]
    fn a_point_survives_capture_capping_and_the_way_back() {
        let displays = [
            Shot::new(ScreenPoint::new(0.0, 0.0), 2.0, 3840, 2400),
            Shot::new(ScreenPoint::new(-2560.0, -300.0), 1.5, 3840, 2160),
            Shot::new(ScreenPoint::new(1920.0, 0.0), 1.0, 1080, 1920),
        ];
        for shot in displays {
            let capped = shot.capped(MODEL_MAX_WIDTH, MODEL_MAX_HEIGHT);
            for fraction in [0.0, 0.25, 0.5, 0.9, 1.0] {
                let start = ScreenPoint::new(
                    shot.origin.x + f64::from(shot.width) / shot.scale * fraction,
                    shot.origin.y + f64::from(shot.height) / shot.scale * fraction,
                );
                let model_point = capped.to_shot(start);
                let back = capped.to_screen(model_point);
                assert!(close(back.x, start.x) && close(back.y, start.y), "{back:?} vs {start:?}");
            }
        }
    }

    #[test]
    fn a_zero_sized_shot_does_not_divide_by_zero() {
        let shot = Shot::new(ScreenPoint::new(0.0, 0.0), 1.0, 0, 0);
        assert_eq!(shot.cap_factor(MODEL_MAX_WIDTH, MODEL_MAX_HEIGHT), 1.0);
        assert_eq!(shot.capped(MODEL_MAX_WIDTH, MODEL_MAX_HEIGHT), shot);
    }
}
