//! The two SPA pods a one-frame PipeWire capture needs, built and read in plain
//! Rust so they are tested on every OS: the formats the helper accepts, and
//! the format the stream settled on.
//!
//! A pod is a little-endian `u32` body size, a `u32` type, and the body,
//! padded to 8 bytes. Constants are from spa/utils/type.h, spa/param/param.h,
//! spa/param/format.h and spa/param/video/raw.h, all part of PipeWire's ABI.

use crate::geom::PixelOrder;

const TYPE_ID: u32 = 3;
const TYPE_RECTANGLE: u32 = 10;
const TYPE_FRACTION: u32 = 11;
const TYPE_OBJECT: u32 = 15;
const TYPE_CHOICE: u32 = 19;
const OBJECT_FORMAT: u32 = 0x40003;
pub const PARAM_ENUM_FORMAT: u32 = 3;
pub const PARAM_FORMAT: u32 = 4;
const CHOICE_RANGE: u32 = 1;
const CHOICE_ENUM: u32 = 3;
const FORMAT_MEDIA_TYPE: u32 = 1;
const FORMAT_MEDIA_SUBTYPE: u32 = 2;
const FORMAT_VIDEO_FORMAT: u32 = 0x20001;
const FORMAT_VIDEO_SIZE: u32 = 0x20003;
const FORMAT_VIDEO_FRAMERATE: u32 = 0x20004;
const MEDIA_TYPE_VIDEO: u32 = 2;
const MEDIA_SUBTYPE_RAW: u32 = 1;

const VIDEO_RGBX: u32 = 7;
const VIDEO_BGRX: u32 = 8;
const VIDEO_XRGB: u32 = 9;
const VIDEO_XBGR: u32 = 10;
const VIDEO_RGBA: u32 = 11;
const VIDEO_BGRA: u32 = 12;

/// The 32-bit formats a compositor hands out for a screen, BGRx first (what Mutter and KWin prefer).
const OFFERED: &[u32] = &[VIDEO_BGRX, VIDEO_BGRA, VIDEO_RGBX, VIDEO_RGBA, VIDEO_XRGB, VIDEO_XBGR];

pub fn pixel_order(format: u32) -> Option<PixelOrder> {
    Some(match format {
        VIDEO_BGRX => PixelOrder::Bgrx,
        VIDEO_BGRA => PixelOrder::Bgra,
        VIDEO_RGBX => PixelOrder::Rgbx,
        VIDEO_RGBA => PixelOrder::Rgba,
        VIDEO_XRGB => PixelOrder::Xrgb,
        VIDEO_XBGR => PixelOrder::Xbgr,
        _ => return None,
    })
}

fn pad8(out: &mut Vec<u8>) {
    while !out.len().is_multiple_of(8) {
        out.push(0);
    }
}

fn words(out: &mut Vec<u8>, ws: &[u32]) {
    for w in ws {
        out.extend_from_slice(&w.to_le_bytes());
    }
}

/// A pod of `type_` around `body`, padded.
fn pod(type_: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + body.len() + 7);
    words(&mut out, &[body.len() as u32, type_]);
    out.extend_from_slice(body);
    pad8(&mut out);
    out
}

fn id(v: u32) -> Vec<u8> {
    pod(TYPE_ID, &v.to_le_bytes())
}

/// A choice of `kind` over values of one child type, each `child_size` bytes.
fn choice(kind: u32, child_type: u32, child_size: u32, values: &[u32]) -> Vec<u8> {
    let mut body = Vec::new();
    words(&mut body, &[kind, 0, child_size, child_type]);
    words(&mut body, values);
    pod(TYPE_CHOICE, &body)
}

fn prop(out: &mut Vec<u8>, key: u32, value: &[u8]) {
    words(out, &[key, 0]);
    out.extend_from_slice(value);
}

/// `EnumFormat`: raw video in any 32-bit RGB order, any size, any rate. No
/// modifier is offered, so buffers arrive as shared memory, never DMA-BUF.
pub fn enum_format() -> Vec<u8> {
    let mut body = Vec::new();
    words(&mut body, &[OBJECT_FORMAT, PARAM_ENUM_FORMAT]);
    prop(&mut body, FORMAT_MEDIA_TYPE, &id(MEDIA_TYPE_VIDEO));
    prop(&mut body, FORMAT_MEDIA_SUBTYPE, &id(MEDIA_SUBTYPE_RAW));
    let formats: Vec<u32> = std::iter::once(OFFERED[0]).chain(OFFERED.iter().copied()).collect();
    prop(&mut body, FORMAT_VIDEO_FORMAT, &choice(CHOICE_ENUM, TYPE_ID, 4, &formats));
    prop(&mut body, FORMAT_VIDEO_SIZE, &choice(CHOICE_RANGE, TYPE_RECTANGLE, 8, &[1920, 1080, 1, 1, 16384, 16384]));
    prop(&mut body, FORMAT_VIDEO_FRAMERATE, &choice(CHOICE_RANGE, TYPE_FRACTION, 8, &[30, 1, 0, 1, 1000, 1]));
    pod(TYPE_OBJECT, &body)
}

