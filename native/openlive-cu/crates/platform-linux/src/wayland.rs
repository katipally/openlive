//! The xdg-desktop-portal session behind pictures and posted input on
//! Wayland, where no client may read the screen or inject input on its own.
//!
//! One RemoteDesktop session holds the keyboard, the pointer and a screen
//! cast of every monitor (see portal.rs for the bookkeeping). The consent
//! dialog shows only when the user asks for it in OpenLive's Access settings;
//! after that a stored restore token brings a new session back without one.
//! Input goes through the portal's `Notify*` calls: a keysym is turned into a
//! key press by the compositor on the layout in use, so typing needs no
//! keymap here (libei through `ConnectToEIS` would hand over keycodes and
//! leave the layout to the helper, which would then need libxkbcommon).
//! A session idle for two minutes is closed, so the compositor's
//! screen-sharing indicator does not stay on; the next use restores it quietly.
//! A portal that hands out no restore token keeps its session open instead.

use crate::bus::{block, within};
use crate::geom::{self, Stream};
use crate::pipewire;
use crate::portal::{self, Kind, Phase, Stored};
use ::image::RgbaImage;
use futures_lite::StreamExt;
use openlive_cu_core::protocol::Rect;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use zbus::proxy::CacheProperties;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::Connection;

const DESKTOP: &str = "org.freedesktop.portal.Desktop";
const DESKTOP_PATH: &str = "/org/freedesktop/portal/desktop";
const REMOTE_DESKTOP: &str = "org.freedesktop.portal.RemoteDesktop";
const SCREEN_CAST: &str = "org.freedesktop.portal.ScreenCast";
const SESSION: &str = "org.freedesktop.portal.Session";
/// How long the user has to answer the consent dialog.
const ASK_TIMEOUT: Duration = Duration::from_secs(300);
/// How long a caller waits for a session to come up before it is told to try again.
const WAIT_FOR_SESSION: Duration = Duration::from_secs(8);
const IDLE_CLOSE: Duration = Duration::from_secs(120);
/// A quiet restore that failed is not tried again sooner than this, so a
/// broken portal costs one wait, not one per request.
const RETRY_RESTORE: Duration = Duration::from_secs(30);

static NEXT_TOKEN: AtomicU32 = AtomicU32::new(0);

type Results = HashMap<String, OwnedValue>;

struct Session {
    conn: Connection,
    handle: OwnedObjectPath,
    streams: Vec<Stream>,
    input: bool,
    /// The portal gave a restore token, so closing an idle session costs no dialog later.
    restorable: bool,
    closing: Arc<AtomicBool>,
}

struct Inner {
    phase: Phase,
    session: Option<Session>,
    last_used: Instant,
    tried: Option<Instant>,
}

pub struct Portal {
    inner: Arc<(Mutex<Inner>, Condvar)>,
    token_file: Option<PathBuf>,
}

fn token_file() -> Option<PathBuf> {
    portal::token_path(std::env::var("XDG_STATE_HOME").ok().as_deref(), std::env::var("HOME").ok().as_deref())
}

fn read_token(file: &Option<PathBuf>) -> Option<Stored> {
    file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| Stored::parse(&t))
}

fn write_token(file: &Option<PathBuf>, stored: Option<&Stored>) {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let Some(f) = file else { return };
    match stored {
        None => {
            let _ = std::fs::remove_file(f);
        }
        Some(s) => {
            if let Some(dir) = f.parent() {
                let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir);
            }
            let tmp = f.with_extension("tmp");
            let written = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)
                .and_then(|mut file| std::io::Write::write_all(&mut file, s.format().as_bytes()));
            if written.is_ok() {
                let _ = std::fs::rename(&tmp, f);
            }
        }
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

async fn version(conn: &Connection, iface: &str) -> Option<u32> {
    crate::bus::get::<u32>(conn, DESKTOP, DESKTOP_PATH, iface, "version").await.ok()
}

