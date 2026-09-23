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

use crate::binding::Binding;
use crate::coordinator::{CoordinatorState, Effect, Input};
use crate::secure_input;

/// How long the manager thread waits on the listener before looking at its
/// command queue and its coordinator deadlines again.
const TICK: Duration = Duration::from_millis(20);

pub type EffectSink = Arc<dyn Fn(Effect) + Send + Sync>;

enum Command {
    Register {
        id: String,
        binding: Binding,
        reply: Sender<Result<(), String>>,
    },
    Unregister {
        id: String,
        reply: Sender<Result<(), String>>,
    },
    Suspend(Sender<Result<(), String>>),
    Resume(Sender<Result<(), String>>),
    External {
        id: String,
        pressed: bool,
    },
    Closed,
    Shutdown,
}

struct Entry {
    id: String,
    binding: Binding,
    coordinator: CoordinatorState,
    pressed: bool,
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

    pub fn register(&self, id: String, binding: Binding) -> Result<(), String> {
        self.call(|reply| Command::Register { id, binding, reply })
    }

    pub fn unregister(&self, id: String) -> Result<(), String> {
        self.call(|reply| Command::Unregister { id, reply })
    }

    pub fn suspend(&self) -> Result<(), String> {
        self.call(Command::Suspend)
    }

    pub fn resume(&self) -> Result<(), String> {
        self.call(Command::Resume)
    }

    fn post(&self, command: Command) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "the hook thread is not running".to_string())
    }

    pub fn trigger_external(&self, id: String, pressed: bool) -> Result<(), String> {
        self.post(Command::External { id, pressed })
    }

    /// Flow closed for a reason the hook never saw. See `on_closed`.
    pub fn closed(&self) -> Result<(), String> {
        self.post(Command::Closed)
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

    loop {
        loop {
            match commands.try_recv() {
                Ok(Command::Shutdown) | Err(TryRecvError::Disconnected) => return Ok(()),
                Ok(command) => {
                    apply(command, &mut entries, &mut suspended, &blocking, &sink);
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        while let Ok((id, pressed)) = carbon.try_recv() {
            // Secure input killed the event tap for this binding, so the
            // Carbon shadow is feeding it instead.
            feed(&mut entries, &id, pressed, false, false, &sink);
        }

        let now = Instant::now();
        for entry in &mut entries {
            if entry.coordinator.next_deadline().is_some_and(|d| d <= now) {
                if let Some(effect) = entry.coordinator.on_grace_expired(now) {
                    sink(effect);
                }
            }
        }

        let wait = entries
            .iter()
            .filter_map(|e| e.coordinator.next_deadline())
            .min()
            .map(|d| d.saturating_duration_since(Instant::now()))
            .unwrap_or(TICK)
            .min(TICK);

        match listener.recv_timeout(wait) {
            Ok(event) => {
                if !suspended {
                    on_key_event(&mut entries, &event, &sink);
                }
            }
            Err(handy_keys::Error::Timeout) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn apply(
    command: Command,
    entries: &mut Vec<Entry>,
    suspended: &mut bool,
    blocking: &Arc<Mutex<HashSet<handy_keys::Hotkey>>>,
    sink: &EffectSink,
) {
    match command {
        Command::Register { id, binding, reply } => {
            entries.retain(|entry| entry.id != id);
            entries.push(Entry {
                coordinator: CoordinatorState::new(id.clone()),
                id,
                binding,
                pressed: false,
            });
            sync(entries, *suspended, blocking);
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
            sync(entries, *suspended, blocking);
            let _ = reply.send(result);
        }
        Command::Suspend(reply) => {
            *suspended = true;
            sync(entries, true, blocking);
            let _ = reply.send(Ok(()));
        }
        Command::Resume(reply) => {
            *suspended = false;
            sync(entries, false, blocking);
            let _ = reply.send(Ok(()));
        }
        Command::External { id, pressed } => feed(entries, &id, pressed, true, false, sink),
        Command::Closed => {
            for entry in entries.iter_mut() {
                entry.coordinator.on_closed();
            }
        }
        Command::Shutdown => {}
    }
}

/// Keeps the secure-input shadow list in step with what is registered.
///
/// Nothing is ever added to the blocked-hotkey set. The trigger is a plain
/// modifier the focused app is using for its own shortcuts, and the gesture is
/// two taps of it alone: watching is enough, and swallowing it would break
/// every shortcut on the machine.
fn sync(entries: &[Entry], suspended: bool, blocking: &Arc<Mutex<HashSet<handy_keys::Hotkey>>>) {
    if let Ok(mut set) = blocking.lock() {
        set.clear();
    }
    let _ = suspended;
    secure_input::set_shadow_bindings(
        entries.iter().map(|entry| (entry.id.clone(), entry.binding)).collect(),
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

fn on_key_event(entries: &mut [Entry], event: &KeyEvent, sink: &EffectSink) {
    let now = Instant::now();
    let mut event = *event;
    if let Some(held) = os_held_modifiers() {
        event.modifiers = drop_released(event.modifiers, held, event.changed_modifier);
    }
    let event = &event;
    for entry in entries.iter_mut() {
        let hotkey = entry.binding.hotkey();
        let matches = hotkey.modifiers.matches(event.modifiers) && hotkey.key == event.key;

        let input = if event.is_key_down {
            if matches && !entry.pressed {
                entry.pressed = true;
                Some((true, false))
            } else if entry.pressed && hotkey.key.is_none() && event.key.is_some() {
                // A real key landed on top of a held modifier-only binding.
                // Cancel and let the combination through.
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
