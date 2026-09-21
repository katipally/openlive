//! Screen, window and region capture.
//!
//! Nothing here hands back a bare buffer. Every capture carries the `Shot` it
//! is in, so the geometry travels with the pixels and a point picked out of
//! the image can always be turned back into a screen coordinate. Capping for
//! the model happens here too, because the capped size is the size that gets
//! advertised.

use crate::coords::{ScreenPoint, Shot, MODEL_MAX_HEIGHT, MODEL_MAX_WIDTH};
use crate::platform::desktop::current as platform;

#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    /// Stable for as long as the display stays attached. macOS reuses its
    /// CGDirectDisplayID, Windows its monitor handle ordinal.
    pub id: u32,
    pub name: String,
    pub origin: ScreenPoint,
    /// Logical size, the units a click is in.
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub primary: bool,
}

/// Raw pixels straight off the platform, before capping or encoding.
pub struct Bitmap {
    pub rgba: Vec<u8>,
    pub shot: Shot,
}

pub struct Capture {
    pub png: Vec<u8>,
    pub shot: Shot,
}

pub fn displays() -> Result<Vec<Display>, String> {
    platform::displays()
}

pub fn display(id: u32) -> Result<Capture, String> {
    encode(platform::capture_display(id)?)
}

pub fn window(id: u32) -> Result<Capture, String> {
    encode(platform::capture_window(id)?)
}

pub fn region(origin: ScreenPoint, width: f64, height: f64) -> Result<Capture, String> {
    if width <= 0.0 || height <= 0.0 {
        return Err("a capture region needs a positive width and height".into());
    }
    encode(platform::capture_region(origin, width, height)?)
}

fn encode(bitmap: Bitmap) -> Result<Capture, String> {
    let capped = bitmap.shot.capped(MODEL_MAX_WIDTH, MODEL_MAX_HEIGHT);
    let rgba = if capped.width == bitmap.shot.width && capped.height == bitmap.shot.height {
        bitmap.rgba
    } else {
        downscale(&bitmap.rgba, bitmap.shot.width, bitmap.shot.height, capped.width, capped.height)
    };
    Ok(Capture { png: png(&rgba, capped.width, capped.height)?, shot: capped })
}

/// Box average rather than nearest neighbour: text at a 3x reduction is the
/// whole point of the capture, and dropping pixels loses it.
fn downscale(rgba: &[u8], width: u32, height: u32, new_width: u32, new_height: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((new_width * new_height * 4) as usize);
    for row in 0..new_height {
        let top = (u64::from(row) * u64::from(height) / u64::from(new_height)) as u32;
        let bottom = (((u64::from(row) + 1) * u64::from(height) / u64::from(new_height)) as u32)
            .max(top + 1)
            .min(height);
        for column in 0..new_width {
            let left = (u64::from(column) * u64::from(width) / u64::from(new_width)) as u32;
            let right = (((u64::from(column) + 1) * u64::from(width) / u64::from(new_width))
                as u32)
                .max(left + 1)
                .min(width);
            let mut totals = [0u32; 4];
            let mut count = 0u32;
            for y in top..bottom {
                let start = ((y * width + left) * 4) as usize;
                let end = ((y * width + right) * 4) as usize;
                for pixel in rgba[start..end].chunks_exact(4) {
                    for (total, channel) in totals.iter_mut().zip(pixel) {
                        *total += u32::from(*channel);
                    }
                    count += 1;
                }
            }
            let count = count.max(1);
            out.extend(totals.iter().map(|total| (total / count) as u8));
        }
    }
    out
}

fn png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, colour: [u8; 4]) -> Vec<u8> {
        colour.iter().copied().cycle().take((width * height * 4) as usize).collect()
    }

    #[test]
    fn a_downscale_keeps_a_solid_colour_solid() {
        let source = solid(64, 40, [10, 20, 30, 255]);
        let out = downscale(&source, 64, 40, 16, 10);
        assert_eq!(out.len(), 16 * 10 * 4);
        assert!(out.chunks_exact(4).all(|pixel| pixel == [10, 20, 30, 255]));
    }

    #[test]
    fn a_downscale_averages_rather_than_dropping_pixels() {
        let mut source = solid(2, 1, [0, 0, 0, 255]);
        source[0..4].copy_from_slice(&[255, 255, 255, 255]);
        let out = downscale(&source, 2, 1, 1, 1);
        assert_eq!(out, vec![127, 127, 127, 255]);
    }

    #[test]
    fn an_encoded_capture_advertises_the_capped_size() {
        let shot = Shot::new(ScreenPoint::new(0.0, 0.0), 2.0, 2048, 1536);
        let capture = encode(Bitmap { rgba: solid(2048, 1536, [1, 2, 3, 255]), shot }).unwrap();
        assert_eq!((capture.shot.width, capture.shot.height), (1024, 768));
        assert_eq!(capture.shot.scale, 1.0);
        assert_eq!(&capture.png[1..4], b"PNG");
    }
}