/// One portal request: subscribe to its Response, make the call, wait for the answer.
async fn request(conn: &Connection, iface: &str, method: &str, session: Option<&ObjectPath<'_>>, mut options: HashMap<&str, Value<'_>>, limit: Duration) -> Result<Results, String> {
    let token = format!("openlive{}", NEXT_TOKEN.fetch_add(1, Ordering::Relaxed));
    let unique = conn.unique_name().ok_or("no unique name on the session bus")?.to_string();
    let path = portal::request_path(&unique, &token);
    let proxy: zbus::Proxy = zbus::proxy::Builder::new(conn)
        .destination(DESKTOP).map_err(err)?
        .path(path.as_str()).map_err(err)?
        .interface("org.freedesktop.portal.Request").map_err(err)?
        .cache_properties(CacheProperties::No)
        .build().await.map_err(err)?;
    let mut answers = proxy.receive_signal("Response").await.map_err(err)?;
    options.insert("handle_token", Value::from(token.as_str()));
    let sent = match (session, method) {
        (None, _) => conn.call_method(Some(DESKTOP), DESKTOP_PATH, Some(iface), method, &(options,)).await,
        (Some(s), "Start") => conn.call_method(Some(DESKTOP), DESKTOP_PATH, Some(iface), method, &(s, "", options)).await,
        (Some(s), _) => conn.call_method(Some(DESKTOP), DESKTOP_PATH, Some(iface), method, &(s, options)).await,
    };
    sent.map_err(|e| format!("{iface}.{method}: {e}"))?;
    let answer = within(limit, async { answers.next().await.ok_or_else(|| "the portal went away".to_owned()) }).await?;
    let (code, results): (u32, Results) = answer.body().deserialize().map_err(err)?;
    portal::response(code)?;
    Ok(results)
}

fn streams_of(results: &Results) -> Vec<Stream> {
    let Some(v) = results.get("streams") else { return Vec::new() };
    let Ok(list) = <Vec<(u32, HashMap<String, OwnedValue>)>>::try_from(v.try_clone().unwrap_or_else(|_| OwnedValue::from(0u32))) else { return Vec::new() };
    list.into_iter().map(|(node, props)| {
        let pair = |k: &str| props.get(k).and_then(|v| <(i32, i32)>::try_from(v.try_clone().ok()?).ok());
        portal::stream(node, pair("position"), pair("size"))
    }).collect()
}

/// Bring up a session: the consent dialog when `ask`, a quiet restore from
/// `stored` otherwise. Returns the session and the token for the next one.
async fn open(stored: Option<Stored>, ask: bool) -> Result<(Session, Option<Stored>), String> {
    let conn = Connection::session().await.map_err(err)?;
    let rd = version(&conn, REMOTE_DESKTOP).await;
    let sc = version(&conn, SCREEN_CAST).await.ok_or("this desktop has no screen-cast portal (xdg-desktop-portal with a GNOME, KDE or wlroots backend)")?;
    let kind = if rd.is_some() { Kind::RemoteDesktop } else { Kind::ScreenCast };
    let restore = stored.filter(|s| s.kind == kind).map(|s| s.token);
    if restore.is_none() && !ask {
        return Err("no stored approval to restore".into());
    }
    let limit = if ask { ASK_TIMEOUT } else { ASK_TIMEOUT / 10 };
    let iface = if kind == Kind::RemoteDesktop { REMOTE_DESKTOP } else { SCREEN_CAST };
    let created = request(&conn, iface, "CreateSession", None, HashMap::from([("session_handle_token", Value::from("openlive"))]), limit).await?;
    let handle: String = created.get("session_handle").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).ok_or("the portal returned no session")?;
    let handle = OwnedObjectPath::try_from(handle).map_err(err)?;
    let persist = |opts: &mut HashMap<&str, Value<'_>>| {
        opts.insert("persist_mode", Value::from(portal::PERSIST_UNTIL_REVOKED));
        if let Some(t) = &restore {
            opts.insert("restore_token", Value::from(t.clone()));
        }
    };
    if kind == Kind::RemoteDesktop {
        let mut opts = HashMap::from([("types", Value::from(portal::KEYBOARD | portal::POINTER))]);
        // Persistence arrived in version 2 of the interface; earlier ones ask every time.
        if rd.unwrap_or(0) >= 2 {
            persist(&mut opts);
        }
        request(&conn, REMOTE_DESKTOP, "SelectDevices", Some(&handle), opts, limit).await?;
    }
    let mut sources = HashMap::from([
        ("types", Value::from(portal::MONITOR)),
        ("multiple", Value::from(true)),
        ("cursor_mode", Value::from(portal::CURSOR_HIDDEN)),
    ]);
    if kind == Kind::ScreenCast && sc >= 4 {
        persist(&mut sources);
    }
    request(&conn, SCREEN_CAST, "SelectSources", Some(&handle), sources, limit).await?;
    let started = request(&conn, iface, "Start", Some(&handle), HashMap::new(), limit).await?;
    let devices = started.get("devices").and_then(|v| u32::try_from(v).ok()).unwrap_or(0);
    let token = started.get("restore_token").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).map(|token| Stored { kind, token });
    let streams = streams_of(&started);
    if streams.is_empty() {
        return Err("the screen sharing session shares no screen".into());
    }
    let input = kind == Kind::RemoteDesktop && devices & (portal::KEYBOARD | portal::POINTER) == portal::KEYBOARD | portal::POINTER;
    let restorable = token.is_some();
    Ok((Session { conn, handle, streams, input, restorable, closing: Arc::new(AtomicBool::new(false)) }, token))
}

