//! What a screenshot costs on the wire, decided once for every platform.
//!
//! ol-input caps pictures at 1024x768, the XGA size the first computer-use
//! models were trained around. The helper shows one window, not a display,
//! and leads with the accessibility tree, so the picture is the model's second
//! source rather than its only one. 1280 on the long edge keeps body text in a
//! 2x window legible (a 1600-point window lands at 0.8 pixels per point instead
//! of 0.64), stays inside every current vision model's no-resize limit (1568
//! for Claude, 2048 for OpenAI's high detail), and a 1280x800 frame is about
//! 1.0 megapixels, roughly 1,400 image tokens. Bigger buys little: the tree
//! already names what is on screen.

use crate::geometry::fit;
use ::image::codecs::jpeg::JpegEncoder;
use ::image::codecs::png::PngEncoder;
use ::image::imageops::FilterType;
use ::image::{DynamicImage, ImageEncoder, RgbaImage};

pub const MAX_LONG_EDGE: u32 = 1280;
/// About what a provider takes per image comfortably after base64 (+33%), and
/// small enough that a screenshot after every action does not swamp a turn.
pub const MAX_BYTES: usize = 900_000;
/// Measured on real 1280-wide window captures: at 90 the 11 px text and the
/// coloured status words read as they do in the PNG, Vision's OCR returns the
/// same words, and the file is half the PNG's size. 80 rings around coloured text.
const JPEG_QUALITY: u8 = 90;
/// Below this the picture stops being worth sending; the best attempt goes as is.
const MIN_LONG_EDGE: u32 = 320;
const SHRINK: f64 = 0.8;

#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// Whichever of PNG and JPEG is smaller at full size (a flat UI stays PNG,
/// which keeps it exact; a busy one goes JPEG at half the bytes or less), then
/// JPEG smaller by a fifth per step until it fits. Every picture kept in a
/// transcript is uploaded again with each step, so bytes are latency. Image
/// tokens follow the pixel size, not the format, so they do not change.
/// O(k * w * h) for k shrink steps, k <= 7 from 1280 down to 320.
pub fn encode(rgba: RgbaImage) -> Result<Encoded, String> {
    encode_within(rgba, MAX_BYTES)
}

fn encode_within(rgba: RgbaImage, budget: usize) -> Result<Encoded, String> {
    let (w, h) = fit(rgba.width(), rgba.height(), MAX_LONG_EDGE);
    let mut img = if (w, h) == rgba.dimensions() { rgba } else { ::image::imageops::resize(&rgba, w, h, FilterType::Triangle) };
    let png = png(&img)?;
    let mut lossy = jpeg(&img)?;
    if png.bytes.len() <= lossy.bytes.len().min(budget) {
        return Ok(png);
    }
    loop {
        let long = img.width().max(img.height());
        if lossy.bytes.len() <= budget || long <= MIN_LONG_EDGE {
            return Ok(lossy);
        }
        let (w, h) = fit(img.width(), img.height(), ((f64::from(long) * SHRINK) as u32).max(MIN_LONG_EDGE));
        img = ::image::imageops::resize(&img, w, h, FilterType::Triangle);
        lossy = jpeg(&img)?;
    }
}

fn png(img: &RgbaImage) -> Result<Encoded, String> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(img.as_raw(), img.width(), img.height(), ::image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(Encoded { bytes, mime: "image/png", width: img.width(), height: img.height() })
}

fn jpeg(img: &RgbaImage) -> Result<Encoded, String> {
    let rgb = DynamicImage::ImageRgba8(img.clone()).to_rgb8();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, JPEG_QUALITY)
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ::image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(Encoded { bytes, mime: "image/jpeg", width: img.width(), height: img.height() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, ::image::Rgba([240, 240, 240, 255]))
    }

    /// Pseudo-random pixels: the worst case for both codecs.
    fn noise(w: u32, h: u32) -> RgbaImage {
        let mut s: u32 = 0x9e37_79b9;
        RgbaImage::from_fn(w, h, |_, _| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            let [a, b, c, _] = s.to_le_bytes();
            ::image::Rgba([a, b, c, 255])
        })
    }

    #[test]
    fn a_flat_ui_stays_png_at_full_size() {
        let e = encode(flat(1280, 800)).unwrap();
        assert_eq!((e.mime, e.width, e.height), ("image/png", 1280, 800));
        assert!(e.bytes.len() <= MAX_BYTES);
    }

    #[test]
    fn a_busy_window_goes_jpeg_at_full_size_when_that_is_smaller() {
        // Fits as PNG too, so only the size comparison picks JPEG.
        let img = noise(400, 250);
        let png_len = png(&img).unwrap().bytes.len();
        let e = encode(img).unwrap();
        assert_eq!((e.mime, e.width, e.height), ("image/jpeg", 400, 250));
        assert!(e.bytes.len() < png_len, "{} >= {png_len}", e.bytes.len());
    }

    #[test]
    fn a_flat_ui_is_png_because_png_is_smaller() {
        let img = flat(1280, 800);
        assert!(png(&img).unwrap().bytes.len() < jpeg(&img).unwrap().bytes.len());
    }

    #[test]
    fn a_retina_window_is_scaled_to_the_long_edge() {
        let e = encode(flat(2880, 1800)).unwrap();
        assert_eq!((e.width, e.height), (1280, 800));
    }

    #[test]
    fn noise_falls_back_to_jpeg_and_shrinks_until_it_fits() {
        let e = encode_within(noise(1280, 800), 200_000).unwrap();
        assert_eq!(e.mime, "image/jpeg");
        assert!(e.bytes.len() <= 200_000, "{} bytes", e.bytes.len());
        assert!(e.width < 1280);
        // The aspect ratio survives every step.
        let ratio = f64::from(e.width) / f64::from(e.height);
        assert!((ratio - 1.6).abs() < 0.02, "{ratio}");
    }

    #[test]
    fn gives_up_shrinking_at_the_floor() {
        let e = encode_within(noise(1280, 800), 10).unwrap();
        assert_eq!(e.width.max(e.height), MIN_LONG_EDGE);
    }
}
