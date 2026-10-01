//! One window's pixels through ScreenCaptureKit's SCScreenshotManager.
//!
//! CGWindowListCreateImage, which ol-input still uses, is obsoleted in macOS 15
//! and draws a prompt on every new release; SCScreenshotManager is its
//! replacement and needs macOS 14. ScreenCaptureKit scales the frame to the
//! requested size itself, so the picture arrives already within the policy.

use block2::RcBlock;
use image::RgbaImage;
use objc2::rc::Retained;
use objc2::runtime::AnyClass;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo, CGPreflightScreenCaptureAccess,
};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration};
use openlive_cu_core::geometry::fit;
use openlive_cu_core::protocol::Rect;
use std::sync::mpsc;
use std::time::Duration;

/// A capture that has not come back by now is not coming back.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Never called without the grant: asking ScreenCaptureKit is itself what puts up the system prompt.
pub fn window(id: u32, frame: Rect, max_long_edge: u32) -> Result<RgbaImage, String> {
    if !CGPreflightScreenCaptureAccess() {
        return Err("Screen Recording is not allowed for OpenLive Computer Use, so there is no picture; the tree above is still current. The user can allow it in OpenLive's settings.".into());
    }
    if AnyClass::get(c"SCScreenshotManager").is_none() {
        return Err("window pictures need macOS 14 or later; the tree above is still current".into());
    }
    let (tx, rx) = mpsc::channel::<Result<RgbaImage, String>>();
    let on_content = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // SAFETY: ScreenCaptureKit hands back a valid object or null, plus an error or null.
        let content = unsafe { Retained::retain(content) };
        let Some(content) = content else {
            let _ = tx.send(Err(describe(error, "the list of shareable windows was empty")));
            return;
        };
        // SAFETY: plain property reads and initialisers on live ScreenCaptureKit objects.
        unsafe {
            let Some(window) = content.windows().iter().find(|w| w.windowID() == id) else {
                let _ = tx.send(Err("this window cannot be captured (it may be minimized, on another Space, or closing)".into()));
                return;
            };
            let filter = SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window);
            let scale = f64::from(filter.pointPixelScale()).max(1.0);
            let (w, h) = fit((frame.width * scale).round() as u32, (frame.height * scale).round() as u32, max_long_edge);
            let config = SCStreamConfiguration::new();
            config.setWidth(w as usize);
            config.setHeight(h as usize);
            config.setScalesToFit(true);
            config.setShowsCursor(false);
            config.setIgnoreShadowsSingleWindow(true);
            let tx = tx.clone();
            let on_image = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
                let _ = tx.send(match image.as_ref() {
                    Some(image) => rgba(image, w, h),
                    None => Err(describe(error, "the capture returned no image")),
                });
            });
            SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&on_image));
        }
    });
    // SAFETY: the completion handler outlives the call; ScreenCaptureKit copies it.
    unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, true, &on_content) };
    rx.recv_timeout(TIMEOUT).unwrap_or_else(|_| Err("the window capture timed out".into()))
}

fn describe(error: *mut NSError, fallback: &str) -> String {
    // SAFETY: null or a valid NSError.
    unsafe { error.as_ref() }.map_or_else(|| fallback.to_owned(), |e| e.localizedDescription().to_string())
}

/// Draw the image into an RGBA buffer of exactly `w` by `h`.
fn rgba(image: &CGImage, w: u32, h: u32) -> Result<RgbaImage, String> {
    let mut buf = vec![0u8; w as usize * h as usize * 4];
    let space = CGColorSpace::new_device_rgb().ok_or("no RGB colour space")?;
    let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
    // SAFETY: `buf` holds w * h RGBA pixels and outlives the context.
    let ctx = unsafe { CGBitmapContextCreate(buf.as_mut_ptr().cast(), w as usize, h as usize, 8, w as usize * 4, Some(&space), info) }
        .ok_or("could not make a drawing context")?;
    CGContext::draw_image(Some(&ctx), CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: f64::from(w), height: f64::from(h) } }, Some(image));
    drop(ctx);
    RgbaImage::from_raw(w, h, buf).ok_or_else(|| "the picture has the wrong size".into())
}
