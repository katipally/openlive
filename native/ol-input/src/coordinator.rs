//! Pure activation state machine. No OS handles, no timers, no clock reads:
//! every entry point takes `now`, so the whole thing is driven from tests.
//!
//! A toggle binding reports one gesture: two quick taps of its key, alone.
//! Which way that throws Flow or Dictate is the renderer's to know, so the
//! gesture carries no direction. Anything else the key is doing (held down,
//! pressed as part of a shortcut) must pass through untouched, because the
//! default keys are Control and Option and they belong to the app in front.
//!
//! A hold binding (push to talk) reports the hold itself: a press starts it at
//! once, a release past `TAP_MAX` ends it, and a tap, or a key landing on top,
//! cancels it. Two quick holds are two holds, never a gesture.

use std::time::{Duration, Instant};

/// Presses closer together than this are one physical press arriving twice.
pub const DEBOUNCE: Duration = Duration::from_millis(30);
/// X11 auto-repeat synthesizes release/press pairs, so a key-up is only real
/// when no press of the same binding follows it inside this window. Without it
/// a key held down would drum out a stream of taps.
pub const RELEASE_GRACE: Duration = Duration::from_millis(50);
/// A press held longer than this is the key being used, not tapped. A hold this
/// short is an accidental brush of the push-to-talk key: no words fit in it.
pub const TAP_MAX: Duration = Duration::from_millis(350);
/// Two taps this close together are one deliberate double-tap.
pub const DOUBLE_TAP: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Toggle,
    Hold,
}

impl std::str::FromStr for Role {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "toggle" => Ok(Role::Toggle),
            "hold" => Ok(Role::Hold),
            other => Err(format!("unknown binding role \"{other}\"")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    DoubleTap { binding_id: String },
    HoldStart { binding_id: String },
    HoldEnd { binding_id: String },
    HoldCancel { binding_id: String },
}

#[derive(Debug, Clone)]
pub struct Input {
    pub pressed: bool,
    pub external: bool,
    /// Some other key went down: on top of this press, or between two taps.
    pub other_key: bool,
}

/// The press currently in progress.
#[derive(Debug, Clone)]
struct Press {
    at: Instant,
    /// Set on key-up and confirmed once the grace window passes without a
    /// matching press, which is how auto-repeat is told from a real release.
    pending_release: Option<Instant>,
}

#[derive(Debug, Clone)]
pub struct CoordinatorState {
    binding_id: String,
    role: Role,
    /// A `HoldStart` went out and nothing has ended it yet.
    holding: bool,
    press: Option<Press>,
    /// A completed tap waiting for its partner.
    last_tap: Option<Instant>,
    last_press: Option<Instant>,
}

impl CoordinatorState {
    pub fn new(binding_id: String, role: Role) -> Self {
        Self { binding_id, role, holding: false, press: None, last_tap: None, last_press: None }
    }

    pub fn on_input(&mut self, input: Input, now: Instant) -> Option<Effect> {
        // A shortcut, or typing between two taps. It disqualifies the press it
        // landed on and the tap before it, so Ctrl+C, Ctrl+V or Option+E, E can
        // never add up to a gesture.
        //
        // The press is dropped, not flagged: the hook stops tracking the binding
        // the moment another key lands on it, so no release for this press is
        // ever delivered. Keeping it would leave a press that nothing can ever
        // retire, and the next press (the start of a real gesture) would be
        // discarded as a duplicate of it.
        if input.other_key {
            self.press = None;
            self.last_tap = None;
            return self.end_hold(false);
        }
        // An external trigger has no press and no release to pair: it is the
        // whole gesture, or the whole edge of a hold, delivered at once.
        if input.external {
            return match self.role {
                Role::Toggle => input.pressed.then(|| self.double_tap()),
                Role::Hold if input.pressed => self.start_hold(),
                Role::Hold => self.end_hold(true),
            };
        }
        if input.pressed {
            // Starts on the press itself, so the first word is never lost to
            // waiting out a tap.
            if self.on_press(now) && self.role == Role::Hold {
                return self.start_hold();
            }
            None
        } else {
            self.on_release(now);
            None
        }
    }

    /// Whether this is a new press rather than a repeat of the one in progress.
    fn on_press(&mut self, now: Instant) -> bool {
        // Cancelling a pending release runs before the debounce: an auto-repeat
        // press dropped by the debounce would let the release stand and turn a
        // held key into a tap.
        if let Some(press) = &mut self.press {
            if press.pending_release.take().is_some() {
                return false;
            }
        }
        if let Some(last) = self.last_press {
            if now.duration_since(last) < DEBOUNCE {
                return false;
            }
        }
        self.last_press = Some(now);
        if self.press.is_some() {
            return false;
        }
        self.press = Some(Press { at: now, pending_release: None });
        true
    }

