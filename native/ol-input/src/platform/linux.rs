//! Linux typing and clipboard go through external tools, because no single
//! one of them covers X11, wlroots, KDE and GNOME.

use std::env;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// Every modifier xdotool can latch. `--clearmodifiers` releases them for the
/// duration of the send and then restores them system-wide, which leaves them
/// stuck when the user was not actually holding one.
const MODIFIER_KEYSYMS: [&str; 8] = [
    "shift", "ctrl", "alt", "super", "Shift_R", "Control_R", "Alt_R", "Super_R",
];

pub fn which(tool: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(tool))
        .find(|candidate| candidate.is_file())
}

fn desktop() -> String {
    env::var("XDG_CURRENT_DESKTOP")
        .or_else(|_| env::var("XDG_SESSION_DESKTOP"))
        .unwrap_or_default()
        .to_lowercase()
}

pub fn is_wayland() -> bool {
    env::var("WAYLAND_DISPLAY").is_ok()
        || env::var("XDG_SESSION_TYPE").map(|t| t == "wayland").unwrap_or(false)
}

/// ydotool changed its `key` syntax incompatibly, and prints its help to
/// stderr, so the probe reads both streams. Cached: this shells out.
fn ydotool_uses_keycode_syntax() -> bool {
    static SYNTAX: OnceLock<bool> = OnceLock::new();
    *SYNTAX.get_or_init(|| {
        let Ok(out) = Command::new("ydotool").arg("key").arg("--help").output() else {
            return true;
        };
        let help = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        help.contains("KEYCODE") || help.contains("keycode")
    })
}

fn run(tool: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(tool)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("{tool}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{tool} exited with {status}"))
    }
}

pub fn type_text(text: &str) -> Result<(), String> {
    let desktop = desktop();
    let mut tried = Vec::new();

    for tool in ["kwtype", "wtype", "dotool", "ydotool", "xdotool"] {
        // wtype is deliberately unimplemented on KDE and GNOME: it reports
        // success and types nothing.
        if tool == "wtype" && (desktop.contains("kde") || desktop.contains("gnome")) {
            continue;
        }
        if which(tool).is_none() {
            continue;
        }
        let result = match tool {
            "dotool" => type_with_dotool(text),
            "ydotool" => run("ydotool", &["type", "--", text]),
            "xdotool" => type_with_xdotool(text),
            _ => run(tool, &["--", text]),
        };
        match result {
            Ok(()) => return Ok(()),
            Err(e) => tried.push(e),
        }
    }
    Err(if tried.is_empty() {
        "no typing tool found: install wtype, ydotool or xdotool".into()
    } else {
        tried.join("; ")
    })
}

fn type_with_dotool(text: &str) -> Result<(), String> {
    let mut child = Command::new("dotool")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("dotool: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("dotool: no stdin")?
        .write_all(format!("type {text}\n").as_bytes())
        .map_err(|e| format!("dotool: {e}"))?;
    let status = child.wait().map_err(|e| format!("dotool: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("dotool exited with {status}"))
    }
}

fn type_with_xdotool(text: &str) -> Result<(), String> {
    let status = Command::new("xdotool")
        .args(["type", "--clearmodifiers", "--", text])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    // The key-up runs before the status is inspected: a failed send latches
    // modifiers just as readily as a successful one.
    let mut keyup = vec!["keyup"];
    keyup.extend(MODIFIER_KEYSYMS);
    let _ = Command::new("xdotool")
        .args(&keyup)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("xdotool exited with {s}")),
        Err(e) => Err(format!("xdotool: {e}")),
    }
}

pub fn send_paste_chord() -> Result<(), String> {
    if which("ydotool").is_some() {
        let combo = if ydotool_uses_keycode_syntax() { "29:1 47:1 47:0 29:0" } else { "ctrl+v" };
        let args: Vec<&str> = std::iter::once("key").chain(combo.split(' ')).collect();
        if run("ydotool", &args).is_ok() {
            return Ok(());
        }
    }
    if which("xdotool").is_some() {
        let result = run("xdotool", &["key", "--clearmodifiers", "ctrl+v"]);
        let mut keyup = vec!["keyup"];
        keyup.extend(MODIFIER_KEYSYMS);
        let _ = run("xdotool", &keyup);
        return result;
    }
    Err("no tool available to send Ctrl+V: install ydotool or xdotool".into())
}

/// wl-copy forks a daemon that holds the selection. If it inherits piped
/// stdout or stderr the parent blocks forever waiting for EOF.
pub fn wl_copy(text: &str) -> Result<(), String> {
    let mut child = Command::new("wl-copy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("wl-copy: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("wl-copy: no stdin")?
        .write_all(text.as_bytes())
        .map_err(|e| format!("wl-copy: {e}"))?;
    let status = child.wait().map_err(|e| format!("wl-copy: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("wl-copy exited with {status}"))
    }
}

pub fn accessibility_ok() -> bool {
    true
}

pub fn request_accessibility() -> bool {
    true
}

/// PipeWire and PulseAudio grant microphone access at the session level, so
/// there is nothing to probe: the capture attempt is the probe.
pub fn microphone_status() -> isize {
    3
}

pub fn request_microphone() {}

pub fn screen_recording_ok() -> bool {
    !is_wayland()
}

pub fn request_screen_recording() -> bool {
    screen_recording_ok()
}

pub fn secure_input_active() -> bool {
    false
}

pub fn frontmost_app_name() -> Option<String> {
    None
}
