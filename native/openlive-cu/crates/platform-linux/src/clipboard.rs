//! The clipboard, for `pasteText`.
//!
//! X11 has no clipboard store: the app that copied owns the CLIPBOARD
//! selection and hands its content to whoever asks, for as long as it runs.
//! So the helper owns it too, from a thread with its own connection that
//! answers paste requests: the text to paste first, then the user's own text
//! again once the paste is done, until someone copies something else. A
//! clipboard manager (GNOME's and KDE's both run one) keeps that after the
//! helper exits. Only text is put back; an image on the clipboard is not.
//!
//! On Wayland only the focused client may set the clipboard, so the helper
//! goes through wl-clipboard (`wl-copy`, `wl-paste`) when it is installed;
//! it borrows focus for the moment it takes. Without it, text is typed.
//!
//! Putting the user's text back after a paste, and clearing what the helper
//! put there when there was nothing to put back, follow Orca's Linux runtime
//! (MIT, Copyright (c) 2026 Lovecast Inc.; see THIRD_PARTY_NOTICES).

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};
use x11rb::connection::{Connection, RequestConnection as _};
use x11rb::protocol::xproto::{
    AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, PropMode, SelectionNotifyEvent, SelectionRequestEvent, WindowClass,
    SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::CURRENT_TIME;

x11rb::atom_manager! {
    Atoms: AtomsCookie {
        CLIPBOARD,
        TARGETS,
        UTF8_STRING,
        INCR,
        TEXT_PLAIN_UTF8: b"text/plain;charset=utf-8",
        TEXT_PLAIN: b"text/plain",
        OPENLIVE_CLIPBOARD,
    }
}

/// How long the owner of the clipboard gets to answer a read.
const READ_TIMEOUT: Duration = Duration::from_millis(500);
/// How often the owning thread looks for requests while it holds the clipboard.
const SERVE_TICK: Duration = Duration::from_millis(10);

/// What was on the clipboard before a paste.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Previous {
    Empty,
    Text(String),
    /// Something that is not text (an image, files), or an owner that did not answer.
    Unreadable,
}

enum Cmd {
    Read(Sender<Previous>),
    Own(Vec<u8>, Sender<bool>),
    /// Put the user's clipboard back unless someone copied since the paste.
    Restore(Previous, Sender<bool>),
}

pub struct XClipboard {
    tx: Sender<Cmd>,
}

impl XClipboard {
    pub fn start() -> Result<XClipboard, String> {
        let (conn, screen) = RustConnection::connect(None).map_err(|e| e.to_string())?;
        let root = conn.setup().roots[screen].root;
        let atoms = Atoms::new(&conn).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
        let win = conn.generate_id().map_err(|e| e.to_string())?;
        conn.create_window(0, win, root, 0, 0, 1, 1, 0, WindowClass::INPUT_ONLY, 0, &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE))
            .map_err(|e| e.to_string())?;
        conn.flush().map_err(|e| e.to_string())?;
        let (tx, rx) = channel();
        thread::Builder::new().name("openlive-cu clipboard".into()).spawn(move || Owner { conn, win, atoms, content: None }.run(rx)).map_err(|e| e.to_string())?;
        Ok(XClipboard { tx })
    }

    fn ask<T>(&self, make: impl FnOnce(Sender<T>) -> Cmd) -> Option<T> {
        let (tx, rx) = channel();
        self.tx.send(make(tx)).ok()?;
        rx.recv_timeout(READ_TIMEOUT * 4).ok()
    }

    pub fn read(&self) -> Previous {
        self.ask(Cmd::Read).unwrap_or(Previous::Unreadable)
    }

    pub fn own(&self, text: &str) -> bool {
        self.ask(|tx| Cmd::Own(text.as_bytes().to_vec(), tx)).unwrap_or(false)
    }

    pub fn restore(&self, previous: Previous) -> bool {
        self.ask(|tx| Cmd::Restore(previous, tx)).unwrap_or(false)
    }
}