impl Portal {
    pub fn new() -> Portal {
        let inner = Arc::new((Mutex::new(Inner { phase: Phase::Idle, session: None, last_used: Instant::now(), tried: None }), Condvar::new()));
        let reaper = Arc::downgrade(&inner);
        thread::Builder::new().name("openlive-cu portal idle".into()).spawn(move || loop {
            thread::sleep(Duration::from_secs(5));
            let Some(inner) = reaper.upgrade() else { return };
            let mut g = inner.0.lock().unwrap_or_else(|p| p.into_inner());
            // A session the portal cannot restore stays open: closing it would mean another dialog.
            if g.session.as_ref().is_some_and(|s| s.restorable) && g.last_used.elapsed() > IDLE_CLOSE {
                if let Some(s) = g.session.take() {
                    close(&s);
                }
                g.phase = Phase::Idle;
            }
        }).ok();
        Portal { inner, token_file: token_file() }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn stored(&self) -> bool {
        read_token(&self.token_file).is_some()
    }

    pub fn phase(&self) -> Phase {
        self.lock().phase.clone()
    }

    /// Start a session in the background: with the dialog when `ask`, from
    /// the stored token otherwise. Returns at once; `phase` tells how it went.
    fn begin(&self, ask: bool) {
        {
            let mut g = self.lock();
            if matches!(g.phase, Phase::Asking | Phase::Active { .. }) {
                return;
            }
            g.phase = Phase::Asking;
            g.tried = Some(Instant::now());
        }
        let inner = self.inner.clone();
        let file = self.token_file.clone();
        thread::Builder::new().name("openlive-cu portal".into()).spawn(move || {
            let opened = block(open(read_token(&file), ask));
            let (lock, ready) = &*inner;
            let mut g = lock.lock().unwrap_or_else(|p| p.into_inner());
            match opened {
                Ok((session, token)) => {
                    if token.is_some() {
                        write_token(&file, token.as_ref());
                    }
                    watch(&session, file.clone(), Arc::downgrade(&inner));
                    g.phase = Phase::Active { input: session.input };
                    g.session = Some(session);
                    g.last_used = Instant::now();
                }
                Err(why) => {
                    // A declined dialog or a token the portal no longer honours: the approval is gone.
                    if why.contains("declined") {
                        write_token(&file, None);
                    }
                    g.phase = Phase::Failed(why);
                }
            }
            ready.notify_all();
        }).ok();
    }

    /// The user asked: show the consent dialog (or restore quietly when an approval is kept).
    pub fn ask(&self) {
        self.begin(true);
    }

    /// A session to work with: the running one, or one restored from the
    /// stored token, waited for briefly. Never shows a dialog unasked.
    fn session<T>(&self, f: impl FnOnce(&Session) -> T) -> Result<T, String> {
        let restore = {
            let g = self.lock();
            g.phase.may_restore(self.stored()) && g.tried.is_none_or(|t| t.elapsed() > RETRY_RESTORE)
        };
        if restore {
            self.begin(false);
        }
        let deadline = Instant::now() + WAIT_FOR_SESSION;
        let mut g = self.lock();
        while g.phase == Phase::Asking && Instant::now() < deadline {
            g = self.inner.1.wait_timeout(g, deadline - Instant::now()).map(|(g, _)| g).unwrap_or_else(|p| p.into_inner().0);
        }
        g.last_used = Instant::now();
        match (&g.phase, &g.session) {
            (Phase::Active { .. }, Some(s)) => Ok(f(s)),
            (Phase::Asking, _) => Err("the screen sharing approval is still waiting for the user to answer; try again once they have".into()),
            (Phase::Failed(why), _) if !self.stored() => Err(format!("screen sharing is not set up on Wayland ({why}). Ask the user to allow Computer use: Screen in OpenLive's Flow settings under Access")),
            _ => Err("screen sharing is not set up on Wayland. Ask the user to allow Computer use: Screen in OpenLive's Flow settings under Access; the system asks once".into()),
        }
    }

    /// The desktop the shared monitors cover, in logical coordinates, when a session is running.
    pub fn desktop(&self) -> Option<Rect> {
        let g = self.lock();
        let areas: Vec<Rect> = g.session.as_ref()?.streams.iter().filter_map(|s| s.area).collect();
        geom::union(&areas)
    }

    /// Warm a session from the stored token so the frame a picture is taken
    /// in is known before the picture; quiet, and only when a token is kept.
    pub fn restore_quietly(&self) {
        let _ = self.session(|_| ());
    }

    /// A picture of `target` (logical desktop coordinates) from the monitors it lies on.
    pub fn capture(&self, target: Rect) -> Result<RgbaImage, String> {
        let (conn, handle, streams) = self.session(|s| (s.conn.clone(), s.handle.clone(), s.streams.clone()))?;
        let mut pictures = Vec::new();
        for s in streams.iter().filter(|s| s.area.is_none_or(|a| geom::intersect(&a, &target).is_some())) {
            let fd: zbus::zvariant::OwnedFd = block(crate::bus::call(&conn, DESKTOP, DESKTOP_PATH, SCREEN_CAST, "OpenPipeWireRemote", &(&handle, HashMap::<&str, Value>::new())))?;
            let img = pipewire::frame(fd.into(), s.node)?;
            let area = s.area.unwrap_or(Rect { x: 0.0, y: 0.0, width: f64::from(img.width()), height: f64::from(img.height()) });
            pictures.push((area, img));
        }
        let sources: Vec<(Rect, &RgbaImage)> = pictures.iter().map(|(a, i)| (*a, i)).collect();
        geom::compose(&sources, target).ok_or_else(|| "the window is on no shared screen".into())
    }

    fn notify(&self, method: &str, body: impl FnOnce(&Session) -> Result<(), String>) -> Result<(), String> {
        self.session(|s| {
            if !s.input {
                return Err(format!("this desktop shares the screen with OpenLive but not the keyboard and pointer ({method} is unavailable): its portal has no remote desktop support, or the user left input out when approving"));
            }
            body(s)
        })?
    }

    pub fn pointer_to(&self, x: f64, y: f64) -> Result<(), String> {
        self.notify("pointer", |s| {
            let (node, sx, sy) = geom::stream_at(&s.streams, x, y).ok_or_else(|| format!("({x:.0}, {y:.0}) is on no shared screen"))?;
            block(rd(s, "NotifyPointerMotionAbsolute", &(&s.handle, opts(), node, sx, sy)))
        })
    }

    pub fn button(&self, evdev: i32, down: bool) -> Result<(), String> {
        self.notify("pointer", |s| block(rd(s, "NotifyPointerButton", &(&s.handle, opts(), evdev, u32::from(down)))))
    }

    /// Wheel notches: axis 0 is vertical, 1 horizontal; positive steps go down or right.
    pub fn axis(&self, axis: u32, steps: i32) -> Result<(), String> {
        self.notify("pointer", |s| block(rd(s, "NotifyPointerAxisDiscrete", &(&s.handle, opts(), axis, steps))))
    }

    pub fn keysym(&self, keysym: u32, down: bool) -> Result<(), String> {
        self.notify("keyboard", |s| block(rd(s, "NotifyKeyboardKeysym", &(&s.handle, opts(), keysym as i32, u32::from(down)))))
    }

    /// Whether posted input is possible now (a session with devices), without starting one.
    pub fn has_input(&self) -> bool {
        matches!(self.lock().phase, Phase::Active { input: true })
    }
}

fn opts() -> HashMap<&'static str, Value<'static>> {
    HashMap::new()
}

async fn rd<B: serde::Serialize + zbus::zvariant::DynamicType>(s: &Session, method: &str, body: &B) -> Result<(), String> {
    crate::bus::call::<_, ()>(&s.conn, DESKTOP, DESKTOP_PATH, REMOTE_DESKTOP, method, body).await
}

fn close(s: &Session) {
    s.closing.store(true, Ordering::SeqCst);
    let _ = block(crate::bus::call::<_, ()>(&s.conn, DESKTOP, s.handle.as_str(), SESSION, "Close", &()));
}

/// When the compositor ends the session (the user pressed Stop on the
/// screen-sharing indicator, or revoked it in Settings), forget the token: a
/// session the user stopped is not brought back without asking.
fn watch(s: &Session, file: Option<PathBuf>, inner: std::sync::Weak<(Mutex<Inner>, Condvar)>) {
    let (conn, handle, closing) = (s.conn.clone(), s.handle.clone(), s.closing.clone());
    thread::Builder::new().name("openlive-cu portal watch".into()).spawn(move || {
        let closed = block(async {
            let proxy: zbus::Proxy = zbus::proxy::Builder::new(&conn).destination(DESKTOP).ok()?.path(handle.as_str()).ok()?.interface(SESSION).ok()?
                .cache_properties(CacheProperties::No).build().await.ok()?;
            proxy.receive_signal("Closed").await.ok()?.next().await
        });
        if closed.is_some() && !closing.load(Ordering::SeqCst) {
            write_token(&file, None);
            if let Some(inner) = inner.upgrade() {
                let mut g = inner.0.lock().unwrap_or_else(|p| p.into_inner());
                if g.session.as_ref().is_some_and(|s| s.handle == handle) {
                    g.session = None;
                    g.phase = Phase::Failed("the user stopped screen sharing".into());
                }
            }
        }
    }).ok();
}
