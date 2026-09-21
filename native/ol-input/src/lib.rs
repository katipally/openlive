//! napi surface for `ol-input`. Every export runs on the Electron main
//! thread; the hook and the insertion sessions own their own threads.

pub mod binding;
pub mod capabilities;
pub mod capture;
pub mod clipboard;
pub mod control;
pub mod coordinator;
pub mod coords;
pub mod hook;
pub mod inject;
pub mod ocr;
pub mod paste_tx;
pub mod perms;
pub mod platform;
pub mod secure_input;
pub mod window;

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use binding::Binding;
use coordinator::{Activation, Effect};
use hook::Hook;
use inject::{Method, Session};

static HOOK: Mutex<Option<Hook>> = Mutex::new(None);
static NEXT_SESSION: AtomicU32 = AtomicU32::new(1);

fn sessions() -> &'static Mutex<HashMap<u32, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u32, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn err(message: String) -> Error {
    Error::new(Status::GenericFailure, message)
}

fn locked<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| err("ol-input state is poisoned".into()))
}

#[napi(object)]
pub struct HookEffect {
    pub kind: String,
    pub binding_id: Option<String>,
}

impl From<Effect> for HookEffect {
    fn from(effect: Effect) -> Self {
        match effect {
            Effect::Start { binding_id } => HookEffect {
                kind: "start".into(),
                binding_id: Some(binding_id),
            },
            Effect::Stop { binding_id } => HookEffect {
                kind: "stop".into(),
                binding_id: Some(binding_id),
            },
            Effect::Cancel => HookEffect { kind: "cancel".into(), binding_id: None },
        }
    }
}

#[napi(object)]
pub struct BindingInfo {
    pub canonical: String,
    pub modifier_only: bool,
}

#[napi(object)]
pub struct SecureInputStatus {
    pub active: bool,
    pub culprit: Option<String>,
    pub changed: bool,
}

#[napi(object)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub post_events: bool,
    pub microphone: String,
    pub screen_recording: bool,
}

/// Idempotent. Resolving the keyboard layout needs the main thread, and this
/// is the only place that is guaranteed to be on it. Asking to post events is
/// the same kind of setup and belongs to the same explicit call: onboarding
/// drives it, and nothing else may make macOS put a prompt on screen.
#[napi]
pub fn initialize_injector() -> bool {
    inject::refresh_layout();
    perms::request_post_events()
}

/// Idempotent: a second call keeps the running hook and its callback.
/// This is what asks for Accessibility, so nothing calls it before
/// onboarding does.
#[napi(ts_args_type = "onEffect: (effect: HookEffect) => void")]
pub fn initialize_hook(on_effect: Function<HookEffect, ()>) -> Result<()> {
    let mut hook = locked(&HOOK)?;
    if hook.is_some() {
        return Ok(());
    }
    let tsfn: ThreadsafeFunction<HookEffect, (), HookEffect, Status, false> = on_effect
        .build_threadsafe_function()
        .callee_handled::<false>()
        .build_callback(|ctx| Ok(ctx.value))?;
    let sink: hook::EffectSink = Arc::new(move |effect: Effect| {
        tsfn.call(effect.into(), ThreadsafeFunctionCallMode::NonBlocking);
    });
    *hook = Some(Hook::start(sink).map_err(err)?);
    Ok(())
}

fn with_hook<T>(f: impl FnOnce(&Hook) -> std::result::Result<T, String>) -> Result<T> {
    let hook = locked(&HOOK)?;
    let hook = hook.as_ref().ok_or_else(|| err("the hook is not running".into()))?;
    f(hook).map_err(err)
}

/// Drops the hook, which joins its thread, and ends every open insertion.
#[napi]
pub fn shutdown() -> Result<()> {
    *locked(&HOOK)? = None;
    locked(sessions())?.clear();
    Ok(())
}

/// The error a hook thread died with, if it died. Null while it is healthy.
#[napi]
pub fn hook_error() -> Result<Option<String>> {
    Ok(locked(&HOOK)?.as_ref().and_then(|hook| hook.last_error()))
}

