//! Text insertion into whatever app has focus, and the streaming session that
//! makes a model's `insert_text` land progressively instead of in one lump.

use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::paste_tx;
use crate::platform::current as platform;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Paste,
    Type,
}

impl Method {
    /// Linux types by default: its clipboard managers are too varied for a
    /// paste chord to be the reliable path.
    pub fn default_for_platform() -> Method {
        if cfg!(target_os = "linux") {
            Method::Type
        } else {
            Method::Paste
        }
    }
}

#[cfg(target_os = "macos")]
mod layout {
    use super::platform;
    use std::sync::atomic::{AtomicU16, Ordering};

    /// Keycode 9 is V only on a US-ANSI layout. Dvorak and non-Latin layouts
    /// move it, so the real one is resolved from the active layout.
    const FALLBACK: u16 = 9;
    const UNRESOLVED: u16 = u16::MAX;
    static PASTE_KEYCODE: AtomicU16 = AtomicU16::new(UNRESOLVED);

    /// Must be called from the main thread: TIS reads main-thread state.
    pub fn refresh() {
        if let Some(keycode) = platform::resolve_paste_keycode() {
            PASTE_KEYCODE.store(keycode, Ordering::Relaxed);
        }
    }

    pub fn paste_keycode() -> u16 {
        match PASTE_KEYCODE.load(Ordering::Relaxed) {
            UNRESOLVED => {
                eprintln!("[ol-input] keyboard layout unresolved, pasting with keycode 9");
                FALLBACK
            }
            keycode => keycode,
        }
    }
}

/// Re-resolves anything layout-dependent. Called from the addon's main thread
/// on every entry point, because the user can switch layout at any time.
pub fn refresh_layout() {
    #[cfg(target_os = "macos")]
    layout::refresh();
}

fn send_paste_chord() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return platform::send_paste_chord(layout::paste_keycode());
    #[cfg(not(target_os = "macos"))]
    return platform::send_paste_chord();
}

/// A paste that is going to happen has happened within a frame or two of the
/// chord. Past that, the app is not pasting, and saying so beats reporting
/// text the user never received.
const RECEIPT_WAIT: Duration = Duration::from_millis(500);

const NOT_TAKEN: &str =
    "the paste keystroke went out but the app never took the text, so nothing \
     was inserted: click into the place the text should go and try again";

pub fn insert(text: &str, method: Method) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    match method {
        Method::Type => platform::type_text(text),
        Method::Paste => {
            let tx = paste_tx::begin(text)?;
            let result = send_paste_chord();
            let taken = result.is_ok() && tx.was_read(RECEIPT_WAIT);
            // Unconditional: a failed chord leaves the user's clipboard just
            // as hijacked as a successful one.
            tx.finish(result.is_ok());
            result?;
            if taken || !paste_tx::PROMISES {
                Ok(())
            } else {
                Err(NOT_TAKEN.into())
            }
        }
    }
}

#[derive(Default)]
struct Pending {
    buffer: String,
    ended: bool,
    error: Option<String>,
}

/// One streamed insertion. Chunks pushed while a paste is still in flight
/// pile up in the buffer and go out as a single next chunk.
pub struct Session {
    shared: Arc<(Mutex<Pending>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

impl Session {
    pub fn begin(method: Method) -> Session {
        let shared = Arc::new((Mutex::new(Pending::default()), Condvar::new()));
        let worker_shared = Arc::clone(&shared);
        let worker = std::thread::spawn(move || {
            let (lock, cvar) = &*worker_shared;
            loop {
                let chunk = {
                    let mut pending = match lock.lock() {
                        Ok(pending) => pending,
                        Err(_) => return,
                    };
                    while pending.buffer.is_empty() && !pending.ended {
                        pending = match cvar.wait(pending) {
                            Ok(pending) => pending,
                            Err(_) => return,
                        };
                    }
                    if pending.buffer.is_empty() {
                        return;
                    }
                    std::mem::take(&mut pending.buffer)
                };
                if let Err(e) = insert(&chunk, method) {
                    if let Ok(mut pending) = lock.lock() {
                        pending.error.get_or_insert(e);
                    }
                    return;
                }
            }
        });
        Session { shared, worker: Some(worker) }
    }

    pub fn push(&self, chunk: &str) -> Result<(), String> {
        let (lock, cvar) = &*self.shared;
        let mut pending = lock.lock().map_err(|_| "insertion session poisoned")?;
        if let Some(error) = &pending.error {
            return Err(error.clone());
        }
        pending.buffer.push_str(chunk);
        cvar.notify_all();
        Ok(())
    }

    pub fn end(mut self) -> Result<(), String> {
        {
            let (lock, cvar) = &*self.shared;
            let mut pending = lock.lock().map_err(|_| "insertion session poisoned")?;
            pending.ended = true;
            cvar.notify_all();
        }
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| "the insertion thread panicked")?;
        }
        let (lock, _) = &*self.shared;
        let pending = lock.lock().map_err(|_| "insertion session poisoned")?;
        match &pending.error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let Some(worker) = self.worker.take() else {
            return;
        };
        let (lock, cvar) = &*self.shared;
        if let Ok(mut pending) = lock.lock() {
            pending.ended = true;
        }
        cvar.notify_all();
        let _ = worker.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard;
    use std::time::{Duration, Instant};

    /// Closing a session joins its typing thread, so the session has to be able
    /// to travel to a worker: on the Electron main thread that join is the UI,
    /// the tray and every window frozen until the last character is typed.
    #[test]
    fn a_session_can_be_closed_off_the_thread_that_opened_it() {
        let session = Session::begin(Method::Type);
        std::thread::spawn(move || session.end())
            .join()
            .expect("the closing thread panicked")
            .expect("the session did not close");
    }

    #[test]
    fn empty_text_is_not_an_injection() {
        assert!(insert("", Method::Type).is_ok());
    }

    /// The restore has to run whether or not the keystroke landed, so this
    /// drives the failure path and waits for the user's clipboard to return.
    #[test]
    fn a_failed_injection_still_restores_the_clipboard() {
        const SENTINEL: &str = "ol-input restore ordering sentinel";
        if clipboard::set_text(SENTINEL).is_err() {
            return; // headless runner with no clipboard
        }
        let Ok(tx) = paste_tx::begin("ol-input payload") else {
            return;
        };
        tx.finish(false);

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if clipboard::current_text().as_deref() == Some(SENTINEL) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the clipboard was never restored after a failed injection");
    }
}
