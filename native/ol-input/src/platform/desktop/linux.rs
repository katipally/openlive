//! Linux capture, window metadata and pointer control.
//!
//! Like the typing path next door, this goes through whatever tools the
//! session actually has, because no single library covers X11, wlroots, KDE
//! and GNOME. On Wayland the screenshot tools are the desktop's own
//! xdg-desktop-portal front ends (`gnome-screenshot`, `spectacle`) or the
//! wlroots protocol (`grim`); when none of them is installed the capability
//! is reported absent rather than a black frame being handed to the model.

use std::io::Read;
use std::process::{Command, Stdio};

use crate::capture::{Bitmap, Display};
use crate::control::Button;
use crate::coords::{ScreenPoint, Shot};
use crate::ocr::ShotBox;
use crate::platform::linux::{is_wayland, which};
use crate::window::WindowInfo;

/// Every tool that can write a PNG of the whole screen, best first. The
/// wlroots and portal front ends come before the X11 ones so a Wayland
/// session does not fall through to a tool that will capture nothing.
const SHOT_TOOLS: [&str; 5] = ["grim", "spectacle", "gnome-screenshot", "maim", "import"];

fn output(tool: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(tool)
        .args(args)
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("{tool}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!("{tool} exited with {}", out.status))
    }
}

fn run(tool: &str, args: &[&str]) -> Result<(), String> {
    output(tool, args).map(|_| ())
}

fn shot_tool() -> Option<&'static str> {
    SHOT_TOOLS.into_iter().find(|tool| which(tool).is_some())
}

/// A scratch path per capture, so two captures at once cannot read each
/// other's half-written file.
fn scratch() -> std::path::PathBuf {
    let name = format!("ol-input-{}-{:?}.png", std::process::id(), std::time::Instant::now());
    std::env::temp_dir().join(name.replace(['{', '}', ' '], ""))
}

fn shoot(tool: &str, region: Option<(i64, i64, i64, i64)>) -> Result<Vec<u8>, String> {
    let path = scratch();
    let target = path.to_string_lossy().into_owned();
    let geometry = region.map(|(x, y, w, h)| format!("{x},{y} {w}x{h}"));
    let result = match tool {
        "grim" => match &geometry {
            Some(area) => run("grim", &["-g", area, &target]),
            None => run("grim", &[&target]),
        },
        "spectacle" => run("spectacle", &["-b", "-n", "-f", "-o", &target]),
        "gnome-screenshot" => run("gnome-screenshot", &["-f", &target]),
        "maim" => match region {
            Some((x, y, w, h)) => run(
                "maim",
                &["-g", &format!("{w}x{h}+{x}+{y}"), &target],
            ),
            None => run("maim", &[&target]),
        },
        _ => match region {
            Some((x, y, w, h)) => run(
                "import",
                &["-window", "root", "-crop", &format!("{w}x{h}+{x}+{y}"), &target],
            ),
            None => run("import", &["-window", "root", &target]),
        },
    };
    let read = std::fs::read(&path);
    let _ = std::fs::remove_file(&path);
    result?;
    read.map_err(|e| format!("{tool} wrote no image: {e}"))
}

fn decode(png: &[u8], origin: ScreenPoint, logical_width: f64) -> Result<Bitmap, String> {
    let decoder = png::Decoder::new(png);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    let width = frame.width;
    let height = frame.height;
    let rgba = match frame.color_type {
        png::ColorType::Rgba => buffer[..frame.buffer_size()].to_vec(),
        png::ColorType::Rgb => buffer[..frame.buffer_size()]
            .chunks_exact(3)
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
            .collect(),
        other => return Err(format!("the screenshot tool produced an unusable {other:?} image")),
    };
    let scale = if logical_width > 0.0 { f64::from(width) / logical_width } else { 1.0 };
    Ok(Bitmap { rgba, shot: Shot::new(origin, scale, width, height) })
}

/// `xrandr --listmonitors` is the only enumeration available without linking
/// a display library, and Wayland sessions expose nothing equivalent.
pub fn displays() -> Result<Vec<Display>, String> {
    let listing = output("xrandr", &["--listmonitors"])
        .map_err(|_| "no display enumeration available: xrandr is not installed".to_string())?;
    let mut displays = Vec::new();
    for (index, line) in listing.lines().skip(1).enumerate() {
        let mut fields = line.split_whitespace();
        let primary = fields.next().is_some_and(|marker| marker.ends_with(':'));
        let name = fields.next().unwrap_or("display").trim_start_matches('+').to_string();
        // "2560/597x1440/336+0+0"
        let Some(geometry) = fields.find(|field| field.contains('x') && field.contains('+')) else {
            continue;
        };
        let numbers: Vec<f64> = geometry
            .split(['x', '+'])
            .map(|part| part.split('/').next().unwrap_or_default().parse().unwrap_or(0.0))
            .collect();
        let [width, height, x, y] = numbers[..] else { continue };
        displays.push(Display {
            id: index as u32,
            name,
            origin: ScreenPoint::new(x, y),
            width,
            height,
            scale: 1.0,
            primary: primary && index == 0,
        });
    }
    if displays.is_empty() {
        Err("xrandr reported no monitors".into())
    } else {
        Ok(displays)
    }
}