#[napi]
pub fn parse_binding(binding: String) -> Result<BindingInfo> {
    let parsed = Binding::from_str(&binding).map_err(err)?;
    Ok(BindingInfo {
        canonical: parsed.to_string(),
        modifier_only: parsed.is_modifier_only(),
    })
}

#[napi]
pub fn register_binding(
    id: String,
    binding: String,
    activation: String,
    hold_threshold_ms: u32,
) -> Result<()> {
    let parsed = Binding::from_str(&binding).map_err(err)?;
    let activation = match activation.as_str() {
        "toggle" => Activation::Toggle,
        "pushToTalk" => Activation::PushToTalk,
        "holdOrToggle" => Activation::HoldOrToggle,
        other => return Err(err(format!("unknown activation mode \"{other}\""))),
    };
    let hold = Duration::from_millis(u64::from(hold_threshold_ms));
    with_hook(|hook| hook.register(id, parsed, activation, hold))
}

#[napi]
pub fn unregister_binding(id: String) -> Result<()> {
    with_hook(|hook| hook.unregister(id))
}

#[napi]
pub fn suspend_hook() -> Result<()> {
    with_hook(|hook| hook.suspend())
}

#[napi]
pub fn resume_hook() -> Result<()> {
    with_hook(|hook| hook.resume())
}

/// Programmatic trigger, from the CLI or a menu item. Never debounced: a
/// dropped one desyncs toggle parity.
#[napi]
pub fn trigger_external(id: String, pressed: bool) -> Result<()> {
    with_hook(|hook| hook.trigger_external(id, pressed))
}

#[napi]
pub fn notify_processing_finished() -> Result<()> {
    with_hook(|hook| hook.processing_finished())
}

#[napi]
pub fn notify_start_failed() -> Result<()> {
    with_hook(|hook| hook.start_failed())
}

fn method(name: Option<String>) -> Result<Method> {
    match name.as_deref() {
        None => Ok(Method::default_for_platform()),
        Some("paste") => Ok(Method::Paste),
        Some("type") => Ok(Method::Type),
        Some(other) => Err(err(format!("unknown insertion method \"{other}\""))),
    }
}

/// Both insertion paths go out as posted events, so both refuse up front when
/// the machine would drop them rather than report characters nobody received.
fn guard_injection() -> Result<()> {
    platform::desktop::current::guard_injection().map_err(err)
}

/// The paste receipt is delivered to the main thread's run loop, so an
/// insertion that waited for it there would be waiting for itself. It runs on
/// libuv's pool for the same reason `end_insertion` does.
pub struct InsertTask(String, Method);

impl napi::Task for InsertTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        inject::insert(&self.0, self.1).map_err(err)
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn insert_text(
    text: String,
    insertion_method: Option<String>,
) -> Result<AsyncTask<InsertTask>> {
    guard_injection()?;
    inject::refresh_layout();
    Ok(AsyncTask::new(InsertTask(text, method(insertion_method)?)))
}

/// Opens a streamed insertion. Chunks pushed while a paste is still in
/// flight coalesce into the next one.
#[napi]
pub fn begin_insertion(insertion_method: Option<String>) -> Result<u32> {
    guard_injection()?;
    inject::refresh_layout();
    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    locked(sessions())?.insert(id, Session::begin(method(insertion_method)?));
    Ok(id)
}

#[napi]
pub fn push_insertion(session: u32, chunk: String) -> Result<()> {
    let sessions = locked(sessions())?;
    let open = sessions
        .get(&session)
        .ok_or_else(|| err(format!("insertion session {session} is not open")))?;
    open.push(&chunk).map_err(err)
}

/// Closing a session waits for everything pushed into it to be typed, which
/// with the typing method and a long reply is seconds of keystrokes, so it
/// waits on libuv's pool and not on the thread the whole UI lives on.
pub struct EndInsertionTask(Option<Session>);

