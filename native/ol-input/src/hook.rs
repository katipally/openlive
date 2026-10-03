//! The global keyboard hook.
//!
//! Crate choice: `handy-keys`. It is the only maintained crate that covers
//! modifier-only hotkeys, separate key-down and key-up, and a blocking mode
//! that keeps an armed binding out of the focused app, on all three
//! platforms. The rdev fork gives raw events but no blocking and no
//! modifier-only matching, and `global-hotkey` has no key-up at all. The raw
//! `KeyboardListener` is used rather than `HotkeyManager` because matching
//! has to see keys that are *not* part of the binding: that is what makes the
//! Ctrl+C collision rule possible.

use std::collections::HashSet;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use handy_keys::{KeyEvent, KeyboardListener, Modifiers};
#[cfg(test)]
use handy_keys::Key;

use crate::binding::Binding;
use crate::coordinator::{CoordinatorState, Effect, Input, Role};
use crate::secure_input;

/// How long the manager thread waits on the listener before looking at its
/// command queue and its coordinator deadlines again.
const TICK: Duration = Duration::from_millis(20);

pub type EffectSink = Arc<dyn Fn(Effect) + Send + Sync>;

enum Command {
    Register {
        id: String,
        binding: Binding,
        role: Role,
        reply: Sender<Result<(), String>>,
    },
    Unregister {
        id: String,
        reply: Sender<Result<(), String>>,
    },
    /// One binding by id, or the whole hook.
    Suspend(Option<String>, Sender<Result<(), String>>),
    Resume(Option<String>, Sender<Result<(), String>>),
    External {
        id: String,
        pressed: bool,
    },
    Shutdown,
}

struct Entry {
    id: String,
    /// As registered.
    binding: Binding,
    role: Role,
    /// What is actually watched: a toggle narrowed away from every hold key.
    /// None while a hold key takes all of it.
    watched: Option<Binding>,
    coordinator: CoordinatorState,
    pressed: bool,
}

/// Whether Right Alt is AltGr on the layout in front. Re-read at each Right Alt
/// press, since the layout can change per window (Windows) or at any time
/// (setxkbmap), and only then, since every use of Right Alt starts with one.
struct RightAlt {
    altgr: bool,
    layout_has_altgr: fn() -> bool,
}

pub struct Hook {
    commands: Sender<Command>,
    worker: Option<JoinHandle<()>>,
    failure: Arc<Mutex<Option<String>>>,
}

impl Hook {
    /// Installs the hook. On macOS this is the call that needs Accessibility,
    /// so it is only reached from an explicit initialize.
    pub fn start(sink: EffectSink) -> Result<Hook, String> {
        let (commands, rx) = channel();
        let (carbon_tx, carbon_rx) = channel();
        secure_input::set_carbon_sender(carbon_tx);
        let failure = Arc::new(Mutex::new(None));
        let (ready_tx, ready_rx) = channel();

        let thread_failure = Arc::clone(&failure);
        let worker = std::thread::spawn(move || {
            // A panic in here must surface as an error, never as an Electron
            // crash, so the whole thread body is caught.
            let result = catch_unwind(AssertUnwindSafe(|| run(rx, carbon_rx, sink, ready_tx)));
            let message = match result {
                Ok(Ok(())) => return,
                Ok(Err(e)) => e,
                Err(_) => "the ol-input hook thread panicked".to_string(),
            };
            eprintln!("[ol-input] hook stopped: {message}");
            if let Ok(mut failure) = thread_failure.lock() {
                *failure = Some(message);
            }
        });

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Hook { commands, worker: Some(worker), failure }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("the hook thread exited before it started".into()),
        }
    }

    pub fn last_error(&self) -> Option<String> {
        self.failure.lock().ok().and_then(|f| f.clone())
    }

    fn call(&self, make: impl FnOnce(Sender<Result<(), String>>) -> Command) -> Result<(), String> {
        let (reply, response) = channel();
        self.commands
            .send(make(reply))
            .map_err(|_| "the hook thread is not running".to_string())?;
        response
            .recv()
            .map_err(|_| "the hook thread stopped before answering".to_string())?
    }

    pub fn register(&self, id: String, binding: Binding, role: Role) -> Result<(), String> {
        self.call(|reply| Command::Register { id, binding, role, reply })
    }

    pub fn unregister(&self, id: String) -> Result<(), String> {
        self.call(|reply| Command::Unregister { id, reply })
    }

    pub fn suspend(&self, id: Option<String>) -> Result<(), String> {
        self.call(|reply| Command::Suspend(id, reply))
    }

    pub fn resume(&self, id: Option<String>) -> Result<(), String> {
        self.call(|reply| Command::Resume(id, reply))
    }

    fn post(&self, command: Command) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "the hook thread is not running".to_string())
    }

    pub fn trigger_external(&self, id: String, pressed: bool) -> Result<(), String> {
        self.post(Command::External { id, pressed })
    }
}

