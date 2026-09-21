//! Pure activation state machine. No OS handles, no timers, no clock reads:
//! every entry point takes `now`, so the whole thing is driven from tests.

use std::time::{Duration, Instant};

/// Presses closer together than this are one physical press arriving twice.
pub const DEBOUNCE: Duration = Duration::from_millis(30);
/// X11 auto-repeat synthesizes release/press pairs, so a key-up is only real
/// when no press of the same binding follows it inside this window.
pub const RELEASE_GRACE: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activation {
    Toggle,
    PushToTalk,
    HoldOrToggle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Start { binding_id: String },
    Stop { binding_id: String },
    Cancel,
}

#[derive(Debug, Clone)]
pub struct Input {
    pub binding_id: String,
    pub pressed: bool,
    pub external: bool,
    pub other_key: bool,
}

#[derive(Debug, Clone)]
struct Hold {
    binding_id: String,
    pressed_at: Instant,
    /// When recording actually began. Equal to `pressed_at` except for a
    /// modifier-only hold, which spends the threshold arming first, so the
    /// latch decision has to be measured from here or it could never latch.
    started_at: Instant,
    locked: bool,
    /// A modifier-only hold that another key is still allowed to cancel.
    /// Cleared once the hold latches, because a latched recording is deliberate.
    cancellable: bool,
    pending_release: Option<Instant>,
}

#[derive(Debug, Clone)]
enum Phase {
    Idle,
    Armed(Hold),
    Capturing(Hold),
    Processing { pending_press: Option<(String, Instant)> },
}

#[derive(Debug, Clone)]
pub struct CoordinatorState {
    activation: Activation,
    hold_threshold: Duration,
    modifier_only: bool,
    phase: Phase,
    last_press: Option<Instant>,
}

impl CoordinatorState {
    pub fn new(activation: Activation, hold_threshold: Duration, modifier_only: bool) -> Self {
        Self {
            activation,
            hold_threshold,
            modifier_only,
            phase: Phase::Idle,
            last_press: None,
        }
    }

    /// One knob produces all three modes: toggle and push-to-talk qualify the
    /// instant the key goes down, hold-or-toggle waits out the configured hold.
    fn threshold(&self) -> Duration {
        match self.activation {
            Activation::HoldOrToggle => self.hold_threshold,
            _ => Duration::ZERO,
        }
    }

    pub fn is_idle(&self) -> bool {
        matches!(self.phase, Phase::Idle)
    }

    pub fn on_input(&mut self, input: Input, now: Instant) -> Option<Effect> {
        if input.other_key {
            return self.on_collision();
        }
        if input.pressed {
            self.on_press(input, now)
        } else {
            self.on_release(&input.binding_id, now);
            None
        }
    }

    fn on_collision(&mut self) -> Option<Effect> {
        match &self.phase {
            Phase::Armed(hold) | Phase::Capturing(hold) if hold.cancellable => {
                self.phase = Phase::Idle;
                Some(Effect::Cancel)
            }
            _ => None,
        }
    }

    fn on_press(&mut self, input: Input, now: Instant) -> Option<Effect> {
        // Cancelling a pending release runs before the debounce: an auto-repeat
        // press dropped by the debounce would let the release fire and end the
        // hold while the key is still physically down.
        if let Phase::Armed(hold) | Phase::Capturing(hold) = &mut self.phase {
            if hold.binding_id == input.binding_id && hold.pending_release.take().is_some() {
                return None;
            }
        }
        if !input.external {
            if let Some(last) = self.last_press {
                if now.duration_since(last) < DEBOUNCE {
                    return None;
                }
            }
            self.last_press = Some(now);
        }

        match &mut self.phase {
            Phase::Idle => self.begin(input.binding_id, now, input.external),
            Phase::Armed(_) => None,
            Phase::Capturing(hold) => {
                if hold.locked && hold.binding_id == input.binding_id {
                    let binding_id = hold.binding_id.clone();
                    self.phase = Phase::Processing { pending_press: None };
                    Some(Effect::Stop { binding_id })
                } else {
                    None
                }
            }
            Phase::Processing { pending_press } => {
                if pending_press.is_none() {
                    *pending_press = Some((input.binding_id, now));
                }
                None
            }
        }
    }