impl napi::Task for EndInsertionTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        match self.0.take() {
            Some(session) => session.end().map_err(err),
            None => Ok(()),
        }
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn end_insertion(session: u32) -> Result<AsyncTask<EndInsertionTask>> {
    let open = locked(sessions())?
        .remove(&session)
        .ok_or_else(|| err(format!("insertion session {session} is not open")))?;
    Ok(AsyncTask::new(EndInsertionTask(Some(open))))
}

/// Poll this at 1Hz from the main thread: macOS never reports a secure-input
/// change, and the Carbon shadow registration it drives wants the main thread.
#[napi]
pub fn secure_input_status() -> SecureInputStatus {
    let status = secure_input::poll();
    SecureInputStatus {
        active: status.active,
        culprit: status.culprit,
        changed: status.changed,
    }
}

/// Null when a binding may be recorded, otherwise the reason it may not.
#[napi]
pub fn binding_recording_refusal() -> Option<String> {
    secure_input::refusal_reason()
}

#[napi]
pub fn permission_status() -> PermissionStatus {
    let status = perms::status();
    PermissionStatus {
        accessibility: status.accessibility,
        post_events: status.post_events,
        microphone: status.microphone.to_string(),
        screen_recording: status.screen_recording,
    }
}

#[napi]
pub fn request_accessibility() -> bool {
    perms::request_accessibility()
}

/// Shows the post-event prompt. Separate from Accessibility, and like it,
/// reached only from onboarding: nothing on a hot path may make macOS ask.
#[napi]
pub fn request_post_events() -> bool {
    perms::request_post_events()
}

#[napi]
pub fn request_microphone() -> String {
    perms::request_microphone().to_string()
}

#[napi]
pub fn request_screen_recording() -> bool {
    perms::request_screen_recording()
}

/// Whether anything on this machine is holding the microphone right now.
///
/// `null` means the platform would not say, which is NOT "nothing is using
/// it": auto-quiet must never silence the assistant on an unread signal.
#[napi]
pub fn microphone_in_use() -> Option<bool> {
    platform::current::microphone_in_use()
}


#[napi(object)]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub primary: bool,
}

/// The geometry a captured image is in. It travels with the image so a point
/// the model picks out of the pixels can be turned back into a screen
/// coordinate by `shotToScreen`, and never by the caller's own arithmetic.
#[napi(object)]
pub struct ShotGeometry {
    pub origin_x: f64,
    pub origin_y: f64,
    pub scale: f64,
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
pub struct CaptureResult {
    pub png: Buffer,
    pub shot: ShotGeometry,
}

#[napi(object)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[napi(object)]
pub struct WindowSummary {
    pub id: u32,
    pub app_name: String,
    pub app_id: Option<String>,
    /// Absent when the platform withholds it, never an empty string.
    pub title: Option<String>,
    pub pid: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub display_id: Option<u32>,
    pub minimized: bool,
}

#[napi(object)]
pub struct TextBoxInfo {
    pub text: String,
    pub confidence: f64,
    /// Coordinates in the image this text was read from, the same space a
    /// point picked out of the pixels is in. Click it through `shotToScreen`.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[napi(object)]
pub struct CapabilityReport {
    pub hook: bool,
    pub post_events: bool,
    pub injection: String,
    pub capture: bool,
    pub capture_backend: String,
    pub ocr: bool,
    pub ocr_engine: String,
    pub selection: bool,
    pub selection_backend: String,
    pub window_control: bool,
    pub elevated_window_injection: bool,
    pub secure_input: bool,
    pub session: Option<String>,
    pub tools: Vec<String>,
}

impl From<coords::Shot> for ShotGeometry {
    fn from(shot: coords::Shot) -> Self {
        ShotGeometry {
            origin_x: shot.origin.x,
            origin_y: shot.origin.y,
            scale: shot.scale,
            width: shot.width,
            height: shot.height,
        }
    }
}

impl From<&ShotGeometry> for coords::Shot {
    fn from(geometry: &ShotGeometry) -> Self {
        coords::Shot::new(
            coords::ScreenPoint::new(geometry.origin_x, geometry.origin_y),
            geometry.scale,
            geometry.width,
            geometry.height,
        )
    }
}

impl From<window::WindowInfo> for WindowSummary {
    fn from(window: window::WindowInfo) -> Self {
        WindowSummary {
            id: window.id,
            app_name: window.app_name,
            app_id: window.app_id,
            title: window.title,
            pid: window.pid,
            x: window.origin.x,
            y: window.origin.y,
            width: window.width,
            height: window.height,
            display_id: window.display_id,
            minimized: window.minimized,
        }
    }
}

fn screen(point: &Point) -> coords::ScreenPoint {
    coords::ScreenPoint::new(point.x, point.y)
}

enum Subject {
    Display(u32),
    Window(u32),
    Region(coords::ScreenPoint, f64, f64),
}

/// Capture runs on libuv's pool, never on the Electron main thread, for the
/// same reason the hook owns its own thread: a full-screen grab is tens of
/// milliseconds and the main thread is where the UI lives.
pub struct CaptureTask(Subject);

impl napi::Task for CaptureTask {
    type Output = capture::Capture;
    type JsValue = CaptureResult;