fn require_tool() -> Result<&'static str, String> {
    shot_tool().ok_or_else(|| {
        if is_wayland() {
            "screen capture is unavailable on this Wayland session: install grim, or \
             the desktop's own xdg-desktop-portal screenshot front end \
             (gnome-screenshot, spectacle)"
                .to_string()
        } else {
            "screen capture is unavailable: install maim, imagemagick or \
             gnome-screenshot"
                .to_string()
        }
    })
}

pub fn capture_display(id: u32) -> Result<Bitmap, String> {
    let display = displays()?
        .into_iter()
        .find(|display| display.id == id)
        .ok_or_else(|| format!("no display with id {id}"))?;
    let tool = require_tool()?;
    let region = (
        display.origin.x as i64,
        display.origin.y as i64,
        display.width as i64,
        display.height as i64,
    );
    decode(&shoot(tool, Some(region))?, display.origin, display.width)
}

pub fn capture_window(id: u32) -> Result<Bitmap, String> {
    let window = window_list()?
        .into_iter()
        .find(|window| window.id == id)
        .ok_or_else(|| format!("no window with id {id}"))?;
    capture_region(window.origin, window.width, window.height)
}

pub fn capture_region(origin: ScreenPoint, width: f64, height: f64) -> Result<Bitmap, String> {
    let tool = require_tool()?;
    let region = (origin.x as i64, origin.y as i64, width as i64, height as i64);
    let png = shoot(tool, Some(region))?;
    // spectacle and gnome-screenshot cannot crop, so what came back may be
    // the whole screen; the geometry is still the region that was asked for.
    decode(&png, origin, width)
}

fn xdotool(args: &[&str]) -> Result<String, String> {
    if which("xdotool").is_none() {
        return Err(unavailable());
    }
    output("xdotool", args)
}

fn unavailable() -> String {
    if is_wayland() {
        "window metadata and control are unavailable on this Wayland session: no \
         compositor-independent protocol exposes them"
            .to_string()
    } else {
        "window metadata and control need xdotool, which is not installed".to_string()
    }
}

fn describe(id: u32) -> Option<WindowInfo> {
    let window = id.to_string();
    let title = xdotool(&["getwindowname", &window]).ok()?.trim().to_string();
    let pid = xdotool(&["getwindowpid", &window])
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0);
    let geometry = xdotool(&["getwindowgeometry", "--shell", &window]).ok()?;
    let value = |key: &str| -> Option<f64> {
        geometry
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .and_then(|number| number.trim().parse().ok())
    };
    let origin = ScreenPoint::new(value("X")?, value("Y")?);
    // The centre, not the corner: a window straddling the top of the screen
    // has an origin that is on no display at all.
    let centre = ScreenPoint::new(
        origin.x + value("WIDTH")? / 2.0,
        origin.y + value("HEIGHT")? / 2.0,
    );
    Some(WindowInfo {
        id,
        app_name: process_name(pid).unwrap_or_default(),
        app_id: process_name(pid),
        title: (!title.is_empty()).then_some(title),
        pid,
        origin,
        width: value("WIDTH")?,
        height: value("HEIGHT")?,
        display_id: displays().ok().and_then(|displays| {
            displays
                .into_iter()
                .find(|display| {
                    centre.x >= display.origin.x
                        && centre.x < display.origin.x + display.width
                        && centre.y >= display.origin.y
                        && centre.y < display.origin.y + display.height
                })
                .map(|display| display.id)
        }),
        minimized: false,
    })
}

