//! One window's pixels: Windows.Graphics.Capture first, PrintWindow when it fails.
//!
//! WGC reads the window's own composited frames out of DWM, so it sees a
//! window behind others and the GPU-drawn content PrintWindow returns black for.
//! It needs Windows 10 1903 and cannot capture a minimized window.
//!
//! The yellow border. Windows draws a border around a window while WGC
//! captures it. Since Windows 11 (build 20348) a session can ask for none with
//! IsBorderRequired = false; Microsoft documents that this takes a consent
//! (GraphicsCaptureAccess.RequestAccessAsync(Borderless), which needs the
//! graphicsCaptureWithoutBorder capability of a packaged app). The helper is an
//! unpackaged executable, so it sets the property without asking: where Windows
//! honours it for an unpackaged app there is no border, and where it does not
//! the border shows for the one frame this takes, a fraction of a second. On
//! Windows 10 the property does not exist and the border always flashes.
//! Requesting access would put up a consent prompt on every new helper build,
//! which is worse than that flash. The property is set only where it exists:
//! setting it on Windows 10 fails with E_NOINTERFACE.

use crate::shot::{crop, Px};
use crate::win;
use image::imageops::FilterType;
use image::RgbaImage;
use openlive_cu_core::geometry::fit;
use std::time::{Duration, Instant};
use windows::core::{Interface, HSTRING};
use windows::Foundation::Metadata::ApiInformation;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::IsIconic;

/// A frame that has not arrived by now is not coming: the window is not being composed.
const FRAME_TIMEOUT: Duration = Duration::from_millis(1500);
const FRAME_POLL: Duration = Duration::from_millis(20);
/// PW_RENDERFULLCONTENT: ask DWM for the composed window, so Chromium and other GPU-drawn content is not black.
const PW_RENDERFULLCONTENT: u32 = 2;

/// BGRA pixels, top row first, with their size.
struct Bgra {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

/// The D3D device WGC draws into, made once: it costs tens of milliseconds.
#[derive(Default)]
pub struct Capturer {
    device: Option<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice)>,
}

