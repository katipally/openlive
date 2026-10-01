//! From captured pixels to the picture of one frame, and from a desktop point
//! to the screen-cast stream it lies on, kept free of X11 and PipeWire so it is
//! tested on every OS.
//!
//! A capture is one or more sources, each a picture of a known rectangle of
//! the desktop: on X11 the visible part of a window's frame, on Wayland one
//! monitor per stream, whose picture is in device pixels while its rectangle
//! is in the compositor's logical coordinates. The picture the model gets
//! covers exactly the frame it is told about, so a pixel in it maps onto the
//! frame by one factor per axis, as the core assumes.

use ::image::imageops::{self, FilterType};
use ::image::{Rgba, RgbaImage};
use openlive_cu_core::protocol::Rect;

pub fn intersect(a: &Rect, b: &Rect) -> Option<Rect> {
    let x0 = a.x.max(b.x);
    let y0 = a.y.max(b.y);
    let x1 = (a.x + a.width).min(b.x + b.width);
    let y1 = (a.y + a.height).min(b.y + b.height);
    (x1 > x0 && y1 > y0).then_some(Rect { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
}

pub fn union(rects: &[Rect]) -> Option<Rect> {
    let first = rects.first()?;
    let (mut x0, mut y0, mut x1, mut y1) = (first.x, first.y, first.x + first.width, first.y + first.height);
    for r in &rects[1..] {
        x0 = x0.min(r.x);
        y0 = y0.min(r.y);
        x1 = x1.max(r.x + r.width);
        y1 = y1.max(r.y + r.height);
    }
    Some(Rect { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
}

/// Device pixels per desktop unit across a source.
fn scale(area: &Rect, pixels: &RgbaImage) -> f64 {
    if area.width <= 0.0 { 1.0 } else { f64::from(pixels.width()) / area.width }
}

/// The picture of `target`: every source that overlaps it, cut out and placed
/// where it falls, at the finest scale among them. What no source covers (off
/// every screen) stays black. O(P) for P output pixels.
pub fn compose(sources: &[(Rect, &RgbaImage)], target: Rect) -> Option<RgbaImage> {
    let parts: Vec<(Rect, Rect, &RgbaImage)> = sources.iter().filter_map(|(area, img)| intersect(area, &target).map(|i| (*area, i, *img))).collect();
    let s = parts.iter().map(|(area, _, img)| scale(area, img)).fold(0.0_f64, f64::max);
    if parts.is_empty() || !s.is_finite() || s <= 0.0 {
        return None;
    }
    let px = |v: f64| (v * s).round().max(1.0) as u32;
    let mut out = RgbaImage::from_pixel(px(target.width), px(target.height), Rgba([0, 0, 0, 255]));
    for (area, part, img) in parts {
        let k = scale(&area, img);
        let (cx, cy) = (((part.x - area.x) * k).round() as u32, ((part.y - area.y) * k).round() as u32);
        let cw = ((part.width * k).round() as u32).clamp(1, img.width().saturating_sub(cx).max(1));
        let ch = ((part.height * k).round() as u32).clamp(1, img.height().saturating_sub(cy).max(1));
        let cut = imageops::crop_imm(img, cx.min(img.width() - 1), cy.min(img.height() - 1), cw, ch).to_image();
        let (w, h) = (px(part.width), px(part.height));
        let cut = if cut.dimensions() == (w, h) { cut } else { imageops::resize(&cut, w, h, FilterType::Triangle) };
        imageops::replace(&mut out, &cut, ((part.x - target.x) * s).round() as i64, ((part.y - target.y) * s).round() as i64);
    }
    Some(out)
}

/// One portal screen-cast stream: a PipeWire node and the desktop rectangle it shows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stream {
    pub node: u32,
    /// Logical coordinates. Absent from the portal for a single monitor on some
    /// compositors; the picture's own size stands in then.
    pub area: Option<Rect>,
}

/// The stream a desktop point lies on, and the point in that stream's own
/// logical coordinates (what NotifyPointerMotionAbsolute takes).
pub fn stream_at(streams: &[Stream], x: f64, y: f64) -> Option<(u32, f64, f64)> {
    if let [only] = streams {
        if only.area.is_none() {
            return Some((only.node, x, y));
        }
    }
    streams.iter().find_map(|s| {
        let a = s.area?;
        // The right and bottom edges belong to the stream, so a point at the picture's last pixel still lands.
        (x >= a.x && y >= a.y && x <= a.x + a.width && y <= a.y + a.height).then_some((s.node, x - a.x, y - a.y))
    })
}

/// 32-bit pixels in the order the source names (`BGRx`, `RGBA`, ...) as RGBA,
/// row by row with the source's stride. `None` for a size the bytes cannot hold.
pub fn to_rgba(bytes: &[u8], width: u32, height: u32, stride: usize, order: PixelOrder) -> Option<RgbaImage> {
    let row = width as usize * 4;
    let stride = if stride == 0 { row } else { stride };
    if width == 0 || height == 0 || stride < row || bytes.len() < stride * (height as usize - 1) + row {
        return None;
    }
    let mut out = Vec::with_capacity(row * height as usize);
    for y in 0..height as usize {
        for p in bytes[y * stride..y * stride + row].as_chunks::<4>().0 {
            let (r, g, b, a) = match order {
                PixelOrder::Bgrx => (p[2], p[1], p[0], 255),
                PixelOrder::Bgra => (p[2], p[1], p[0], p[3]),
                PixelOrder::Rgbx => (p[0], p[1], p[2], 255),
                PixelOrder::Rgba => (p[0], p[1], p[2], p[3]),
                PixelOrder::Xrgb => (p[1], p[2], p[3], 255),
                PixelOrder::Xbgr => (p[3], p[2], p[1], 255),
            };
            out.extend_from_slice(&[r, g, b, a]);
        }
    }
    RgbaImage::from_raw(width, height, out)
}

/// Byte order of a 32-bit pixel in memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelOrder {
    Bgrx,
    Bgra,
    Rgbx,
    Rgba,
    Xrgb,
    Xbgr,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, width: w, height: h }
    }

    fn solid(w: u32, h: u32, c: u8) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([c, c, c, 255]))
    }

    #[test]
    fn crops_a_window_out_of_a_hidpi_monitor() {
        // A 2x monitor at logical (0, 0) 1000x500, a window at (100, 50) 200x100.
        let mut monitor = solid(2000, 1000, 10);
        for x in 200..600 {
            for y in 100..300 {
                monitor.put_pixel(x, y, Rgba([200, 200, 200, 255]));
            }
        }
        let out = compose(&[(r(0.0, 0.0, 1000.0, 500.0), &monitor)], r(100.0, 50.0, 200.0, 100.0)).unwrap();
        assert_eq!(out.dimensions(), (400, 200));
        assert!(out.pixels().all(|p| p.0[0] == 200));
    }

    #[test]
    fn a_window_partly_off_screen_keeps_its_full_size() {
        let screen = solid(1000, 500, 90);
        let out = compose(&[(r(0.0, 0.0, 1000.0, 500.0), &screen)], r(900.0, 400.0, 200.0, 200.0)).unwrap();
        assert_eq!(out.dimensions(), (200, 200));
        assert_eq!(out.get_pixel(50, 50).0[0], 90);
        assert_eq!(out.get_pixel(150, 150).0[0], 0);
        assert!(compose(&[(r(0.0, 0.0, 1000.0, 500.0), &screen)], r(2000.0, 0.0, 10.0, 10.0)).is_none());
    }

    #[test]
    fn two_monitors_become_one_desktop() {
        let (left, right) = (solid(100, 100, 1), solid(200, 200, 2));
        let desk = union(&[r(0.0, 0.0, 100.0, 100.0), r(100.0, 0.0, 100.0, 100.0)]).unwrap();
        assert_eq!(desk, r(0.0, 0.0, 200.0, 100.0));
        let out = compose(&[(r(0.0, 0.0, 100.0, 100.0), &left), (r(100.0, 0.0, 100.0, 100.0), &right)], desk).unwrap();
        // The finer monitor sets the scale.
        assert_eq!(out.dimensions(), (400, 200));
        assert_eq!(out.get_pixel(10, 10).0[0], 1);
        assert_eq!(out.get_pixel(390, 10).0[0], 2);
    }

    #[test]
    fn points_land_on_their_stream() {
        let streams = [Stream { node: 7, area: Some(r(0.0, 0.0, 1920.0, 1080.0)) }, Stream { node: 9, area: Some(r(1920.0, 0.0, 1280.0, 1024.0)) }];
        assert_eq!(stream_at(&streams, 10.0, 10.0), Some((7, 10.0, 10.0)));
        assert_eq!(stream_at(&streams, 2000.0, 500.0), Some((9, 80.0, 500.0)));
        assert_eq!(stream_at(&streams, 2000.0, 1050.0), None);
        assert_eq!(stream_at(&[Stream { node: 3, area: None }], 5.0, 6.0), Some((3, 5.0, 6.0)));
    }

    #[test]
    fn converts_pixel_orders_with_padding() {
        // Two pixels a row, one row of padding bytes.
        let bytes = [1, 2, 3, 0, 4, 5, 6, 0, 9, 9, 1, 2, 3, 0, 4, 5, 6, 0];
        let img = to_rgba(&bytes, 2, 2, 10, PixelOrder::Bgrx).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [3, 2, 1, 255]);
        assert_eq!(img.get_pixel(1, 1).0, [6, 5, 4, 255]);
        assert_eq!(to_rgba(&bytes, 3, 2, 10, PixelOrder::Rgba), None);
        assert_eq!(to_rgba(&[1, 2, 3, 4], 1, 1, 0, PixelOrder::Xrgb).unwrap().get_pixel(0, 0).0, [2, 3, 4, 255]);
    }
}