impl Drop for Hook {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run(
    commands: Receiver<Command>,
    carbon: Receiver<(String, bool)>,
    sink: EffectSink,
    ready: Sender<Result<(), String>>,
) -> Result<(), String> {
    let blocking = Arc::new(Mutex::new(HashSet::new()));
    // Blocking needs /dev/uinput on Linux. Without it the binding still
    // triggers, it just also reaches the focused app.
    let listener = match KeyboardListener::new_with_blocking(Arc::clone(&blocking)) {
        Ok(listener) => listener,
        Err(_) => KeyboardListener::new().map_err(|e| e.to_string())?,
    };
    if ready.send(Ok(())).is_err() {
        return Ok(());
    }

    let mut entries: Vec<Entry> = Vec::new();
    let mut suspended = false;
    // Kept apart from the entries so a binding switched off before it is
    // registered (Flow's off switch is read at startup) stays off once it is.
    let mut muted: HashSet<String> = HashSet::new();
    // Not AltGr until a Right Alt press says otherwise: the press itself re-reads it.
    let mut right_alt = RightAlt { altgr: true, layout_has_altgr: crate::platform::current::right_alt_is_altgr };

    loop {
        loop {
            match commands.try_recv() {
                Ok(Command::Shutdown) | Err(TryRecvError::Disconnected) => return Ok(()),
                Ok(command) => {
                    apply(command, &mut entries, &mut suspended, &mut muted, &blocking, &sink);
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        while let Ok((id, pressed)) = carbon.try_recv() {
            // Secure input killed the event tap for this binding, so the
            // Carbon shadow is feeding it instead.
            feed(&mut entries, &id, pressed, false, false, &sink);
        }

        expire(&mut entries, Instant::now(), &sink);

        let wait = entries
            .iter()
            .filter_map(|e| e.coordinator.next_deadline())
            .min()
            .map(|d| d.saturating_duration_since(Instant::now()))
            .unwrap_or(TICK)
            .min(TICK);

        match listener.recv_timeout(wait) {
            Ok(mut event) => {
                if !suspended {
                    if let Some(held) = os_held_modifiers() {
                        event.modifiers = drop_released(event.modifiers, held, event.changed_modifier);
                    }
                    on_key_event(&mut entries, &muted, &event, Instant::now(), &mut right_alt, &sink);
                }
            }
            Err(handy_keys::Error::Timeout) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Judges every press whose release grace window has closed.
fn expire(entries: &mut [Entry], now: Instant, sink: &EffectSink) {
    for entry in entries {
        if entry.coordinator.next_deadline().is_some_and(|d| d <= now) {
            if let Some(effect) = entry.coordinator.on_grace_expired(now) {
                sink(effect);
            }
        }
    }
}

fn apply(
    command: Command,
    entries: &mut Vec<Entry>,
    suspended: &mut bool,
    muted: &mut HashSet<String>,
    blocking: &Arc<Mutex<HashSet<handy_keys::Hotkey>>>,
    sink: &EffectSink,
) {
    match command {
        Command::Register { id, binding, role, reply } => {
            entries.retain(|entry| entry.id != id);
            entries.push(Entry {
                coordinator: CoordinatorState::new(id.clone(), role),
                id,
                binding,
                role,
                watched: None,
                pressed: false,
            });
            sync(entries, *suspended, muted, blocking);
            let _ = reply.send(Ok(()));
        }
        Command::Unregister { id, reply } => {
            let before = entries.len();
            entries.retain(|entry| entry.id != id);
            let result = if entries.len() == before {
                Err(format!("no binding registered as \"{id}\""))
            } else {
                Ok(())
            };
            sync(entries, *suspended, muted, blocking);
            let _ = reply.send(result);
        }
        Command::Suspend(Some(id), reply) => {
            muted.insert(id);
            sync(entries, *suspended, muted, blocking);
            let _ = reply.send(Ok(()));
        }
        Command::Resume(Some(id), reply) => {
            muted.remove(&id);
            sync(entries, *suspended, muted, blocking);
            let _ = reply.send(Ok(()));
        }
        Command::Suspend(None, reply) => {
            *suspended = true;
            sync(entries, true, muted, blocking);
            let _ = reply.send(Ok(()));
        }
        Command::Resume(None, reply) => {
            *suspended = false;
            sync(entries, false, muted, blocking);
            let _ = reply.send(Ok(()));
        }
        Command::External { id, pressed } => feed(entries, &id, pressed, true, false, sink),
        Command::Shutdown => {}
    }
}

/// Re-derives what each entry watches, and keeps the blocked set and the
/// secure-input shadow list in step with it. O(entries x holds), a handful.
///
/// A modifier is never blocked. The toggles are plain modifiers the focused app
/// uses for its own shortcuts, and the gesture is two taps of one alone:
/// watching is enough, and swallowing it would break every shortcut on the
/// machine. A key that is a real key (F13 to F24), held or double tapped, is
/// blocked, or every press would also reach the app in front.
fn sync(entries: &mut [Entry], suspended: bool, muted: &HashSet<String>, blocking: &Arc<Mutex<HashSet<handy_keys::Hotkey>>>) {
    let holds: Vec<Binding> = entries.iter().filter(|e| e.role == Role::Hold).map(|e| e.binding).collect();
    for entry in entries.iter_mut() {
        let watched = match entry.role {
            Role::Hold => Some(entry.binding),
            Role::Toggle => holds.iter().try_fold(entry.binding, |b, hold| b.narrow(*hold)),
        };
        if watched != entry.watched {
            // Rebound live: whatever was half done on the old key means nothing on the new one.
            entry.watched = watched;
            entry.pressed = false;
            entry.coordinator = CoordinatorState::new(entry.id.clone(), entry.role);
        }
    }
    if let Ok(mut set) = blocking.lock() {
        set.clear();
        if !suspended {
            set.extend(
                entries
                    .iter()
                    .filter(|e| !muted.contains(&e.id))
                    .filter_map(|e| e.watched)
                    .filter(|b| !b.is_modifier_only())
                    .map(|b| b.hotkey()),
            );
        }
    }
    secure_input::set_shadow_bindings(
        entries.iter().filter_map(|entry| Some((entry.id.clone(), entry.watched?))).collect(),
    );
}

fn feed(
    entries: &mut [Entry],
    id: &str,
    pressed: bool,
    external: bool,
    other_key: bool,
    sink: &EffectSink,
) {
    let now = Instant::now();
    for entry in entries.iter_mut().filter(|entry| entry.id == id) {
        let input = Input { pressed, external, other_key };
        if let Some(effect) = entry.coordinator.on_input(input, now) {
            sink(effect);
        }
    }
}

/// handy-keys re-reads the OS modifier state only on ordinary key events, never
/// on a bare modifier press. A release it missed (⌘ lifted while ⌘Q was closing
/// the window) then rode along on every Control tap, so each tap read as a
/// chord and Flow could not be opened until some letter was typed. A group the
/// OS says is up is dropped, except the one this event is changing.
fn drop_released(mods: Modifiers, held: Modifiers, changed: Option<Modifiers>) -> Modifiers {
    let mut out = mods;
    for group in [Modifiers::CMD, Modifiers::SHIFT, Modifiers::OPT, Modifiers::CTRL] {
        let changing = changed.is_some_and(|c| c.intersects(group));
        if !changing && out.intersects(group) && !held.intersects(group) {
            out.remove(group);
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn os_held_modifiers() -> Option<Modifiers> {
    use objc2_core_graphics::{CGEventFlags, CGEventSource, CGEventSourceStateID};
    let flags = CGEventSource::flags_state(CGEventSourceStateID::CombinedSessionState);
    let groups = [
        (CGEventFlags::MaskCommand, Modifiers::CMD),
        (CGEventFlags::MaskShift, Modifiers::SHIFT),
        (CGEventFlags::MaskAlternate, Modifiers::OPT),
        (CGEventFlags::MaskControl, Modifiers::CTRL),
    ];
    Some(groups.into_iter().filter(|(f, _)| flags.contains(*f)).fold(Modifiers::empty(), |m, (_, g)| m | g))
}

#[cfg(not(target_os = "macos"))]
fn os_held_modifiers() -> Option<Modifiers> {
    None
}

fn on_key_event(
    entries: &mut [Entry],
    muted: &HashSet<String>,
    event: &KeyEvent,
    now: Instant,
    right_alt: &mut RightAlt,
    sink: &EffectSink,
) {
    let toggles_right_alt = || {
        entries
            .iter()
            .any(|e| e.role == Role::Toggle && e.watched.is_some_and(|b| b.modifiers.contains(Modifiers::OPT_RIGHT)))
    };
    if event.is_key_down && event.changed_modifier == Some(Modifiers::OPT_RIGHT) && toggles_right_alt() {
        right_alt.altgr = (right_alt.layout_has_altgr)();
    }
    for entry in entries.iter_mut().filter(|entry| !muted.contains(&entry.id)) {
        let Some(mut binding) = entry.watched else { continue };
        // AltGr types characters, so on such a layout Right Alt is never half of
        // a gesture: it reads as any other key would.
        if entry.role == Role::Toggle && right_alt.altgr {
            match binding.without(Modifiers::OPT_RIGHT) {
                Some(b) => binding = b,
                None => continue,
            }
        }
        let hotkey = binding.hotkey();
        let matches = hotkey.modifiers.matches(event.modifiers) && hotkey.key == event.key;
        // The physical key this event is about belongs to the binding.
        let ours = match event.key {
            Some(key) => hotkey.key == Some(key),
            None => event.changed_modifier.is_some_and(|c| hotkey.modifiers.contains(c)),
        };

        let input = if event.is_key_down {
            if matches && !entry.pressed {
                entry.pressed = true;
                #[cfg(target_os = "windows")]
                if hotkey.key.is_none() && hotkey.modifiers.intersects(Modifiers::OPT | Modifiers::CMD) {
                    crate::platform::windows::mask_menu();
                }
                Some((true, false))
            } else if !ours {
                // Another key: on top of this one (a shortcut, Option+letter
                // typing), or between two of its taps. Either way it is not the
                // gesture, and the combination goes through untouched.
                entry.pressed = false;
                Some((true, true))
            } else {
                None
            }
        } else {
            let released = if event.key.is_some() {
                hotkey.key == event.key
            } else {
                !hotkey.modifiers.matches(event.modifiers)
            };
            if entry.pressed && released {
                entry.pressed = false;
                Some((false, false))
            } else {
                None
            }
        };

        let Some((pressed, other_key)) = input else { continue };
        let input = Input { pressed, external: false, other_key };
        if let Some(effect) = entry.coordinator.on_input(input, now) {
            sink(effect);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::coordinator::RELEASE_GRACE;

    /// The hook thread's state, driven by hand: commands through `apply`,
    /// events through `on_key_event`, and the clock through `at`.
    struct Rig {
        entries: Vec<Entry>,
        muted: HashSet<String>,
        suspended: bool,
        blocking: Arc<Mutex<HashSet<handy_keys::Hotkey>>>,
        right_alt: RightAlt,
        sink: EffectSink,
        effects: Arc<Mutex<Vec<Effect>>>,
        t0: Instant,
    }

    fn rig(layout_has_altgr: fn() -> bool) -> Rig {
        let effects = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&effects);
        Rig {
            entries: Vec::new(),
            muted: HashSet::new(),
            suspended: false,
            blocking: Arc::new(Mutex::new(HashSet::new())),
            right_alt: RightAlt { altgr: true, layout_has_altgr },
            sink: Arc::new(move |e| seen.lock().unwrap().push(e)),
            effects,
            t0: Instant::now(),
        }
    }

    impl Rig {
        fn register(&mut self, id: &str, binding: &str, role: Role) {
            let (reply, _answer) = channel();
            let command = Command::Register { id: id.into(), binding: binding.parse().unwrap(), role, reply };
            apply(command, &mut self.entries, &mut self.suspended, &mut self.muted, &self.blocking, &self.sink);
        }

        fn unregister(&mut self, id: &str) {
            let (reply, _answer) = channel();
            apply(Command::Unregister { id: id.into(), reply }, &mut self.entries, &mut self.suspended, &mut self.muted, &self.blocking, &self.sink);
        }

        /// Everything due by `ms` after the start, then the event.
        fn event(&mut self, ms: u64, modifiers: Modifiers, key: Option<Key>, is_key_down: bool, changed_modifier: Option<Modifiers>) {
            let now = self.t0 + Duration::from_millis(ms);
            expire(&mut self.entries, now, &self.sink);
            let event = KeyEvent { modifiers, key, is_key_down, changed_modifier };
            on_key_event(&mut self.entries, &self.muted, &event, now, &mut self.right_alt, &self.sink);
        }

        /// A modifier pressed alone at `ms` and let go `held` later.
        fn tap(&mut self, ms: u64, side: Modifiers, held: u64) {
            self.event(ms, side, None, true, Some(side));
            self.event(ms + held, Modifiers::empty(), None, false, Some(side));
        }

        fn key_tap(&mut self, ms: u64, key: Key, held: u64) {
            self.event(ms, Modifiers::empty(), Some(key), true, None);
            self.event(ms + held, Modifiers::empty(), Some(key), false, None);
        }

        /// Lets every grace window close, then hands over what came out.
        fn settle(&mut self, ms: u64) -> Vec<Effect> {
            expire(&mut self.entries, self.t0 + Duration::from_millis(ms) + RELEASE_GRACE, &self.sink);
            std::mem::take(&mut *self.effects.lock().unwrap())
        }
    }

    fn tapped(id: &str) -> Effect {
        Effect::DoubleTap { binding_id: id.into() }
    }

    fn no_altgr() -> bool {
        false
    }

    fn altgr() -> bool {
        true
    }

    #[test]
    fn a_double_tap_of_control_reaches_the_sink() {
        let mut r = rig(no_altgr);
        r.register("flow", "ctrl", Role::Toggle);
        r.tap(0, Modifiers::CTRL_LEFT, 40);
        r.tap(200, Modifiers::CTRL_RIGHT, 40);
        assert_eq!(r.settle(300), vec![tapped("flow")]);
    }

    /// Option+letter typing: a key on the held Option, then Option again.
    #[test]
    fn option_as_a_modifier_is_never_a_gesture() {
        let mut r = rig(no_altgr);
        r.register("dictate", "option", Role::Toggle);
        r.tap(0, Modifiers::OPT_LEFT, 40);
        r.event(150, Modifiers::OPT_LEFT, None, true, Some(Modifiers::OPT_LEFT));
        r.event(170, Modifiers::OPT_LEFT, Some(Key::E), true, None);
        r.event(190, Modifiers::OPT_LEFT, Some(Key::E), false, None);
        r.event(210, Modifiers::empty(), None, false, Some(Modifiers::OPT_LEFT));
        assert_eq!(r.settle(300), vec![]);
        // Option+arrow, the word-jump, is the same.
        r.event(1000, Modifiers::OPT_RIGHT, None, true, Some(Modifiers::OPT_RIGHT));
        r.event(1020, Modifiers::OPT_RIGHT, Some(Key::LeftArrow), true, None);
        r.event(1060, Modifiers::empty(), None, false, Some(Modifiers::OPT_RIGHT));
        r.tap(1150, Modifiers::OPT_RIGHT, 40);
        assert_eq!(r.settle(1300), vec![]);
    }

    #[test]
    fn a_key_typed_between_the_taps_breaks_them() {
        let mut r = rig(no_altgr);
        r.register("flow", "ctrl", Role::Toggle);
        r.tap(0, Modifiers::CTRL_LEFT, 40);
        r.key_tap(100, Key::A, 30);
        r.tap(200, Modifiers::CTRL_LEFT, 40);
        assert_eq!(r.settle(300), vec![]);
        // Another modifier between them counts too.
        r.tap(1000, Modifiers::CTRL_LEFT, 40);
        r.tap(1080, Modifiers::SHIFT_LEFT, 30);
        r.tap(1200, Modifiers::CTRL_LEFT, 40);
        assert_eq!(r.settle(1300), vec![]);
    }

    /// Windows and evdev repeat a held modifier's key-down.
    #[test]
    fn a_held_and_repeating_key_is_not_a_tap() {
        let mut r = rig(no_altgr);
        r.register("flow", "ctrl", Role::Toggle);
        r.tap(0, Modifiers::CTRL_LEFT, 40);
        for i in 0..10u64 {
            r.event(150 + i * 33, Modifiers::CTRL_LEFT, None, true, Some(Modifiers::CTRL_LEFT));
        }
        r.event(600, Modifiers::empty(), None, false, Some(Modifiers::CTRL_LEFT));
        assert_eq!(r.settle(700), vec![]);
    }

    /// Push to talk on Right Ctrl: holds there, and Flow's double-tap on the left only.
    #[test]
    fn the_push_to_talk_side_holds_and_the_other_side_toggles() {
        let mut r = rig(no_altgr);
        r.register("flow", "ctrl", Role::Toggle);
        r.register("ptt", "ctrl_right", Role::Hold);
        r.tap(0, Modifiers::CTRL_RIGHT, 40);
        r.tap(150, Modifiers::CTRL_RIGHT, 40);
        let cancel = Effect::HoldCancel { binding_id: "ptt".into() };
        let start = Effect::HoldStart { binding_id: "ptt".into() };
        assert_eq!(r.settle(300), vec![start.clone(), cancel.clone(), start.clone(), cancel]);
        r.tap(1000, Modifiers::CTRL_LEFT, 40);
        r.tap(1150, Modifiers::CTRL_LEFT, 40);
        assert_eq!(r.settle(1300), vec![tapped("flow")]);
        r.event(2000, Modifiers::CTRL_RIGHT, None, true, Some(Modifiers::CTRL_RIGHT));
        r.event(3500, Modifiers::empty(), None, false, Some(Modifiers::CTRL_RIGHT));
        assert_eq!(r.settle(3600), vec![start, Effect::HoldEnd { binding_id: "ptt".into() }]);
    }

    #[test]
    fn rebinding_takes_effect_at_once() {
        let mut r = rig(no_altgr);
        r.register("flow", "ctrl", Role::Toggle);
        r.register("flow", "f19", Role::Toggle);
        r.tap(0, Modifiers::CTRL_LEFT, 40);
        r.tap(150, Modifiers::CTRL_LEFT, 40);
        assert_eq!(r.settle(300), vec![]);
        r.key_tap(1000, Key::F19, 40);
        r.key_tap(1150, Key::F19, 40);
        assert_eq!(r.settle(1300), vec![tapped("flow")]);
    }

    /// The narrowing follows the push-to-talk key in and out, with no restart.
    #[test]
    fn a_toggle_narrows_while_the_hold_key_is_registered_and_widens_after() {
        let mut r = rig(no_altgr);
        r.register("flow", "ctrl", Role::Toggle);
        r.register("ptt", "ctrl_right", Role::Hold);
        assert_eq!(r.entries[0].watched, Some("ctrl_left".parse().unwrap()));
        r.unregister("ptt");
        assert_eq!(r.entries[0].watched, Some("ctrl".parse().unwrap()));
        r.register("ptt", "ctrl_right", Role::Hold);
        r.register("flow", "ctrl_right", Role::Toggle);
        assert_eq!(r.entries.iter().find(|e| e.id == "flow").unwrap().watched, None);
        r.tap(0, Modifiers::CTRL_RIGHT, 40);
        r.tap(150, Modifiers::CTRL_RIGHT, 40);
        assert!(!r.settle(300).contains(&tapped("flow")));
    }

    #[test]
    fn a_key_that_types_is_blocked_held_or_tapped_and_a_modifier_never_is() {
        let mut r = rig(no_altgr);
        r.register("flow", "ctrl", Role::Toggle);
        r.register("ptt", "fn", Role::Hold);
        assert!(r.blocking.lock().unwrap().is_empty());
        r.register("ptt", "f18", Role::Hold);
        let blocked: Vec<_> = r.blocking.lock().unwrap().iter().copied().collect();
        assert_eq!(blocked, vec!["f18".parse::<Binding>().unwrap().hotkey()]);
        r.unregister("ptt");
        assert!(r.blocking.lock().unwrap().is_empty());
        r.register("dictate", "f20", Role::Toggle);
        let blocked: Vec<_> = r.blocking.lock().unwrap().iter().copied().collect();
        assert_eq!(blocked, vec!["f20".parse::<Binding>().unwrap().hotkey()]);
    }

    /// AltGr types characters on this layout, so only Left Alt makes the gesture.
    #[test]
    fn right_alt_counts_only_where_it_is_not_altgr() {
        let mut r = rig(altgr);
        r.register("dictate", "option", Role::Toggle);
        r.tap(0, Modifiers::OPT_RIGHT, 40);
        r.tap(150, Modifiers::OPT_RIGHT, 40);
        assert_eq!(r.settle(300), vec![]);
        r.tap(1000, Modifiers::OPT_LEFT, 40);
        r.tap(1150, Modifiers::OPT_LEFT, 40);
        assert_eq!(r.settle(1300), vec![tapped("dictate")]);

        let mut r = rig(no_altgr);
        r.register("dictate", "option", Role::Toggle);
        r.tap(0, Modifiers::OPT_RIGHT, 40);
        r.tap(150, Modifiers::OPT_RIGHT, 40);
        assert_eq!(r.settle(300), vec![tapped("dictate")]);
    }

    /// An AltGr character typed between two Left Alt taps breaks them.
    #[test]
    fn altgr_typing_between_taps_breaks_them() {
        let mut r = rig(altgr);
        r.register("dictate", "option", Role::Toggle);
        r.tap(0, Modifiers::OPT_LEFT, 40);
        r.event(100, Modifiers::OPT_RIGHT, None, true, Some(Modifiers::OPT_RIGHT));
        r.event(120, Modifiers::OPT_RIGHT, Some(Key::Q), true, None);
        r.event(160, Modifiers::empty(), None, false, Some(Modifiers::OPT_RIGHT));
        r.tap(200, Modifiers::OPT_LEFT, 40);
        assert_eq!(r.settle(300), vec![]);
    }

    #[test]
    fn a_muted_binding_hears_nothing() {
        let mut r = rig(no_altgr);
        r.register("flow", "ctrl", Role::Toggle);
        r.muted.insert("flow".into());
        r.tap(0, Modifiers::CTRL_LEFT, 40);
        r.tap(150, Modifiers::CTRL_LEFT, 40);
        assert_eq!(r.settle(300), vec![]);
    }

    #[test]
    fn a_missed_release_is_dropped() {
        // ⌘ still tracked after ⌘Q, but the OS says only Control is down.
        let mods = Modifiers::CTRL_LEFT | Modifiers::CMD_LEFT;
        assert_eq!(drop_released(mods, Modifiers::CTRL, Some(Modifiers::CTRL_LEFT)), Modifiers::CTRL_LEFT);
    }

    #[test]
    fn a_real_chord_is_kept() {
        let mods = Modifiers::CTRL_LEFT | Modifiers::CMD_LEFT;
        assert_eq!(drop_released(mods, Modifiers::CTRL | Modifiers::CMD, Some(Modifiers::CTRL_LEFT)), mods);
    }

    #[test]
    fn the_changing_modifier_is_trusted_over_a_late_os_read() {
        // Control was tapped and already lifted by the time the state is read.
        assert_eq!(drop_released(Modifiers::CTRL_LEFT, Modifiers::empty(), Some(Modifiers::CTRL_LEFT)), Modifiers::CTRL_LEFT);
    }
}
