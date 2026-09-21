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
    pub microphone: String,
    pub screen_recording: bool,
}

/// Idempotent. Resolving the keyboard layout needs the main thread, and this
/// is the only place that is guaranteed to be on it.
#[napi]
pub fn initialize_injector() {
    inject::refresh_layout();
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

#[napi]
pub fn insert_text(text: String, insertion_method: Option<String>) -> Result<()> {
    inject::refresh_layout();
    inject::insert(&text, method(insertion_method)?).map_err(err)
}

/// Opens a streamed insertion. Chunks pushed while a paste is still in
/// flight coalesce into the next one.
#[napi]
pub fn begin_insertion(insertion_method: Option<String>) -> Result<u32> {
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

#[napi]
pub fn end_insertion(session: u32) -> Result<()> {
    let open = locked(sessions())?
        .remove(&session)
        .ok_or_else(|| err(format!("insertion session {session} is not open")))?;
    open.end().map_err(err)
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
        microphone: status.microphone.to_string(),
        screen_recording: status.screen_recording,
    }
}

#[napi]
pub fn request_accessibility() -> bool {
    perms::request_accessibility()
}

#[napi]
pub fn request_microphone() -> String {
    perms::request_microphone().to_string()
}

#[napi]
pub fn request_screen_recording() -> bool {
    perms::request_screen_recording()
}

