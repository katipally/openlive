//! Pure activation state machine. No OS handles, no timers, no clock reads:
//! every entry point takes `now`, so the whole thing is driven from tests.
//!
//! One gesture opens Flow and the same gesture closes it: two quick taps of the
//! trigger key, alone. Anything else the key is doing — held down, pressed as
//! part of a shortcut — must pass through untouched, because the trigger is
//! Control and Control belongs to the app the person is working in.
//!
//! A binding registered for holding (Dictate's) also reports the hold itself:
//! a press starts it at once, a release past `TAP_MAX` ends it, and a tap, or a
//! key landing on top, cancels it. Its double-tap opens hands-free, and while
//! that is open one more tap closes it.

use std::time::{Duration, Instant};

/// Presses closer together than this are one physical press arriving twice.
pub const DEBOUNCE: Duration = Duration::from_millis(30);
/// X11 auto-repeat synthesizes release/press pairs, so a key-up is only real
/// when no press of the same binding follows it inside this window. Without it
/// a key held down would drum out a stream of taps.
pub const RELEASE_GRACE: Duration = Duration::from_millis(50);
/// A press held longer than this is the key being used, not tapped.
pub const TAP_MAX: Duration = Duration::from_millis(350);
/// Two taps this close together are one deliberate double-tap.
pub const DOUBLE_TAP: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Start { binding_id: String },
    Stop { binding_id: String },
    HoldStart { binding_id: String },
    HoldEnd { binding_id: String },
    HoldCancel { binding_id: String },
}

#[derive(Debug, Clone)]
pub struct Input {
    pub pressed: bool,
    pub external: bool,
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
    /// Reports holds as well as the double-tap.
    hold: bool,
    /// A `HoldStart` went out and nothing has ended it yet.
    holding: bool,
    open: bool,
    press: Option<Press>,
    /// A completed tap waiting for its partner.
    last_tap: Option<Instant>,
    last_press: Option<Instant>,
}

impl CoordinatorState {
    pub fn new(binding_id: String, hold: bool) -> Self {
        Self { binding_id, hold, holding: false, open: false, press: None, last_tap: None, last_press: None }
    }

    pub fn on_input(&mut self, input: Input, now: Instant) -> Option<Effect> {
        // A shortcut. It disqualifies the press it landed on and the tap before
        // it, so Ctrl+C, Ctrl+V can never add up to a gesture.
        //
        // The press is dropped, not flagged: the hook stops tracking the binding
        // the moment another key lands on it, so no release for this press is
        // ever delivered. Keeping it would leave a press that nothing can ever
        // retire, and the next press — the start of a real gesture — would be
        // discarded as a duplicate of it.
        if input.other_key {
            self.press = None;
            self.last_tap = None;
            return self.end_hold(false);
        }
        // An external trigger has no press and no release to pair: it is the
        // whole gesture, delivered at once.
        if input.external {
            return input.pressed.then(|| self.toggle());
        }
        if input.pressed {
            let fresh = self.on_press(now);
            // Starts on the press itself, so the first word is never lost to
            // waiting out a tap.
            (fresh && self.hold && !self.open).then(|| {
                self.holding = true;
                Effect::HoldStart { binding_id: self.binding_id.clone() }
            })
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

        // Hands-free ends on any press of its key, so one tap is enough to stop.
        if self.hold && self.open {
            self.last_tap = None;
            return Some(self.toggle());
        }
        // Held rather than tapped, which also breaks the tap before it.
        if released_at.duration_since(pressed_at) > TAP_MAX {
            self.last_tap = None;
            return self.end_hold(true);
        }
        match self.last_tap {
            Some(first) if released_at.duration_since(first) <= DOUBLE_TAP => {
                self.last_tap = None;
                // The second tap's capture carries on as hands-free.
                self.holding = false;
                Some(self.toggle())
            }
            _ => {
                self.last_tap = Some(released_at);
                self.end_hold(false)
            }
        }
    }

    fn end_hold(&mut self, finished: bool) -> Option<Effect> {
        if !std::mem::take(&mut self.holding) {
            return None;
        }
        let binding_id = self.binding_id.clone();
        Some(if finished { Effect::HoldEnd { binding_id } } else { Effect::HoldCancel { binding_id } })
    }

    fn toggle(&mut self) -> Effect {
        self.open = !self.open;
        let binding_id = self.binding_id.clone();
        if self.open {
            Effect::Start { binding_id }
        } else {
            Effect::Stop { binding_id }
        }
    }

    /// Flow closed for a reason this state machine never saw: the orb's own
    /// close button, the idle timer, the machine going to sleep. The gesture is
    /// a toggle, so it can only stay honest if whoever actually closes Flow says
    /// so — otherwise the next double-tap does the opposite of what is on screen.
    pub fn on_closed(&mut self) {
        self.open = false;
    }

    /// Opened or closed without the gesture: Dictate's hands-free from the orb's
    /// mic button or by voice. Same reason as `on_closed`, both ways.
    pub fn set_open(&mut self, open: bool) {
        self.open = open;
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

    fn new() -> CoordinatorState {
        CoordinatorState::new("flow".into(), false)
    }

    fn input(pressed: bool, other_key: bool) -> Input {
        Input { pressed, external: false, other_key }
    }

    fn start() -> Option<Effect> {
        Some(Effect::Start { binding_id: "flow".into() })
    }

    fn stop() -> Option<Effect> {
        Some(Effect::Stop { binding_id: "flow".into() })
    }

    /// One tap: press, release, and the grace window closing behind it.
    fn tap(c: &mut CoordinatorState, at: Instant, held: Duration) -> Option<Effect> {
        c.on_input(input(true, false), at);
        c.on_input(input(false, false), at + held);
        c.on_grace_expired(at + held + RELEASE_GRACE)
    }

    #[test]
    fn two_quick_taps_open_flow() {
        let t0 = Instant::now();
        let mut c = new();
        assert_eq!(tap(&mut c, t0, ms(40)), None);
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), start());
    }

