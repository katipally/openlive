//! Receipt-sequenced clipboard. The paste keystroke is only enqueued when it
//! is sent, so a fixed-delay restore races the target app's event loop. The
//! text is published as a lazy promise and the clipboard is put back only
//! once the OS reports that a consumer actually read it.

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::clipboard::{self, Saved};

/// How long after the last read to wait before restoring, so an app that
/// reads the pasteboard several times in a row is not cut off mid-paste.
const QUIET: Duration = Duration::from_millis(200);
/// Nothing may hold the user's clipboard hostage longer than this.
const CAP: Duration = Duration::from_secs(8);
/// When injection failed, nothing is going to read the promise, so the
/// clipboard comes back fast instead of after the full cap.
const FAILED_CAP: Duration = Duration::from_millis(600);
const POLL: Duration = Duration::from_millis(20);
/// Finer than `POLL`: this one is on the insertion's own path, so the cost of
/// a granted, working paste is however long the app takes plus one of these.
const RECEIPT_POLL: Duration = Duration::from_millis(4);

/// Whether this platform publishes lazily and can therefore tell whether the
/// text was taken. Linux sets the clipboard outright, so a paste there has no
/// receipt and nothing may claim one.
pub const PROMISES: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// Set by the platform's lazy provider when a consumer pulls the data.
#[derive(Default)]
pub struct Receipt {
    last_read_micros: AtomicU64,
}

impl Receipt {
    pub fn mark_read(&self, since_start: Duration) {
        self.last_read_micros.store(since_start.as_micros().max(1) as u64, Ordering::SeqCst);
    }

    fn last_read(&self) -> Option<Duration> {
        match self.last_read_micros.load(Ordering::SeqCst) {
            0 => None,
            micros => Some(Duration::from_micros(micros)),
        }
    }
}

pub struct PasteTx {
    saved: Saved,
    #[cfg(not(target_os = "macos"))]
    published: String,
    /// macOS answers "is this still ours?" from the change count, because
    /// reading the pasteboard back would fulfil our own lazy promise from
    /// this background thread and AppKit warns that it will misbehave.
    #[cfg(target_os = "macos")]
    change_count: isize,
    receipt: Arc<Receipt>,
    started: Instant,
}

/// Publishes `text` lazily where the platform supports it, eagerly where it
/// does not, after taking a snapshot of what the user had.
pub fn begin(text: &str) -> Result<PasteTx, String> {
    let saved = clipboard::save();
    let started = Instant::now();
    let receipt = Arc::new(Receipt::default());

    #[cfg(target_os = "macos")]
    let change_count = macos::publish(text, receipt.clone(), started)?;
    #[cfg(target_os = "windows")]
    windows::publish(text, receipt.clone(), started)?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    clipboard::set_text(text)?;

    Ok(PasteTx {
        saved,
        #[cfg(not(target_os = "macos"))]
        published: text.to_string(),
        #[cfg(target_os = "macos")]
        change_count,
        receipt,
        started,
    })
}

impl PasteTx {
    /// Whether anything actually pulled the text. The promise is only read
    /// when an app really pastes, so this is direct evidence that the
    /// keystroke landed, which is the one thing posting an event cannot tell
    /// you. An app pastes within a frame or two of the chord; waiting longer
    /// than that only delays saying so.
    pub fn was_read(&self, within: Duration) -> bool {
        loop {
            if self.receipt.last_read().is_some() {
                return true;
            }
            if self.started.elapsed() >= within {
                return false;
            }
            thread::sleep(RECEIPT_POLL);
        }
    }

    /// Restores on a background thread. Called on both paths: a failed
    /// injection must put the user's clipboard back just as reliably as a
    /// successful one.
    pub fn finish(self, injected: bool) {
        thread::spawn(move || {
            let cap = if injected { CAP } else { FAILED_CAP };
            loop {
                let elapsed = self.started.elapsed();
                if elapsed >= cap {
                    break;
                }
                if let Some(read_at) = self.receipt.last_read() {
                    if elapsed.saturating_sub(read_at) >= QUIET {
                        break;
                    }
                }
                thread::sleep(POLL);
            }
            // The user's own copy always wins.
            #[cfg(target_os = "macos")]
            let ours = macos::still_ours(self.change_count);
            #[cfg(not(target_os = "macos"))]
            let ours = clipboard::current_text().as_deref() == Some(self.published.as_str());
            if !ours {
                return;
            }
            let _ = clipboard::restore(&self.saved);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_receipt_reports_the_read_it_was_given() {
        let receipt = Receipt::default();
        assert_eq!(receipt.last_read(), None);
        receipt.mark_read(Duration::from_millis(120));
        assert_eq!(receipt.last_read(), Some(Duration::from_millis(120)));
    }

    #[test]
    fn a_read_at_time_zero_still_counts_as_a_read() {
        let receipt = Receipt::default();
        receipt.mark_read(Duration::ZERO);
        assert!(receipt.last_read().is_some());
    }
}