fn process_name(pid: u32) -> Option<String> {
    let mut name = String::new();
    std::fs::File::open(format!("/proc/{pid}/comm"))
        .ok()?
        .read_to_string(&mut name)
        .ok()?;
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

pub fn foreground_window() -> Result<Option<WindowInfo>, String> {
    let id: u32 = xdotool(&["getactivewindow"])?
        .trim()
        .parse()
        .map_err(|_| "xdotool did not report an active window".to_string())?;
    Ok(describe(id))
}

pub fn window_list() -> Result<Vec<WindowInfo>, String> {
    let listing = xdotool(&["search", "--onlyvisible", "--name", ""])?;
    Ok(listing
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .filter_map(describe)
        .filter(|window| window.title.is_some())
        .collect())
}

pub fn activate_window(id: u32) -> Result<(), String> {
    xdotool(&["windowactivate", &id.to_string()]).map(|_| ())
}

pub fn move_window(id: u32, origin: ScreenPoint) -> Result<(), String> {
    xdotool(&[
        "windowmove",
        &id.to_string(),
        &(origin.x as i64).to_string(),
        &(origin.y as i64).to_string(),
    ])
    .map(|_| ())
}

pub fn resize_window(id: u32, width: f64, height: f64) -> Result<(), String> {
    xdotool(&[
        "windowsize",
        &id.to_string(),
        &(width as i64).to_string(),
        &(height as i64).to_string(),
    ])
    .map(|_| ())
}

pub fn minimize_window(id: u32) -> Result<(), String> {
    xdotool(&["windowminimize", &id.to_string()]).map(|_| ())
}

pub fn close_window(id: u32) -> Result<(), String> {
    xdotool(&["windowclose", &id.to_string()]).map(|_| ())
}

pub fn open_app(name: &str) -> Result<(), String> {
    if which("gtk-launch").is_some() && run("gtk-launch", &[name]).is_ok() {
        return Ok(());
    }
    Command::new(name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start \"{name}\": {e}"))
}

pub fn open_url(url: &str) -> Result<(), String> {
    run("xdg-open", &[url])
}

/// The X11 primary selection is what "the selected text" means on Linux; on
/// Wayland only `wl-paste` can read it, and only for clients that publish it.
pub fn selected_text() -> Option<String> {
    if is_wayland() && which("wl-paste").is_some() {
        return output("wl-paste", &["--primary", "--no-newline"]).ok();
    }
    for tool in ["xclip", "xsel"] {
        if which(tool).is_none() {
            continue;
        }
        let args: &[&str] = if tool == "xclip" {
            &["-o", "-selection", "primary"]
        } else {
            &["--primary", "--output"]
        };
        if let Ok(text) = output(tool, args) {
            return Some(text);
        }
    }
    None
}

pub fn guard_injection() -> Result<(), String> {
    Ok(())
}

pub fn elevated_injection_ok() -> bool {
    true
}

/// xdotool talks to an X server. In a Wayland session there is none to talk
/// to and it fails by doing nothing at all, which is the one outcome Flow may
/// never produce, so it is not offered there however installed it is.
fn pointer_tool() -> Result<&'static str, String> {
    let candidates: &[&str] = if is_wayland() { &["ydotool"] } else { &["xdotool", "ydotool"] };
    for tool in candidates {
        if which(tool).is_some() {
            return Ok(tool);
        }
    }
    Err(if is_wayland() {
        "pointer control in a Wayland session needs ydotool, with its daemon running, and it is not installed"
    } else {
        "pointer control needs xdotool or ydotool, neither of which is installed"
    }
    .into())
}

fn button_number(button: Button) -> &'static str {
    match button {
        Button::Left => "1",
        Button::Middle => "2",
        Button::Right => "3",
    }
}

pub fn mouse_move(point: ScreenPoint) -> Result<(), String> {
    let x = (point.x as i64).to_string();
    let y = (point.y as i64).to_string();
    match pointer_tool()? {
        "xdotool" => run("xdotool", &["mousemove", "--sync", &x, &y]),
        _ => run("ydotool", &["mousemove", "--absolute", "-x", &x, "-y", &y]),
    }
}

/// Both pointer tools recognise a double click from the timing of two
/// presses, so the click state the caller counts is nothing they need.
pub fn mouse_button(point: ScreenPoint, button: Button, down: bool, _click_state: u32) -> Result<(), String> {
    let _ = point;
    let number = button_number(button);
    match pointer_tool()? {
        "xdotool" => run("xdotool", &[if down { "mousedown" } else { "mouseup" }, number]),
        _ => {
            // ydotool encodes the button in the low bits and the press in
            // 0x40, which is why this is not the xdotool number.
            let code = match button {
                Button::Left => 0x00,
                Button::Right => 0x01,
                Button::Middle => 0x02,
            } | if down { 0x40 } else { 0x80 };
            run("ydotool", &["click", &format!("0x{code:02x}")])
        }
    }
}

pub fn mouse_drag_to(point: ScreenPoint, _button: Button) -> Result<(), String> {
    mouse_move(point)
}

/// One process per notch is the cost of shelling out, so the notches a single
/// call will spend are bounded: a model that asks for a thousand gets a long
/// scroll, not a thousand processes.
const MAX_NOTCHES: i32 = 40;