impl Capturer {
    /// The visible `frame` of `hwnd`, at most `max_long_edge` on the long side.
    pub fn window(&mut self, hwnd: HWND, frame: Px, max_long_edge: u32) -> Result<RgbaImage, String> {
        // SAFETY: a plain read.
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return Err("the window is minimized, so there is no picture of it; the tree above is still current".into());
        }
        let shot = self.wgc(hwnd).or_else(|wgc| print_window(hwnd).map_err(|pw| format!("the window could not be captured ({wgc}; {pw})")))?;
        let window = win::window_rect(hwnd).unwrap_or(frame);
        let mut rgba = RgbaImage::from_raw(shot.width, shot.height, shot.pixels).ok_or("the picture has the wrong size")?;
        for p in rgba.pixels_mut() {
            p.0.swap(0, 2);
            p.0[3] = 255;
        }
        let rgba = match crop((rgba.width(), rgba.height()), window, frame) {
            Some((x, y, w, h)) if (w, h) != rgba.dimensions() => image::imageops::crop_imm(&rgba, x, y, w, h).to_image(),
            _ => rgba,
        };
        let (w, h) = fit(frame.width().max(1) as u32, frame.height().max(1) as u32, max_long_edge);
        Ok(if rgba.dimensions() == (w, h) { rgba } else { image::imageops::resize(&rgba, w, h, FilterType::Triangle) })
    }

    fn device(&mut self) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice)> {
        if let Some(d) = &self.device {
            return Ok(d.clone());
        }
        // SAFETY: plain D3D11 device creation with out-pointers this function owns.
        unsafe {
            let (mut device, mut context) = (None, None);
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
            let (device, context) = (device.ok_or_else(windows::core::Error::empty)?, context.ok_or_else(windows::core::Error::empty)?);
            let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)?.cast()?;
            self.device = Some((device, context, winrt));
        }
        Ok(self.device.clone().expect("set above"))
    }

    fn wgc(&mut self, hwnd: HWND) -> Result<Bgra, String> {
        let wgc = |what: &str, e: windows::core::Error| format!("Windows.Graphics.Capture {what}: {}", e.message());
        if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
            return Err("Windows.Graphics.Capture needs Windows 10 1903 or later".into());
        }
        let (device, context, winrt) = self.device().map_err(|e| wgc("device", e))?;
        // SAFETY: WinRT and D3D11 calls on objects created here; the mapped texture is read within its row pitch and unmapped.
        unsafe {
            let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|e| wgc("factory", e))?;
            let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd).map_err(|e| wgc("item", e))?;
            let size = item.Size().map_err(|e| wgc("size", e))?;
            // Free-threaded: the default pool delivers frames only to a thread pumping a dispatcher, which this one is not.
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)
                .map_err(|e| wgc("frame pool", e))?;
            let session = pool.CreateCaptureSession(&item).map_err(|e| wgc("session", e))?;
            let class = HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession");
            if ApiInformation::IsPropertyPresent(&class, &HSTRING::from("IsBorderRequired")).unwrap_or(false) {
                let _ = session.SetIsBorderRequired(false);
            }
            if ApiInformation::IsPropertyPresent(&class, &HSTRING::from("IsCursorCaptureEnabled")).unwrap_or(false) {
                let _ = session.SetIsCursorCaptureEnabled(false);
            }
            session.StartCapture().map_err(|e| wgc("start", e))?;
            let deadline = Instant::now() + FRAME_TIMEOUT;
            let frame = loop {
                if let Ok(f) = pool.TryGetNextFrame() {
                    break f;
                }
                if Instant::now() > deadline {
                    let _ = session.Close();
                    let _ = pool.Close();
                    return Err("Windows.Graphics.Capture delivered no frame (the window may be hidden or not drawing)".into());
                }
                std::thread::sleep(FRAME_POLL);
            };
            let content = frame.ContentSize().map_err(|e| wgc("content size", e))?;
            let texture: ID3D11Texture2D = frame.Surface().and_then(|s| s.cast::<IDirect3DDxgiInterfaceAccess>()).and_then(|a| a.GetInterface()).map_err(|e| wgc("surface", e))?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            desc.MiscFlags = 0;
            let mut staging = None;
            device.CreateTexture2D(&desc, None, Some(&mut staging)).map_err(|e| wgc("staging texture", e))?;
            let staging = staging.ok_or("Windows.Graphics.Capture made no staging texture")?;
            context.CopyResource(&staging, &texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| wgc("map", e))?;
            // The pool is the size the window had at the start; a window resized since fills only part of it.
            let width = (content.Width.max(0) as u32).min(desc.Width);
            let height = (content.Height.max(0) as u32).min(desc.Height);
            let row = width as usize * 4;
            let mut pixels = vec![0u8; row * height as usize];
            for y in 0..height as usize {
                let src = (mapped.pData as *const u8).add(y * mapped.RowPitch as usize);
                std::ptr::copy_nonoverlapping(src, pixels.as_mut_ptr().add(y * row), row);
            }
            context.Unmap(&staging, 0);
            let _ = frame.Close();
            let _ = session.Close();
            let _ = pool.Close();
            if width == 0 || height == 0 {
                return Err("Windows.Graphics.Capture delivered an empty frame".into());
            }
            Ok(Bgra { pixels, width, height })
        }
    }
}

/// The whole window rectangle drawn into a bitmap by DWM. Works where WGC is
/// unavailable (Windows 10 before 1903, a remote session without a GPU).
fn print_window(hwnd: HWND) -> Result<Bgra, String> {
    let rect = win::window_rect(hwnd).ok_or("the window has no rectangle")?;
    let (width, height) = (rect.width().max(0) as u32, rect.height().max(0) as u32);
    if width == 0 || height == 0 {
        return Err("PrintWindow: the window has no size".into());
    }
    // SAFETY: GDI objects created here are selected out and deleted on every path; the DIB holds width * height BGRA pixels.
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                // Negative: top row first.
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        let result = match bitmap {
            Ok(bitmap) => {
                let old = SelectObject(dc, bitmap.into());
                let drawn = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
                let pixels = drawn.then(|| std::slice::from_raw_parts(bits as *const u8, width as usize * height as usize * 4).to_vec());
                SelectObject(dc, old);
                let _ = DeleteObject(bitmap.into());
                match pixels {
                    Some(p) if p.as_chunks::<4>().0.iter().any(|px| px[..3] != [0, 0, 0]) => Ok(Bgra { pixels: p, width, height }),
                    Some(_) => Err("PrintWindow drew nothing but black".into()),
                    None => Err("PrintWindow failed".into()),
                }
            }
            Err(e) => Err(format!("PrintWindow: {}", e.message())),
        };
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        result
    }
}