struct Owner {
    conn: RustConnection,
    win: u32,
    atoms: Atoms,
    /// What the helper serves while it owns CLIPBOARD.
    content: Option<Vec<u8>>,
}

impl Owner {
    fn run(mut self, rx: Receiver<Cmd>) {
        loop {
            let wait = if self.content.is_some() { SERVE_TICK } else { Duration::from_secs(1) };
            match rx.recv_timeout(wait) {
                Ok(cmd) => self.command(cmd),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            while let Ok(Some(event)) = self.conn.poll_for_event() {
                self.event(event);
            }
        }
    }

    fn command(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Read(tx) => {
                let _ = tx.send(self.read());
            }
            Cmd::Own(bytes, tx) => {
                let _ = tx.send(self.own(bytes));
            }
            Cmd::Restore(previous, tx) => {
                // Someone copied in the meantime: theirs stays.
                let still_ours = self.content.is_some() && self.owner() == Some(self.win);
                let done = still_ours && match previous {
                    Previous::Text(t) => self.own(t.into_bytes()),
                    Previous::Empty | Previous::Unreadable => {
                        self.content = None;
                        let _ = self.conn.set_selection_owner(x11rb::NONE, self.atoms.CLIPBOARD, CURRENT_TIME);
                        self.conn.flush().is_ok()
                    }
                };
                let _ = tx.send(done);
            }
        }
    }

    fn owner(&self) -> Option<u32> {
        self.conn.get_selection_owner(self.atoms.CLIPBOARD).ok()?.reply().ok().map(|r| r.owner)
    }

    fn own(&mut self, bytes: Vec<u8>) -> bool {
        self.content = Some(bytes);
        let _ = self.conn.set_selection_owner(self.win, self.atoms.CLIPBOARD, CURRENT_TIME);
        let _ = self.conn.flush();
        let ours = self.owner() == Some(self.win);
        if !ours {
            self.content = None;
        }
        ours
    }

    /// The clipboard's text, asked of its owner. Events that arrive meanwhile are served.
    fn read(&mut self) -> Previous {
        match self.owner() {
            None | Some(0) => return Previous::Empty,
            Some(w) if w == self.win => return self.content.clone().map_or(Previous::Empty, |b| Previous::Text(String::from_utf8_lossy(&b).into_owned())),
            Some(_) => {}
        }
        let a = self.atoms;
        if self.conn.convert_selection(self.win, a.CLIPBOARD, a.UTF8_STRING, a.OPENLIVE_CLIPBOARD, CURRENT_TIME).is_err() || self.conn.flush().is_err() {
            return Previous::Unreadable;
        }
        let deadline = Instant::now() + READ_TIMEOUT;
        while Instant::now() < deadline {
            match self.conn.poll_for_event() {
                Ok(Some(Event::SelectionNotify(n))) if n.requestor == self.win && n.selection == a.CLIPBOARD => {
                    if n.property == x11rb::NONE {
                        return Previous::Unreadable;
                    }
                    let Some(reply) = self.conn.get_property(true, self.win, a.OPENLIVE_CLIPBOARD, AtomEnum::ANY, 0, u32::MAX / 4).ok().and_then(|c| c.reply().ok()) else {
                        return Previous::Unreadable;
                    };
                    // A transfer in pieces (INCR) is for content too big to be worth restoring as text.
                    return if reply.type_ == a.INCR { Previous::Unreadable } else { Previous::Text(String::from_utf8_lossy(&reply.value).into_owned()) };
                }
                Ok(Some(other)) => self.event(other),
                Ok(None) => thread::sleep(Duration::from_millis(5)),
                Err(_) => return Previous::Unreadable,
            }
        }
        Previous::Unreadable
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::SelectionClear(c) if c.selection == self.atoms.CLIPBOARD => self.content = None,
            Event::SelectionRequest(r) => self.answer(r),
            _ => {}
        }
    }

    /// Hand the text to a requestor in the target it asked for, or refuse.
    fn answer(&mut self, r: SelectionRequestEvent) {
        let a = self.atoms;
        // An obsolete client names no property: the target doubles as one.
        let property = if r.property == x11rb::NONE { r.target } else { r.property };
        let text_targets = [a.UTF8_STRING, a.TEXT_PLAIN_UTF8, a.TEXT_PLAIN, AtomEnum::STRING.into()];
        let fits = |n: usize| n + 64 <= self.conn.maximum_request_bytes();
        let done = match &self.content {
            Some(_) if r.selection == a.CLIPBOARD && r.target == a.TARGETS => {
                let targets = [a.TARGETS, a.UTF8_STRING, a.TEXT_PLAIN_UTF8, a.TEXT_PLAIN, AtomEnum::STRING.into()];
                self.conn.change_property32(PropMode::REPLACE, r.requestor, property, AtomEnum::ATOM, &targets).is_ok()
            }
            Some(bytes) if r.selection == a.CLIPBOARD && text_targets.contains(&r.target) && fits(bytes.len()) => {
                self.conn.change_property8(PropMode::REPLACE, r.requestor, property, r.target, bytes).is_ok()
            }
            _ => false,
        };
        let notify = SelectionNotifyEvent {
            response_type: SELECTION_NOTIFY_EVENT,
            sequence: 0,
            time: r.time,
            requestor: r.requestor,
            selection: r.selection,
            target: r.target,
            property: if done { property } else { x11rb::NONE },
        };
        let _ = self.conn.send_event(false, r.requestor, EventMask::NO_EVENT, notify);
        let _ = self.conn.flush();
    }
}