pub fn scroll(point: ScreenPoint, horizontal: i32, vertical: i32) -> Result<(), String> {
    let _ = point;
    let notches = |amount: i32| amount.clamp(-MAX_NOTCHES, MAX_NOTCHES);
    let (vertical, horizontal) = (notches(vertical), notches(horizontal));
    let tool = pointer_tool()?;
    if tool != "xdotool" {
        // evdev counts a positive wheel as a push away from the user, and the
        // contract every platform here answers to is "positive scrolls down".
        let x = horizontal.to_string();
        let y = (-vertical).to_string();
        return run("ydotool", &["mousemove", "--wheel", "-x", &x, "-y", &y]);
    }
    // 4 and 5 are up and down, 6 and 7 are left and right.
    for (amount, buttons) in [(vertical, ("4", "5")), (horizontal, ("6", "7"))] {
        let number = if amount < 0 { buttons.0 } else { buttons.1 };
        for _ in 0..amount.abs() {
            run("xdotool", &["click", number])?;
        }
    }
    Ok(())
}

/// `xdotool getmouselocation` answers `x:900 y:520 screen:0 window:12`.
/// ydotool cannot report a position at all, and an unknown position means the
/// glide is skipped rather than aimed from a guess.
pub fn cursor_position() -> Option<ScreenPoint> {
    let reported = output("xdotool", &["getmouselocation"]).ok()?;
    let field = |name: &str| -> Option<f64> {
        reported
            .split_whitespace()
            .find_map(|part| part.strip_prefix(name)?.parse::<f64>().ok())
    };
    Some(ScreenPoint::new(field("x:")?, field("y:")?))
}

pub fn key_chord(chord: &str) -> Result<(), String> {
    let keys: Vec<&str> = chord.split('+').collect();
    let combination = keys
        .iter()
        .map(|key| match *key {
            "cmd" | "super" | "meta" => "super",
            "opt" | "alt" => "alt",
            "ctrl" | "control" => "ctrl",
            other => other,
        })
        .collect::<Vec<_>>()
        .join("+");
    match pointer_tool()? {
        "xdotool" => run("xdotool", &["key", "--clearmodifiers", &combination]),
        _ => run("ydotool", &["key", &combination]),
    }
}

/// tesseract's TSV output is one row per recognised element; level 5 is a
/// word, which is the finest box it reports.
pub fn ocr(png: &[u8], _width: f64, _height: f64) -> Result<Vec<ShotBox>, String> {
    if which("tesseract").is_none() {
        return Err("OCR is unavailable: tesseract is not installed".into());
    }
    let path = scratch();
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    let tsv = output("tesseract", &[&path.to_string_lossy(), "stdout", "tsv"]);
    let _ = std::fs::remove_file(&path);
    let tsv = tsv?;

    let mut found = Vec::new();
    for line in tsv.lines().skip(1) {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 12 || fields[0] != "5" {
            continue;
        }
        let text = fields[11].trim();
        if text.is_empty() {
            continue;
        }
        let number = |index: usize| fields[index].parse::<f64>().unwrap_or_default();
        found.push(ShotBox {
            text: text.to_string(),
            confidence: (number(10) / 100.0) as f32,
            x: number(6),
            y: number(7),
            width: number(8),
            height: number(9),
        });
    }
    Ok(found)
}

pub fn ocr_available() -> bool {
    which("tesseract").is_some()
}

pub fn ocr_engine() -> &'static str {
    "tesseract"
}

pub fn capture_ok() -> bool {
    shot_tool().is_some()
}

pub fn capture_backend() -> &'static str {
    shot_tool().unwrap_or("none")
}

pub fn selection_ok() -> bool {
    ["wl-paste", "xclip", "xsel"].into_iter().any(|tool| which(tool).is_some())
}

pub fn selection_backend() -> &'static str {
    if is_wayland() {
        "wl-paste-primary"
    } else {
        "x11-primary"
    }
}

/// There is no Wayland protocol for moving somebody else's window, and
/// xdotool being installed there does not make one.
pub fn window_control_ok() -> bool {
    !is_wayland() && which("xdotool").is_some()
}

/// Named in the capability report, because on Linux what is installed is what
/// Flow can actually do.
pub fn external_tools() -> Vec<String> {
    [
        "grim",
        "spectacle",
        "gnome-screenshot",
        "maim",
        "import",
        "xdotool",
        "ydotool",
        "wtype",
        "kwtype",
        "dotool",
        "xclip",
        "xsel",
        "wl-copy",
        "wl-paste",
        "tesseract",
        "xrandr",
        "xdg-open",
    ]
    .into_iter()
    .filter(|tool| which(tool).is_some())
    .map(str::to_string)
    .collect()
}

pub fn session_kind() -> Option<&'static str> {
    Some(if is_wayland() { "wayland" } else { "x11" })
}