    #[test]
    fn the_same_gesture_closes_it() {
        let t0 = Instant::now();
        let mut c = new();
        tap(&mut c, t0, ms(40));
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), start());
        tap(&mut c, t0 + ms(1000), ms(40));
        assert_eq!(tap(&mut c, t0 + ms(1200), ms(40)), stop());
    }

    #[test]
    fn one_tap_alone_does_nothing() {
        let t0 = Instant::now();
        let mut c = new();
        assert_eq!(tap(&mut c, t0, ms(40)), None);
        assert_eq!(c.next_deadline(), None);
    }

    #[test]
    fn taps_too_far_apart_never_pair() {
        let t0 = Instant::now();
        let mut c = new();
        tap(&mut c, t0, ms(40));
        assert_eq!(tap(&mut c, t0 + DOUBLE_TAP + ms(50), ms(40)), None);
    }

    #[test]
    fn a_held_key_is_not_a_tap() {
        let t0 = Instant::now();
        let mut c = new();
        assert_eq!(tap(&mut c, t0, TAP_MAX + ms(10)), None);
        assert_eq!(tap(&mut c, t0 + ms(600), ms(40)), None);
    }

    /// The whole point of the gesture: Control keeps working as Control.
    #[test]
    fn a_shortcut_never_builds_toward_the_gesture() {
        let t0 = Instant::now();
        let mut c = new();
        c.on_input(input(true, false), t0);
        c.on_input(input(true, true), t0 + ms(20)); // Ctrl+C
        c.on_input(input(false, false), t0 + ms(60));
        assert_eq!(c.on_grace_expired(t0 + ms(110)), None);
        // And the tap before it was discarded too.
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), None);
    }

    /// The bug this was written for: after Ctrl+C the hook stops reporting the
    /// binding as pressed, so the press that the shortcut landed on never gets a
    /// release. Holding on to it swallowed the whole next gesture.
    #[test]
    fn a_shortcut_does_not_swallow_the_next_gesture() {
        let t0 = Instant::now();
        let mut c = new();
        tap(&mut c, t0, ms(40));
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), start());

        // Ctrl+C, with no release ever delivered for that press.
        c.on_input(input(true, false), t0 + ms(1000));
        c.on_input(input(true, true), t0 + ms(1020));

        // The very next double-tap must still close Flow.
        tap(&mut c, t0 + ms(2000), ms(40));
        assert_eq!(tap(&mut c, t0 + ms(2200), ms(40)), stop());
    }

    #[test]
    fn a_tap_then_a_shortcut_does_not_open_flow() {
        let t0 = Instant::now();
        let mut c = new();
        tap(&mut c, t0, ms(40));
        c.on_input(input(true, false), t0 + ms(150));
        c.on_input(input(true, true), t0 + ms(170));
        c.on_input(input(false, false), t0 + ms(200));
        assert_eq!(c.on_grace_expired(t0 + ms(250)), None);
    }

    #[test]
    fn auto_repeat_does_not_drum_out_taps() {
        let t0 = Instant::now();
        let mut c = new();
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

    #[test]
    fn one_press_arriving_twice_is_still_one_press() {
        let t0 = Instant::now();
        let mut c = new();
        c.on_input(input(true, false), t0);
        c.on_input(input(true, false), t0 + ms(10)); // inside DEBOUNCE
        c.on_input(input(false, false), t0 + ms(40));
        assert_eq!(c.on_grace_expired(t0 + ms(90)), None);
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), start());
    }

    #[test]
    fn an_external_trigger_is_the_whole_gesture() {
        let t0 = Instant::now();
        let mut c = new();
        assert_eq!(c.on_input(Input { pressed: true, external: true, other_key: false }, t0), start());
        assert_eq!(c.on_input(Input { pressed: true, external: true, other_key: false }, t0 + ms(10)), stop());
    }

    /// Flow closed without the gesture — the orb's button, the idle timer. The
    /// next double-tap has to OPEN it, not close something already gone.
    #[test]
    fn closing_flow_another_way_leaves_the_next_gesture_opening() {
        let t0 = Instant::now();
        let mut c = new();
        tap(&mut c, t0, ms(40));
        assert_eq!(tap(&mut c, t0 + ms(200), ms(40)), start());
        c.on_closed();
        tap(&mut c, t0 + ms(1000), ms(40));
        assert_eq!(tap(&mut c, t0 + ms(1200), ms(40)), start());
    }

    #[test]
    fn a_pending_release_is_the_only_deadline() {
        let t0 = Instant::now();
        let mut c = new();
        assert_eq!(c.next_deadline(), None);
        c.on_input(input(true, false), t0);
        assert_eq!(c.next_deadline(), None);
        c.on_input(input(false, false), t0 + ms(40));
        assert_eq!(c.next_deadline(), Some(t0 + ms(40) + RELEASE_GRACE));
    }
    fn dictate() -> CoordinatorState {
        CoordinatorState::new("dictate".into(), true)
    }

    fn effect(kind: fn(String) -> Effect) -> Option<Effect> {
        Some(kind("dictate".into()))
    }

    fn hold_start() -> Option<Effect> {
        effect(|binding_id| Effect::HoldStart { binding_id })
    }

    #[test]
    fn a_hold_starts_on_the_press_and_ends_on_the_release() {
        let t0 = Instant::now();
        let mut c = dictate();
        assert_eq!(c.on_input(input(true, false), t0), hold_start());
        c.on_input(input(false, false), t0 + ms(1500));
        assert_eq!(c.on_grace_expired(t0 + ms(1550)), effect(|binding_id| Effect::HoldEnd { binding_id }));
    }

    #[test]
    fn a_lone_tap_cancels_its_hold() {
        let t0 = Instant::now();
        let mut c = dictate();
        assert_eq!(c.on_input(input(true, false), t0), hold_start());
        c.on_input(input(false, false), t0 + ms(40));
        assert_eq!(c.on_grace_expired(t0 + ms(90)), effect(|binding_id| Effect::HoldCancel { binding_id }));
    }

    /// Right Alt is AltGr on many layouts: a character typed with it is not dictation.
    #[test]
    fn a_key_on_top_cancels_the_hold() {
        let t0 = Instant::now();
        let mut c = dictate();
        c.on_input(input(true, false), t0);
        assert_eq!(c.on_input(input(true, true), t0 + ms(300)), effect(|binding_id| Effect::HoldCancel { binding_id }));
        assert_eq!(c.next_deadline(), None);
    }

    #[test]
    fn a_double_tap_goes_hands_free_and_one_tap_ends_it() {
        let t0 = Instant::now();
        let mut c = dictate();
        assert_eq!(tap(&mut c, t0, ms(40)), effect(|binding_id| Effect::HoldCancel { binding_id }));
        assert_eq!(c.on_input(input(true, false), t0 + ms(200)), hold_start());
        c.on_input(input(false, false), t0 + ms(240));
        assert_eq!(c.on_grace_expired(t0 + ms(290)), effect(|binding_id| Effect::Start { binding_id }));
        // Hands-free: a press starts nothing, and its release closes it.
        assert_eq!(c.on_input(input(true, false), t0 + ms(3000)), None);
        c.on_input(input(false, false), t0 + ms(3040));
        assert_eq!(c.on_grace_expired(t0 + ms(3090)), effect(|binding_id| Effect::Stop { binding_id }));
    }

    #[test]
    fn a_tap_then_a_hold_is_a_hold() {
        let t0 = Instant::now();
        let mut c = dictate();
        tap(&mut c, t0, ms(40));
        assert_eq!(c.on_input(input(true, false), t0 + ms(200)), hold_start());
        c.on_input(input(false, false), t0 + ms(1200));
        assert_eq!(c.on_grace_expired(t0 + ms(1250)), effect(|binding_id| Effect::HoldEnd { binding_id }));
    }

    #[test]
    fn auto_repeat_does_not_restart_a_hold() {
        let t0 = Instant::now();
        let mut c = dictate();
        assert_eq!(c.on_input(input(true, false), t0), hold_start());
        for i in 1..6u64 {
            c.on_input(input(false, false), t0 + ms(i * 400));
            assert_eq!(c.on_input(input(true, false), t0 + ms(i * 400 + 5)), None);
        }
    }

    /// The mic button opened hands-free, so the key's next tap has to close it.
    #[test]
    fn hands_free_opened_elsewhere_closes_on_one_tap() {
        let t0 = Instant::now();
        let mut c = dictate();
        c.set_open(true);
        assert_eq!(c.on_input(input(true, false), t0), None);
        c.on_input(input(false, false), t0 + ms(40));
        assert_eq!(c.on_grace_expired(t0 + ms(90)), effect(|binding_id| Effect::Stop { binding_id }));
    }

    #[test]
    fn a_toggle_binding_never_reports_holds() {
        let t0 = Instant::now();
        let mut c = new();
        assert_eq!(c.on_input(input(true, false), t0), None);
        c.on_input(input(false, false), t0 + ms(1500));
        assert_eq!(c.on_grace_expired(t0 + ms(1550)), None);
    }
}