    fn compute(&mut self) -> Result<Self::Output> {
        match self.0 {
            Subject::Display(id) => capture::display(id),
            Subject::Window(id) => capture::window(id),
            Subject::Region(origin, width, height) => capture::region(origin, width, height),
        }
        .map_err(err)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(CaptureResult { png: output.png.into(), shot: output.shot.into() })
    }
}

pub struct OcrTask {
    png: Vec<u8>,
    shot: coords::Shot,
}

impl napi::Task for OcrTask {
    type Output = Vec<ocr::TextBox>;
    type JsValue = Vec<TextBoxInfo>;

    fn compute(&mut self) -> Result<Self::Output> {
        ocr::read(&self.png, self.shot).map_err(err)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output
            .into_iter()
            .map(|found| TextBoxInfo {
                text: found.text,
                confidence: f64::from(found.confidence),
                x: found.origin.x,
                y: found.origin.y,
                width: found.width,
                height: found.height,
            })
            .collect())
    }
}

#[napi]
pub fn displays() -> Result<Vec<DisplayInfo>> {
    Ok(capture::displays()
        .map_err(err)?
        .into_iter()
        .map(|display| DisplayInfo {
            id: display.id,
            name: display.name,
            x: display.origin.x,
            y: display.origin.y,
            width: display.width,
            height: display.height,
            scale: display.scale,
            primary: display.primary,
        })
        .collect())
}

#[napi]
pub fn capture_display(display_id: u32) -> AsyncTask<CaptureTask> {
    AsyncTask::new(CaptureTask(Subject::Display(display_id)))
}

#[napi]
pub fn capture_window(window_id: u32) -> AsyncTask<CaptureTask> {
    AsyncTask::new(CaptureTask(Subject::Window(window_id)))
}

#[napi]
pub fn capture_region(origin: Point, width: f64, height: f64) -> AsyncTask<CaptureTask> {
    AsyncTask::new(CaptureTask(Subject::Region(screen(&origin), width, height)))
}

/// The only way from a pixel in a captured image to a coordinate the control
/// calls accept. Everything they take is already screen space.
#[napi]
pub fn shot_to_screen(shot: ShotGeometry, x: f64, y: f64) -> Point {
    let point = coords::Shot::from(&shot).to_screen(coords::ShotPoint::new(x, y));
    Point { x: point.x, y: point.y }
}

#[napi]
pub fn recognize_text(png: Buffer, shot: ShotGeometry) -> AsyncTask<OcrTask> {
    AsyncTask::new(OcrTask { png: png.to_vec(), shot: coords::Shot::from(&shot) })
}

#[napi]
pub fn foreground_window() -> Result<Option<WindowSummary>> {
    Ok(window::foreground().map_err(err)?.map(WindowSummary::from))
}

#[napi]
pub fn window_list() -> Result<Vec<WindowSummary>> {
    Ok(window::list().map_err(err)?.into_iter().map(WindowSummary::from).collect())
}

#[napi]
pub fn activate_window(window_id: u32) -> Result<()> {
    window::activate(window_id).map_err(err)
}

#[napi]
pub fn move_window(window_id: u32, origin: Point) -> Result<()> {
    window::move_to(window_id, screen(&origin)).map_err(err)
}

#[napi]
pub fn resize_window(window_id: u32, width: f64, height: f64) -> Result<()> {
    window::resize(window_id, width, height).map_err(err)
}

#[napi]
pub fn minimize_window(window_id: u32) -> Result<()> {
    window::minimize(window_id).map_err(err)
}

#[napi]
pub fn close_window(window_id: u32) -> Result<()> {
    window::close(window_id).map_err(err)
}

#[napi]
pub fn open_app(name: String) -> Result<()> {
    window::open_app(&name).map_err(err)
}

#[napi]
pub fn open_url(url: String) -> Result<()> {
    window::open_url(&url).map_err(err)
}

/// Null when the app or the platform will not say, which is not the same as
/// an empty selection.
#[napi]
pub fn selected_text() -> Option<String> {
    window::selection()
}

fn button(name: Option<String>) -> Result<control::Button> {
    match name {
        None => Ok(control::Button::Left),
        Some(name) => control::Button::parse(&name).map_err(err),
    }
}

#[napi]
pub fn move_mouse(point: Point) -> Result<()> {
    control::move_to(screen(&point)).map_err(err)
}

#[napi]
pub fn click(point: Point, mouse_button: Option<String>, count: Option<u32>) -> Result<()> {
    control::click(screen(&point), button(mouse_button)?, count.unwrap_or(1)).map_err(err)
}

#[napi]
pub fn double_click(point: Point) -> Result<()> {
    control::click(screen(&point), control::Button::Left, 2).map_err(err)
}

#[napi]
pub fn right_click(point: Point) -> Result<()> {
    control::click(screen(&point), control::Button::Right, 1).map_err(err)
}

#[napi]
pub fn mouse_down(point: Point, mouse_button: Option<String>) -> Result<()> {
    control::mouse_down(screen(&point), button(mouse_button)?).map_err(err)
}

#[napi]
pub fn mouse_up(point: Point, mouse_button: Option<String>) -> Result<()> {
    control::mouse_up(screen(&point), button(mouse_button)?).map_err(err)
}

/// The whole path, not just its ends: a drag that teleports is ignored by
/// every canvas and most drop targets.
#[napi]
pub fn drag(path: Vec<Point>, mouse_button: Option<String>) -> Result<()> {
    let path: Vec<coords::ScreenPoint> = path.iter().map(screen).collect();
    control::drag(&path, button(mouse_button)?).map_err(err)
}

#[napi]
pub fn scroll(point: Point, horizontal: i32, vertical: i32) -> Result<()> {
    control::scroll(screen(&point), horizontal, vertical).map_err(err)
}

#[napi]
pub fn type_text(text: String) -> Result<()> {
    inject::refresh_layout();
    control::type_text(&text).map_err(err)
}

/// A chord, as `["ctrl", "c"]`. The modifiers stay down across the key.
#[napi]
pub fn keypress(keys: Vec<String>) -> Result<()> {
    inject::refresh_layout();
    control::keypress(&keys).map_err(err)
}

/// What this machine can do right now. Cheap: only the parts that cannot
/// change while the app runs are cached.
#[napi]
pub fn capabilities() -> CapabilityReport {
    let found = capabilities::probe();
    CapabilityReport {
        hook: found.hook,
        post_events: found.post_events,
        injection: found.injection.into(),
        capture: found.capture,
        capture_backend: found.capture_backend.into(),
        ocr: found.ocr,
        ocr_engine: found.ocr_engine.into(),
        selection: found.selection,
        selection_backend: found.selection_backend.into(),
        window_control: found.window_control,
        elevated_window_injection: found.elevated_window_injection,
        secure_input: found.secure_input,
        session: found.session.map(str::to_string),
        tools: found.tools,
    }
}