    /// Optimistic: `Start` is emitted the moment the hold qualifies and
    /// `on_start_failed` is the rollback. A modifier-only binding is the one
    /// case that waits, because it must prove it is held alone past the
    /// threshold before Ctrl+C can be told apart from a trigger.
    fn begin(&mut self, binding_id: String, now: Instant, external: bool) -> Option<Effect> {
        let locked = self.activation == Activation::Toggle || external;
        let hold = Hold {
            binding_id: binding_id.clone(),
            pressed_at: now,
            started_at: now,
            locked,
            cancellable: self.modifier_only && !locked,
            pending_release: None,
        };
        if hold.cancellable && !self.threshold().is_zero() {
            self.phase = Phase::Armed(hold);
            return None;
        }
        self.phase = Phase::Capturing(hold);
        Some(Effect::Start { binding_id })
    }

    fn on_release(&mut self, binding_id: &str, now: Instant) {
        if let Phase::Armed(hold) | Phase::Capturing(hold) = &mut self.phase {
            if hold.binding_id == binding_id && !hold.locked {
                hold.pending_release = Some(now);
            }
        }
    }

    pub fn on_grace_expired(&mut self, now: Instant) -> Option<Effect> {
        let threshold = self.threshold();
        match &mut self.phase {
            Phase::Armed(hold) => {
                if hold.pending_release.is_some() {
                    self.phase = Phase::Idle;
                } else if now.duration_since(hold.pressed_at) >= threshold {
                    let binding_id = hold.binding_id.clone();
                    let mut hold = hold.clone();
                    hold.started_at = now;
                    self.phase = Phase::Capturing(hold);
                    return Some(Effect::Start { binding_id });
                }
                None
            }
            Phase::Capturing(hold) => {
                let released_at = hold.pending_release?;
                // Hold length is measured to the actual key-up, not to the
                // moment the grace window runs out.
                if released_at.duration_since(hold.started_at) >= threshold {
                    let binding_id = hold.binding_id.clone();
                    self.phase = Phase::Processing { pending_press: None };
                    Some(Effect::Stop { binding_id })
                } else {
                    hold.pending_release = None;
                    hold.locked = true;
                    hold.cancellable = false;
                    None
                }
            }
            _ => None,
        }
    }

    /// A press that arrived while the pipeline was busy is replayed with its
    /// original timestamp, so toggle parity survives a slow turn.
    pub fn on_processing_finished(&mut self, _now: Instant) -> Option<Effect> {
        let pending = match &mut self.phase {
            Phase::Processing { pending_press } => pending_press.take(),
            _ => return None,
        };
        match pending {
            Some((binding_id, pressed_at)) => self.begin(binding_id, pressed_at, false),
            None => {
                self.phase = Phase::Idle;
                None
            }
        }
    }

    pub fn on_start_failed(&mut self) {
        self.phase = Phase::Idle;
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        match &self.phase {
            Phase::Armed(hold) => Some(match hold.pending_release {
                Some(released_at) => released_at + RELEASE_GRACE,
                None => hold.pressed_at + self.threshold(),
            }),
            Phase::Capturing(hold) => hold.pending_release.map(|r| r + RELEASE_GRACE),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOLD: Duration = Duration::from_millis(250);

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn press(id: &str) -> Input {
        Input { binding_id: id.into(), pressed: true, external: false, other_key: false }
    }

    fn release(id: &str) -> Input {
        Input { binding_id: id.into(), pressed: false, external: false, other_key: false }
    }

    fn collision(id: &str) -> Input {
        Input { binding_id: id.into(), pressed: true, external: false, other_key: true }
    }

    fn start(id: &str) -> Option<Effect> {
        Some(Effect::Start { binding_id: id.into() })
    }

    fn stop(id: &str) -> Option<Effect> {
        Some(Effect::Stop { binding_id: id.into() })
    }

    #[test]
    fn push_to_talk_starts_on_press_and_stops_on_release() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::PushToTalk, HOLD, false);

        assert_eq!(c.on_input(press("b"), t0), start("b"));
        c.on_input(release("b"), t0 + ms(400));
        assert_eq!(c.next_deadline(), Some(t0 + ms(400) + RELEASE_GRACE));
        assert_eq!(c.on_grace_expired(t0 + ms(450)), stop("b"));
    }