    fn on_release(&mut self, now: Instant) {
        if let Some(press) = &mut self.press {
            press.pending_release = Some(now);
        }
    }

    /// The grace window passed with no press behind it, so the release was real
    /// and this press can finally be judged.
    pub fn on_grace_expired(&mut self, _now: Instant) -> Option<Effect> {
        let press = self.press.as_ref()?;
        let released_at = press.pending_release?;
        let pressed_at = press.at;
        self.press = None;

        // Held rather than tapped, which also breaks the tap before it.
        if released_at.duration_since(pressed_at) > TAP_MAX {
            self.last_tap = None;
            return self.end_hold(true);
        }
        if self.role == Role::Hold {
            return self.end_hold(false);
        }
        match self.last_tap {
            Some(first) if released_at.duration_since(first) <= DOUBLE_TAP => {
                self.last_tap = None;
                Some(self.double_tap())
            }
            _ => {
                self.last_tap = Some(released_at);
                None
            }
        }
    }

    fn start_hold(&mut self) -> Option<Effect> {
        if std::mem::replace(&mut self.holding, true) {
            return None;
        }
        Some(Effect::HoldStart { binding_id: self.binding_id.clone() })
    }

    fn end_hold(&mut self, finished: bool) -> Option<Effect> {
        if !std::mem::take(&mut self.holding) {
            return None;
        }
        let binding_id = self.binding_id.clone();
        Some(if finished { Effect::HoldEnd { binding_id } } else { Effect::HoldCancel { binding_id } })
    }

    fn double_tap(&self) -> Effect {
        Effect::DoubleTap { binding_id: self.binding_id.clone() }
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.press.as_ref()?.pending_release.map(|r| r + RELEASE_GRACE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn toggle() -> CoordinatorState {
        CoordinatorState::new("flow".into(), Role::Toggle)
    }

    fn ptt() -> CoordinatorState {
        CoordinatorState::new("ptt".into(), Role::Hold)
    }

    fn input(pressed: bool, other_key: bool) -> Input {
        Input { pressed, external: false, other_key }
    }

    fn double_tap() -> Option<Effect> {
        Some(Effect::DoubleTap { binding_id: "flow".into() })
    }

    fn hold(kind: fn(String) -> Effect) -> Option<Effect> {
        Some(kind("ptt".into()))
    }

    /// One tap: press, release, and the grace window closing behind it.
    fn tap(c: &mut CoordinatorState, at: Instant, held: Duration) -> Option<Effect> {
        c.on_input(input(true, false), at);
        c.on_input(input(false, false), at + held);
        c.on_grace_expired(at + held + RELEASE_GRACE)
    }

    #[test]
    fn two_quick_taps_are_the_gesture() {
        let t0 = Instant::now();
        let mut c = toggle();
        assert_eq!(tap(&mut c, t0, ms(40)), None);
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), double_tap());
    }

    /// The renderer owns open and closed, so every gesture is the same gesture.
    #[test]
    fn the_gesture_carries_no_direction() {
        let t0 = Instant::now();
        let mut c = toggle();
        for i in 0..3u64 {
            tap(&mut c, t0 + ms(i * 1000), ms(40));
            assert_eq!(tap(&mut c, t0 + ms(i * 1000 + 200), ms(40)), double_tap());
        }
    }

    #[test]
    fn one_tap_alone_does_nothing() {
        let t0 = Instant::now();
        let mut c = toggle();
        assert_eq!(tap(&mut c, t0, ms(40)), None);
        assert_eq!(c.next_deadline(), None);
    }

    #[test]
    fn taps_too_far_apart_never_pair() {
        let t0 = Instant::now();
        let mut c = toggle();
        tap(&mut c, t0, ms(40));
        assert_eq!(tap(&mut c, t0 + DOUBLE_TAP + ms(50), ms(40)), None);
    }

    #[test]
    fn three_taps_are_one_gesture_and_a_spare_tap() {
        let t0 = Instant::now();
        let mut c = toggle();
        tap(&mut c, t0, ms(40));
        assert_eq!(tap(&mut c, t0 + ms(150), ms(40)), double_tap());
        assert_eq!(tap(&mut c, t0 + ms(300), ms(40)), None);
    }