/// The format a stream settled on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoFormat {
    pub format: u32,
    pub width: u32,
    pub height: u32,
}

fn word(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
}

/// The first value of a property: the value itself, or a choice's default.
fn value(b: &[u8], at: usize) -> Option<(u32, &[u8])> {
    let size = word(b, at)? as usize;
    let ty = word(b, at + 4)?;
    let body = b.get(at + 8..at + 8 + size)?;
    if ty != TYPE_CHOICE {
        return Some((ty, body));
    }
    let child_size = word(body, 8)? as usize;
    let child_type = word(body, 12)?;
    Some((child_type, body.get(16..16 + child_size)?))
}

/// Read a `Format` object. `None` for anything that is not raw video with a format and a size.
pub fn parse_format(b: &[u8]) -> Option<VideoFormat> {
    let size = word(b, 0)? as usize;
    if word(b, 4)? != TYPE_OBJECT || b.len() < 8 + size || word(b, 8)? != OBJECT_FORMAT {
        return None;
    }
    let end = 8 + size;
    let (mut at, mut format, mut dims, mut raw) = (16, None, None, true);
    while at + 16 <= end {
        let key = word(b, at)?;
        let (ty, v) = value(b, at + 8)?;
        match (key, ty) {
            (FORMAT_MEDIA_SUBTYPE, TYPE_ID) => raw = word(v, 0)? == MEDIA_SUBTYPE_RAW,
            (FORMAT_VIDEO_FORMAT, TYPE_ID) => format = word(v, 0),
            (FORMAT_VIDEO_SIZE, TYPE_RECTANGLE) => dims = Some((word(v, 0)?, word(v, 4)?)),
            _ => {}
        }
        let pod_size = word(b, at + 8)? as usize;
        at += 8 + 8 + pod_size.div_ceil(8) * 8;
    }
    let (width, height) = dims?;
    (raw && width > 0 && height > 0).then_some(VideoFormat { format: format?, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHOICE_NONE: u32 = 0;

    #[test]
    fn the_offer_is_a_well_formed_format_object() {
        let p = enum_format();
        assert_eq!(p.len() % 8, 0);
        assert_eq!(word(&p, 0).unwrap() as usize, p.len() - 8);
        assert_eq!((word(&p, 4), word(&p, 8), word(&p, 12)), (Some(TYPE_OBJECT), Some(OBJECT_FORMAT), Some(PARAM_ENUM_FORMAT)));
        // mediaType: key, flags, then an Id pod holding video, padded to 8.
        assert_eq!(&p[16..40], &[1, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
        // The formats choice is an enum of ids whose default is BGRx.
        let (ty, v) = value(&p, 72).unwrap();
        assert_eq!((ty, word(v, 0)), (TYPE_ID, Some(VIDEO_BGRX)));
    }

    /// A fixated Format as a compositor sends it, with one value wrapped in a None choice as some do.
    fn settled(format: u32, w: u32, h: u32, wrap: bool) -> Vec<u8> {
        let mut body = Vec::new();
        words(&mut body, &[OBJECT_FORMAT, PARAM_FORMAT]);
        prop(&mut body, FORMAT_MEDIA_TYPE, &id(MEDIA_TYPE_VIDEO));
        prop(&mut body, FORMAT_MEDIA_SUBTYPE, &id(MEDIA_SUBTYPE_RAW));
        let f = if wrap { choice(CHOICE_NONE, TYPE_ID, 4, &[format]) } else { id(format) };
        prop(&mut body, FORMAT_VIDEO_FORMAT, &f);
        prop(&mut body, FORMAT_VIDEO_SIZE, &pod(TYPE_RECTANGLE, &[w.to_le_bytes(), h.to_le_bytes()].concat()));
        prop(&mut body, FORMAT_VIDEO_FRAMERATE, &pod(TYPE_FRACTION, &[0u32.to_le_bytes(), 1u32.to_le_bytes()].concat()));
        pod(TYPE_OBJECT, &body)
    }

    #[test]
    fn reads_the_settled_format() {
        assert_eq!(parse_format(&settled(VIDEO_BGRX, 2560, 1440, false)), Some(VideoFormat { format: VIDEO_BGRX, width: 2560, height: 1440 }));
        assert_eq!(parse_format(&settled(VIDEO_RGBA, 800, 600, true)).map(|f| f.format), Some(VIDEO_RGBA));
        assert_eq!(pixel_order(VIDEO_BGRX), Some(PixelOrder::Bgrx));
        assert_eq!(pixel_order(2), None);
    }

    #[test]
    fn refuses_what_is_not_a_video_format() {
        assert_eq!(parse_format(&[]), None);
        assert_eq!(parse_format(&id(3)), None);
        let mut cut = settled(VIDEO_BGRX, 10, 10, false);
        cut.truncate(40);
        assert_eq!(parse_format(&cut), None);
        assert_eq!(parse_format(&settled(VIDEO_BGRX, 0, 10, false)), None);
        // Our own offer parses as its defaults.
        assert_eq!(parse_format(&enum_format()), Some(VideoFormat { format: VIDEO_BGRX, width: 1920, height: 1080 }));
    }
}