    #[test]
    fn push_to_talk_stops_even_below_the_hold_threshold() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::PushToTalk, HOLD, false);

        assert_eq!(c.on_input(press("b"), t0), start("b"));
        c.on_input(release("b"), t0 + ms(10));
        assert_eq!(c.on_grace_expired(t0 + ms(60)), stop("b"));
    }

    #[test]
    fn toggle_ignores_releases_and_stops_on_the_second_press() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::Toggle, HOLD, false);

        assert_eq!(c.on_input(press("b"), t0), start("b"));
        c.on_input(release("b"), t0 + ms(40));
        assert_eq!(c.next_deadline(), None);
        assert_eq!(c.on_grace_expired(t0 + ms(200)), None);
        assert_eq!(c.on_input(press("b"), t0 + ms(900)), stop("b"));
    }

    #[test]
    fn hold_or_toggle_long_hold_stops_on_release() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, false);

        assert_eq!(c.on_input(press("b"), t0), start("b"));
        c.on_input(release("b"), t0 + ms(800));
        assert_eq!(c.on_grace_expired(t0 + ms(850)), stop("b"));
    }

    #[test]
    fn hold_or_toggle_short_release_latches_until_the_next_press() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, false);

        assert_eq!(c.on_input(press("b"), t0), start("b"));
        c.on_input(release("b"), t0 + ms(100));
        assert_eq!(c.on_grace_expired(t0 + ms(150)), None);
        assert_eq!(c.next_deadline(), None);
        assert_eq!(c.on_input(press("b"), t0 + ms(5_000)), stop("b"));
    }

    #[test]
    fn hold_length_is_measured_to_the_release_not_to_grace_expiry() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, false);

        c.on_input(press("b"), t0);
        c.on_input(release("b"), t0 + ms(240));
        // 240ms of hold plus 50ms of grace is past the threshold, the hold is not.
        assert_eq!(c.on_grace_expired(t0 + ms(290)), None);
        assert_eq!(c.on_input(press("b"), t0 + ms(400)), stop("b"));
    }

    #[test]
    fn x11_auto_repeat_burst_produces_one_start_and_one_stop() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, false);

        assert_eq!(c.on_input(press("b"), t0), start("b"));

        let mut t = 100;
        for _ in 0..30 {
            assert_eq!(c.on_input(release("b"), t0 + ms(t)), None);
            assert_eq!(c.on_input(press("b"), t0 + ms(t + 5)), None);
            // The host would never reach the deadline: the press lands first.
            assert!(c.next_deadline().is_none() || c.next_deadline() > Some(t0 + ms(t + 5)));
            t += 10;
        }

        c.on_input(release("b"), t0 + ms(t));
        assert_eq!(c.on_grace_expired(t0 + ms(t + 50)), stop("b"));
    }

    #[test]
    fn debounce_drops_a_duplicate_press_but_never_an_external_one() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::Toggle, HOLD, false);

        assert_eq!(c.on_input(press("b"), t0), start("b"));
        assert_eq!(c.on_input(press("b"), t0 + ms(20)), None);
        assert_eq!(c.on_input(press("b"), t0 + ms(60)), stop("b"));

        let mut c = CoordinatorState::new(Activation::Toggle, HOLD, false);
        let ext = |id: &str| Input {
            binding_id: id.into(),
            pressed: true,
            external: true,
            other_key: false,
        };
        assert_eq!(c.on_input(ext("b"), t0), start("b"));
        assert_eq!(c.on_input(ext("b"), t0 + ms(1)), stop("b"));
    }

    #[test]
    fn modifier_only_arms_past_the_threshold_before_starting() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, true);

        assert_eq!(c.on_input(press("ctrl"), t0), None);
        assert_eq!(c.next_deadline(), Some(t0 + HOLD));
        assert_eq!(c.on_grace_expired(t0 + ms(200)), None);
        assert_eq!(c.on_grace_expired(t0 + HOLD), start("ctrl"));
    }

    #[test]
    fn ctrl_c_cancels_the_armed_modifier_and_passes_through() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, true);

        assert_eq!(c.on_input(press("ctrl"), t0), None);
        assert_eq!(c.on_input(collision("ctrl"), t0 + ms(40)), Some(Effect::Cancel));
        assert!(c.is_idle());
        assert_eq!(c.next_deadline(), None);
        // The release of the passed-through combo must not resurrect anything.
        assert_eq!(c.on_input(release("ctrl"), t0 + ms(90)), None);
        assert_eq!(c.on_grace_expired(t0 + ms(400)), None);
    }

    #[test]
    fn a_key_arriving_during_a_modifier_hold_cancels_the_recording() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, true);

        c.on_input(press("ctrl"), t0);
        assert_eq!(c.on_grace_expired(t0 + HOLD), start("ctrl"));
        assert_eq!(c.on_input(collision("ctrl"), t0 + ms(300)), Some(Effect::Cancel));
        assert!(c.is_idle());
    }

    #[test]
    fn a_latched_modifier_recording_is_not_cancelled_by_typing() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, true);

        c.on_input(press("ctrl"), t0);
        assert_eq!(c.on_grace_expired(t0 + HOLD), start("ctrl"));
        c.on_input(release("ctrl"), t0 + ms(260));
        assert_eq!(c.on_grace_expired(t0 + ms(310)), None);
        assert!(c.next_deadline().is_none());
        assert_eq!(c.on_input(collision("ctrl"), t0 + ms(400)), None);
        assert_eq!(c.on_input(press("ctrl"), t0 + ms(900)), stop("ctrl"));
    }

    #[test]
    fn modifier_only_auto_repeat_does_not_break_arming() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, true);

        c.on_input(press("ctrl"), t0);
        for t in [50u64, 60, 70, 80] {
            c.on_input(release("ctrl"), t0 + ms(t));
            assert_eq!(c.on_input(press("ctrl"), t0 + ms(t + 5)), None);
        }
        assert_eq!(c.next_deadline(), Some(t0 + HOLD));
        assert_eq!(c.on_grace_expired(t0 + HOLD), start("ctrl"));
    }

    #[test]
    fn a_modifier_tapped_below_the_threshold_starts_nothing() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, true);

        c.on_input(press("ctrl"), t0);
        c.on_input(release("ctrl"), t0 + ms(60));
        assert_eq!(c.next_deadline(), Some(t0 + ms(110)));
        assert_eq!(c.on_grace_expired(t0 + ms(110)), None);
        assert!(c.is_idle());
    }

    #[test]
    fn a_long_modifier_hold_stops_on_release() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::HoldOrToggle, HOLD, true);

        c.on_input(press("ctrl"), t0);
        assert_eq!(c.on_grace_expired(t0 + HOLD), start("ctrl"));
        c.on_input(release("ctrl"), t0 + ms(1_200));
        assert_eq!(c.on_grace_expired(t0 + ms(1_250)), stop("ctrl"));
    }

    #[test]
    fn a_press_during_processing_is_replayed_with_its_original_time() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::Toggle, HOLD, false);

        assert_eq!(c.on_input(press("b"), t0), start("b"));
        assert_eq!(c.on_input(press("b"), t0 + ms(500)), stop("b"));
        assert_eq!(c.on_input(press("b"), t0 + ms(600)), None);
        assert_eq!(c.on_processing_finished(t0 + ms(2_000)), start("b"));
        // Parity survived: the replayed press left us recording, so the next
        // press stops, it does not start a second time.
        assert_eq!(c.on_input(press("b"), t0 + ms(2_100)), stop("b"));
    }

    #[test]
    fn processing_with_no_pending_press_returns_to_idle() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::PushToTalk, HOLD, false);

        c.on_input(press("b"), t0);
        c.on_input(release("b"), t0 + ms(100));
        assert_eq!(c.on_grace_expired(t0 + ms(150)), stop("b"));
        assert_eq!(c.on_processing_finished(t0 + ms(900)), None);
        assert!(c.is_idle());
    }

    #[test]
    fn a_failed_start_rolls_back_to_idle() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::PushToTalk, HOLD, false);

        assert_eq!(c.on_input(press("b"), t0), start("b"));
        c.on_start_failed();
        assert!(c.is_idle());
        assert_eq!(c.on_input(press("b"), t0 + ms(100)), start("b"));
    }

    #[test]
    fn a_second_binding_is_ignored_while_the_first_is_capturing() {
        let t0 = Instant::now();
        let mut c = CoordinatorState::new(Activation::PushToTalk, HOLD, false);

        assert_eq!(c.on_input(press("a"), t0), start("a"));
        assert_eq!(c.on_input(press("b"), t0 + ms(100)), None);
        c.on_input(release("b"), t0 + ms(150));
        assert_eq!(c.next_deadline(), None);
        c.on_input(release("a"), t0 + ms(200));
        assert_eq!(c.on_grace_expired(t0 + ms(250)), stop("a"));
    }
}
