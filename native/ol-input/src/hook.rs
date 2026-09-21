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

use handy_keys::{KeyEvent, KeyboardListener};

use crate::binding::Binding;
use crate::coordinator::{Activation, CoordinatorState, Effect, Input};
use crate::secure_input;

/// How long the manager thread waits on the listener before looking at its
/// command queue and its coordinator deadlines again.
const TICK: Duration = Duration::from_millis(20);

pub type EffectSink = Arc<dyn Fn(Effect) + Send + Sync>;

enum Command {
    Register {
        id: String,
        binding: Binding,
        activation: Activation,
        hold_threshold: Duration,
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
    ProcessingFinished,
    StartFailed,
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

    pub fn register(
        &self,
        id: String,
        binding: Binding,
        activation: Activation,
        hold_threshold: Duration,
    ) -> Result<(), String> {
        self.call(|reply| Command::Register { id, binding, activation, hold_threshold, reply })
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

    pub fn processing_finished(&self) -> Result<(), String> {
        self.post(Command::ProcessingFinished)
    }

    pub fn start_failed(&self) -> Result<(), String> {
        self.post(Command::StartFailed)
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
        Command::Register { id, binding, activation, hold_threshold, reply } => {
            entries.retain(|entry| entry.id != id);
            entries.push(Entry {
                id,
                binding,
                coordinator: CoordinatorState::new(
                    activation,
                    hold_threshold,
                    binding.is_modifier_only(),
                ),
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
        Command::ProcessingFinished => {
            let now = Instant::now();
            for entry in entries.iter_mut() {
                if let Some(effect) = entry.coordinator.on_processing_finished(now) {
                    sink(effect);
                }
            }
        }
        Command::StartFailed => {
            for entry in entries.iter_mut() {
                entry.coordinator.on_start_failed();
            }
        }
        Command::Shutdown => {}
    }
}

/// Keeps the blocked-hotkey set and the secure-input shadow list in step with
/// what is registered.
fn sync(
    entries: &[Entry],
    suspended: bool,
    blocking: &Arc<Mutex<HashSet<handy_keys::Hotkey>>>,
) {
    if let Ok(mut set) = blocking.lock() {
        set.clear();
        if !suspended {
            set.extend(entries.iter().map(|entry| entry.binding.hotkey()));
        }
    }
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
        let input = Input {
            binding_id: entry.id.clone(),
            pressed,
            external,
            other_key,
        };
        if let Some(effect) = entry.coordinator.on_input(input, now) {
            sink(effect.clone());
        }
    }
}

fn on_key_event(entries: &mut [Entry], event: &KeyEvent, sink: &EffectSink) {
    let now = Instant::now();
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
        let input = Input {
            binding_id: entry.id.clone(),
            pressed,
            external: false,
            other_key,
        };
        if let Some(effect) = entry.coordinator.on_input(input, now) {
            sink(effect);
        }
    }
}