    #[test]
    fn a_held_key_is_not_a_tap() {
        let t0 = Instant::now();
        let mut c = toggle();
        assert_eq!(tap(&mut c, t0, TAP_MAX + ms(10)), None);
        assert_eq!(tap(&mut c, t0 + ms(600), ms(40)), None);
    }

    /// The whole point of the gesture: Control keeps working as Control.
    #[test]
    fn a_shortcut_never_builds_toward_the_gesture() {
        let t0 = Instant::now();
        let mut c = toggle();
        c.on_input(input(true, false), t0);
        c.on_input(input(true, true), t0 + ms(20)); // Ctrl+C
        c.on_input(input(false, false), t0 + ms(60));
        assert_eq!(c.on_grace_expired(t0 + ms(110)), None);
        // And the tap before it was discarded too.
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), None);
    }

    /// After Ctrl+C the hook stops reporting the binding as pressed, so the
    /// press the shortcut landed on never gets a release. Holding on to it
    /// swallowed the whole next gesture.
    #[test]
    fn a_shortcut_does_not_swallow_the_next_gesture() {
        let t0 = Instant::now();
        let mut c = toggle();
        c.on_input(input(true, false), t0);
        c.on_input(input(true, true), t0 + ms(20));
        tap(&mut c, t0 + ms(1000), ms(40));
        assert_eq!(tap(&mut c, t0 + ms(1200), ms(40)), double_tap());
    }

    /// Option+E then E types é: a key between the taps is typing, not a gesture.
    #[test]
    fn a_key_between_the_taps_breaks_them() {
        let t0 = Instant::now();
        let mut c = toggle();
        tap(&mut c, t0, ms(40));
        c.on_input(input(false, true), t0 + ms(120));
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), None);
    }

    /// A key that lands after the release but before the grace window confirms it.
    #[test]
    fn a_key_inside_the_grace_window_breaks_the_tap() {
        let t0 = Instant::now();
        let mut c = toggle();
        tap(&mut c, t0, ms(40));
        c.on_input(input(true, false), t0 + ms(200));
        c.on_input(input(false, false), t0 + ms(240));
        c.on_input(input(false, true), t0 + ms(260));
        assert_eq!(c.on_grace_expired(t0 + ms(290)), None);
    }

    #[test]
    fn auto_repeat_does_not_drum_out_taps() {
        let t0 = Instant::now();
        let mut c = toggle();
        c.on_input(input(true, false), t0);
        // X11 repeats: release/press pairs inside the grace window, for a key
        // that is still physically down.
        for i in 1..6u64 {
            c.on_input(input(false, false), t0 + ms(i * 40));
            c.on_input(input(true, false), t0 + ms(i * 40 + 5));
        }
        c.on_input(input(false, false), t0 + ms(400));
        // Held well past TAP_MAX, so it is a hold and not a tap.
        assert_eq!(c.on_grace_expired(t0 + ms(450)), None);
    }

    /// Windows and evdev repeat the key-down itself while a key is held.
    #[test]
    fn repeated_presses_are_one_press() {
        let t0 = Instant::now();
        let mut c = toggle();
        c.on_input(input(true, false), t0);
        for i in 1..10u64 {
            c.on_input(input(true, false), t0 + ms(i * 33));
        }
        c.on_input(input(false, false), t0 + ms(500));
        assert_eq!(c.on_grace_expired(t0 + ms(550)), None);
        assert_eq!(tap(&mut c, t0 + ms(700), ms(40)), None);
    }

    #[test]
    fn one_press_arriving_twice_is_still_one_press() {
        let t0 = Instant::now();
        let mut c = toggle();
        c.on_input(input(true, false), t0);
        c.on_input(input(true, false), t0 + ms(10)); // inside DEBOUNCE
        c.on_input(input(false, false), t0 + ms(40));
        assert_eq!(c.on_grace_expired(t0 + ms(90)), None);
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), double_tap());
    }

    #[test]
    fn an_external_trigger_is_the_whole_gesture() {
        let t0 = Instant::now();
        let mut c = toggle();
        let external = Input { pressed: true, external: true, other_key: false };
        assert_eq!(c.on_input(external.clone(), t0), double_tap());
        assert_eq!(c.on_input(external, t0 + ms(10)), double_tap());
    }

    #[test]
    fn a_pending_release_is_the_only_deadline() {
        let t0 = Instant::now();
        let mut c = toggle();
        assert_eq!(c.next_deadline(), None);
        c.on_input(input(true, false), t0);
        assert_eq!(c.next_deadline(), None);
        c.on_input(input(false, false), t0 + ms(40));
        assert_eq!(c.next_deadline(), Some(t0 + ms(40) + RELEASE_GRACE));
    }

    #[test]
    fn a_toggle_never_reports_holds() {
        let t0 = Instant::now();
        let mut c = toggle();
        assert_eq!(c.on_input(input(true, false), t0), None);
        c.on_input(input(false, false), t0 + ms(1500));
        assert_eq!(c.on_grace_expired(t0 + ms(1550)), None);
    }

    #[test]
    fn a_hold_starts_on_the_press_and_ends_on_the_release() {
        let t0 = Instant::now();
        let mut c = ptt();
        assert_eq!(c.on_input(input(true, false), t0), hold(|binding_id| Effect::HoldStart { binding_id }));
        c.on_input(input(false, false), t0 + ms(1500));
        assert_eq!(c.on_grace_expired(t0 + ms(1550)), hold(|binding_id| Effect::HoldEnd { binding_id }));
    }

    /// An accidental brush of the key opens no utterance.
    #[test]
    fn a_tap_cancels_its_hold() {
        let t0 = Instant::now();
        let mut c = ptt();
        assert_eq!(c.on_input(input(true, false), t0), hold(|binding_id| Effect::HoldStart { binding_id }));
        c.on_input(input(false, false), t0 + ms(40));
        assert_eq!(c.on_grace_expired(t0 + ms(90)), hold(|binding_id| Effect::HoldCancel { binding_id }));
    }

    /// No promotion to hands-free: two quick taps are two cancelled holds.
    #[test]
    fn a_double_tap_of_the_hold_key_is_two_cancelled_holds() {
        let t0 = Instant::now();
        let mut c = ptt();
        let cancel = hold(|binding_id| Effect::HoldCancel { binding_id });
        assert_eq!(tap(&mut c, t0, ms(40)), cancel);
        assert_eq!(c.on_input(input(true, false), t0 + ms(200)), hold(|binding_id| Effect::HoldStart { binding_id }));
        c.on_input(input(false, false), t0 + ms(240));
        assert_eq!(c.on_grace_expired(t0 + ms(290)), cancel);
    }

    #[test]
    fn a_tap_then_a_hold_is_a_hold() {
        let t0 = Instant::now();
        let mut c = ptt();
        tap(&mut c, t0, ms(40));
        assert_eq!(c.on_input(input(true, false), t0 + ms(200)), hold(|binding_id| Effect::HoldStart { binding_id }));
        c.on_input(input(false, false), t0 + ms(1200));
        assert_eq!(c.on_grace_expired(t0 + ms(1250)), hold(|binding_id| Effect::HoldEnd { binding_id }));
    }

    /// Fn+arrow is Home: a shortcut, so the hold is given up.
    #[test]
    fn a_key_on_top_cancels_the_hold() {
        let t0 = Instant::now();
        let mut c = ptt();
        c.on_input(input(true, false), t0);
        assert_eq!(c.on_input(input(true, true), t0 + ms(300)), hold(|binding_id| Effect::HoldCancel { binding_id }));
        assert_eq!(c.next_deadline(), None);
    }

    #[test]
    fn auto_repeat_does_not_restart_a_hold() {
        let t0 = Instant::now();
        let mut c = ptt();
        assert_eq!(c.on_input(input(true, false), t0), hold(|binding_id| Effect::HoldStart { binding_id }));
        for i in 1..6u64 {
            c.on_input(input(false, false), t0 + ms(i * 400));
            assert_eq!(c.on_input(input(true, false), t0 + ms(i * 400 + 5)), None);
        }
    }

    #[test]
    fn an_external_hold_is_its_two_edges() {
        let t0 = Instant::now();
        let mut c = ptt();
        let edge = |pressed| Input { pressed, external: true, other_key: false };
        assert_eq!(c.on_input(edge(true), t0), hold(|binding_id| Effect::HoldStart { binding_id }));
        assert_eq!(c.on_input(edge(true), t0 + ms(10)), None);
        assert_eq!(c.on_input(edge(false), t0 + ms(900)), hold(|binding_id| Effect::HoldEnd { binding_id }));
        assert_eq!(c.on_input(edge(false), t0 + ms(910)), None);
    }

    #[test]
    fn roles_parse_from_their_names() {
        assert_eq!("toggle".parse::<Role>(), Ok(Role::Toggle));
        assert_eq!("hold".parse::<Role>(), Ok(Role::Hold));
        assert!("press".parse::<Role>().is_err());
    }
}