// ── Wayland, through wl-clipboard ───────────────────────────────────────────

fn found(tool: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|d| d.join(tool).is_file()))
}

pub fn wl_clipboard() -> bool {
    found("wl-copy") && found("wl-paste")
}

/// Run a tool for at most two seconds. Its output is read only when wanted,
/// on a thread so a big clipboard cannot fill the pipe and stall it: `wl-copy`
/// leaves a server behind that would hold a piped stdout open.
fn run(cmd: &mut Command, input: Option<&[u8]>, output: bool) -> Option<Vec<u8>> {
    let stdout = if output { Stdio::piped() } else { Stdio::null() };
    let mut child = cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(stdout).stderr(Stdio::null()).spawn().ok()?;
    if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(bytes).ok()?;
    }
    let reader = child.stdout.take().map(|mut pipe| thread::spawn(move || {
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut pipe, &mut out).map(|_| out)
    }));
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    match reader {
        Some(r) => r.join().ok()?.ok(),
        None => Some(Vec::new()),
    }
}

pub fn wl_read() -> Previous {
    let Some(types) = run(Command::new("wl-paste").arg("--list-types"), None, true) else { return Previous::Empty };
    let types = String::from_utf8_lossy(&types);
    if types.trim().is_empty() {
        return Previous::Empty;
    }
    if !types.lines().any(|t| t.starts_with("text/plain") || t == "UTF8_STRING" || t == "TEXT" || t == "STRING") {
        return Previous::Unreadable;
    }
    run(Command::new("wl-paste").args(["--no-newline", "--type", "text"]), None, true).map_or(Previous::Unreadable, |b| Previous::Text(String::from_utf8_lossy(&b).into_owned()))
}

/// `wl-copy` forks a server that keeps serving the text until something else is copied.
pub fn wl_write(text: &str) -> bool {
    run(Command::new("wl-copy").args(["--type", "text/plain;charset=utf-8"]), Some(text.as_bytes()), false).is_some()
}

pub fn wl_restore(previous: Previous) -> bool {
    match previous {
        Previous::Text(t) => wl_write(&t),
        Previous::Empty | Previous::Unreadable => run(Command::new("wl-copy").arg("--clear"), None, false).is_some(),
    }
}
