//! Mouse and keyboard control.
//!
//! Every coordinate in here is a `ScreenPoint`, so a screenshot pixel cannot
//! reach the OS without going through `coords`. Text and chords go out
//! through the injection primitives in `inject` rather than a second
//! keyboard path.
//!
//! Nothing here teleports. The pointer travels to where it was sent along the
//! path `motion` plans, because an app that never saw the pointer arrive does
//! not open its menu, arm its drop target or show its tooltip. These calls
//! therefore take as long as the movement does, and are run off the main
//! thread by their callers.

use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::coords::ScreenPoint;
use crate::inject::{self, Method};
use crate::motion;
use crate::platform::desktop::current as platform;

/// After arriving and before pressing: one frame for the app under the pointer
/// to process the move and paint its hover state, which is what a press is
/// often interpreted against.
const SETTLE: Duration = Duration::from_millis(40);
/// A press is a press, not an instant. Under this, toolkits that debounce
/// treat the pair as noise.
const PRESS: Duration = Duration::from_millis(28);
/// Between the clicks of a double click: comfortably inside every platform's
/// double-click interval, comfortably outside a single event.
const BETWEEN_CLICKS: Duration = Duration::from_millis(80);

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

/// Where the pointer is now, or the destination when the platform will not
/// say: an unknown start means the glide is skipped, never that it is wrong.
fn here(fallback: ScreenPoint) -> ScreenPoint {
    platform::cursor_position().unwrap_or(fallback)
}

/// Post the planned path and end on `to`, in the time the plan asked for.
///
/// Each sample is due at its own offset from the start rather than a tick
/// after the one before it. Sleeping is coarse, and posting an event is not
/// free, so a glide paced tick-by-tick drifts to roughly twice its planned
/// length: the same movement takes a different time on every machine and in
/// every app. Against a deadline the error cannot accumulate, and a sample
/// that is already late is dropped rather than paid for twice. The last one is
/// never dropped, because it is the only one whose position has to be exact.
fn travel(to: ScreenPoint, held: Option<Button>) -> Result<(), String> {
    let path = motion::glide(here(to), to);
    let start = Instant::now();
    let last = path.len() - 1;
    for (index, point) in path.iter().enumerate() {
        if index < last {
            let due = motion::TICK * index as u32;
            match due.checked_sub(start.elapsed()) {
                Some(remaining) => sleep(remaining),
                None => continue,
            }
        }
        match held {
            Some(button) => platform::mouse_drag_to(*point, button)?,
            None => platform::mouse_move(*point)?,
        }
    }
    Ok(())
}

/// Settles like every other action, so that when this resolves the pointer is
/// where it was sent: posting an event and the system acting on it are not the
/// same instant, and a caller that reads the position back has to be right.
pub fn move_to(point: ScreenPoint) -> Result<(), String> {
    platform::guard_injection()?;
    travel(point, None)?;
    sleep(SETTLE);
    Ok(())
}

/// The whole multi-click lives here rather than three times over in the
/// platform modules: only the click state a double click is recognised by is
/// platform business, and that is one argument.
pub fn click(point: ScreenPoint, button: Button, count: u32) -> Result<(), String> {
    platform::guard_injection()?;
    travel(point, None)?;
    sleep(SETTLE);
    for click in 1..=count.clamp(1, 3) {
        if click > 1 {
            sleep(BETWEEN_CLICKS);
        }
        platform::mouse_button(point, button, true, click)?;
        sleep(PRESS);
        platform::mouse_button(point, button, false, click)?;
    }
    Ok(())
}

pub fn mouse_down(point: ScreenPoint, button: Button) -> Result<(), String> {
    platform::guard_injection()?;
    travel(point, None)?;
    sleep(SETTLE);
    platform::mouse_button(point, button, true, 1)
}

/// Released where it is asked to be released, which for a held button means
/// dragging there first: a release that teleports is a drop the app never
/// tracked, landing on a target it was never shown.
pub fn mouse_up(point: ScreenPoint, button: Button) -> Result<(), String> {
    platform::guard_injection()?;
    travel(point, Some(button))?;
    platform::mouse_button(point, button, false, 1)
}

/// A path, not a start and an end: a drag that jumps straight to its
/// destination is ignored by every canvas and rejected by most drag targets.
pub fn drag(path: &[ScreenPoint], button: Button) -> Result<(), String> {
    let (first, rest) = path.split_first().ok_or("a drag needs at least one point")?;
    platform::guard_injection()?;
    travel(*first, None)?;
    sleep(SETTLE);
    platform::mouse_button(*first, button, true, 1)?;
    sleep(PRESS);
    let mut result = Ok(());
    for point in rest {
        result = travel(*point, Some(button));
        if result.is_err() {
            break;
        }
    }
    // The button comes up whether or not the path did, because a stuck
    // mouse button leaves the desktop unusable.
    let last = rest.last().copied().unwrap_or(*first);
    let release = platform::mouse_button(last, button, false, 1);
    result.and(release)
}

pub fn scroll(point: ScreenPoint, horizontal: i32, vertical: i32) -> Result<(), String> {
    platform::guard_injection()?;
    travel(point, None)?;
    sleep(SETTLE);
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
