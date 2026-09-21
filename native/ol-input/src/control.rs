//! Mouse and keyboard control.
//!
//! Every coordinate in here is a `ScreenPoint`, so a screenshot pixel cannot
//! reach the OS without going through `coords`. Text and chords go out
//! through the injection primitives Block 1 already owns rather than a second
//! keyboard path.

use std::thread::sleep;
use std::time::Duration;

use crate::coords::ScreenPoint;
use crate::inject::{self, Method};
use crate::platform::desktop::current as platform;

/// Apps that track a drag on mouse-moved events need the path to arrive as
/// movement, not as a teleport, so points are spaced out in time.
const DRAG_STEP: Duration = Duration::from_millis(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

impl Button {
    pub fn parse(name: &str) -> Result<Button, String> {
        match name {
            "left" => Ok(Button::Left),
            "right" => Ok(Button::Right),
            "middle" => Ok(Button::Middle),
            other => Err(format!("unknown mouse button \"{other}\"")),
        }
    }
}

pub fn move_to(point: ScreenPoint) -> Result<(), String> {
    platform::guard_injection()?;
    platform::mouse_move(point)
}

pub fn click(point: ScreenPoint, button: Button, count: u32) -> Result<(), String> {
    platform::guard_injection()?;
    platform::mouse_click(point, button, count.clamp(1, 3))
}

pub fn mouse_down(point: ScreenPoint, button: Button) -> Result<(), String> {
    platform::guard_injection()?;
    platform::mouse_button(point, button, true)
}

pub fn mouse_up(point: ScreenPoint, button: Button) -> Result<(), String> {
    platform::guard_injection()?;
    platform::mouse_button(point, button, false)
}

/// A path, not a start and an end: a drag that jumps straight to its
/// destination is ignored by every canvas and rejected by most drag targets.
pub fn drag(path: &[ScreenPoint], button: Button) -> Result<(), String> {
    let (first, rest) = path.split_first().ok_or("a drag needs at least one point")?;
    platform::guard_injection()?;
    platform::mouse_move(*first)?;
    platform::mouse_button(*first, button, true)?;
    let mut result = Ok(());
    for point in rest {
        sleep(DRAG_STEP);
        result = platform::mouse_drag_to(*point, button);
        if result.is_err() {
            break;
        }
    }
    // The button comes up whether or not the path did, because a stuck
    // mouse button leaves the desktop unusable.
    let last = rest.last().copied().unwrap_or(*first);
    let release = platform::mouse_button(last, button, false);
    result.and(release)
}

pub fn scroll(point: ScreenPoint, horizontal: i32, vertical: i32) -> Result<(), String> {
    platform::guard_injection()?;
    platform::scroll(point, horizontal, vertical)
}

pub fn type_text(text: &str) -> Result<(), String> {
    platform::guard_injection()?;
    inject::insert(text, Method::Type)
}

/// A chord like `["ctrl", "c"]`: the modifiers stay down across the key.
pub fn keypress(keys: &[String]) -> Result<(), String> {
    if keys.is_empty() {
        return Err("a keypress needs at least one key".into());
    }
    platform::guard_injection()?;
    platform::key_chord(&keys.join("+"))
}
