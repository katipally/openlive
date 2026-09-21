//! macOS Secure Event Input. While it is on, a CGEventTap stops seeing
//! KeyDown and KeyUp while FlagsChanged keeps flowing, so modifier-only
//! bindings survive and keyed ones die silently. Keyed bindings are
//! shadow-registered through Carbon, which is unaffected.

#[derive(Debug, Clone, Default)]
pub struct Status {
    pub active: bool,
    pub culprit: Option<String>,
    /// True on the poll that saw the state flip, so the UI can react once.
    pub changed: bool,
}

/// A binding cannot be recorded while secure input is on: the recorder would
/// only ever capture the modifier and the user would save a broken binding.
pub fn refusal_reason() -> Option<String> {
    let status = current();
    if !status.active {
        return None;
    }
    Some(match status.culprit {
        Some(app) => format!(
            "{app} has secure input enabled, so keystrokes cannot be recorded. \
             Leave its password field and try again."
        ),
        None => "Secure input is enabled by another app, so keystrokes cannot be recorded."
            .to_string(),
    })
}

#[cfg(not(target_os = "macos"))]
pub use stub::*;

#[cfg(not(target_os = "macos"))]
mod stub {
    use super::Status;
    use crate::binding::Binding;
    use std::sync::mpsc::Sender;

    pub fn current() -> Status {
        Status::default()
    }

    pub fn poll() -> Status {
        Status::default()
    }

    pub fn set_shadow_bindings(_bindings: Vec<(String, Binding)>) {}

    pub fn set_carbon_sender(_sender: Sender<(String, bool)>) {}
}

#[cfg(target_os = "macos")]
pub use imp::*;

#[cfg(target_os = "macos")]
mod imp {
    use super::Status;
    use crate::binding::Binding;
    use crate::platform::macos::*;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::mpsc::Sender;
    use std::sync::Mutex;

    const SIGNATURE: u32 = u32::from_be_bytes(*b"OLFL");

    struct Shadow {
        handle: EventHotKeyRef,
    }

    // SAFETY: EventHotKeyRef is an opaque Carbon handle; only this module
    // touches it, and always under REGISTRY's lock.
    unsafe impl Send for Shadow {}

    #[derive(Default)]
    struct Registry {
        bindings: Vec<(String, Binding)>,
        shadows: HashMap<u32, Shadow>,
        by_carbon_id: HashMap<u32, String>,
        sender: Option<Sender<(String, bool)>>,
        active: bool,
        handler_installed: bool,
    }

    static REGISTRY: Mutex<Option<Registry>> = Mutex::new(None);

    fn with_registry<T>(f: impl FnOnce(&mut Registry) -> T) -> Option<T> {
        let mut guard = REGISTRY.lock().ok()?;
        Some(f(guard.get_or_insert_with(Registry::default)))
    }

    pub fn current() -> Status {
        let active = secure_input_active();
        Status {
            active,
            culprit: if active { frontmost_app_name() } else { None },
            changed: false,
        }
    }

    /// Call from the main thread, roughly once a second: macOS never reports
    /// a secure-input change, and Carbon registration wants the main thread.
    pub fn poll() -> Status {
        let mut status = current();
        let changed = with_registry(|registry| {
            let changed = registry.active != status.active;
            registry.active = status.active;
            if changed {
                if status.active {
                    register_shadows(registry);
                } else {
                    registry.shadows.clear();
                    registry.by_carbon_id.clear();
                }
            }
            changed
        });
        status.changed = changed.unwrap_or(false);
        status
    }

    pub fn set_shadow_bindings(bindings: Vec<(String, Binding)>) {
        with_registry(|registry| {
            registry.bindings = bindings;
            if registry.active {
                registry.shadows.clear();
                registry.by_carbon_id.clear();
                register_shadows(registry);
            }
        });
    }

    pub fn set_carbon_sender(sender: Sender<(String, bool)>) {
        with_registry(|registry| registry.sender = Some(sender));
    }

    fn register_shadows(registry: &mut Registry) {
        if !registry.handler_installed {
            install_handler();
            registry.handler_installed = true;
        }
        // Modifier-only bindings keep working through the event tap, so only
        // keyed ones need a shadow.
        let keyed: Vec<(String, Binding)> = registry
            .bindings
            .iter()
            .filter(|(_, binding)| !binding.is_modifier_only())
            .cloned()
            .collect();
        for (index, (id, binding)) in keyed.into_iter().enumerate() {
            let Some(key) = binding.key else { continue };
            let Some(keycode) = virtual_keycode(key) else { continue };
            let carbon_id = index as u32 + 1;
            let mut handle: EventHotKeyRef = ptr::null_mut();
            let status = unsafe {
                RegisterEventHotKey(
                    keycode as u32,
                    carbon_modifiers(binding.modifiers),
                    EventHotKeyID { signature: SIGNATURE, id: carbon_id },
                    GetApplicationEventTarget(),
                    K_HOTKEY_NO_OPTIONS,
                    &mut handle,
                )
            };
            if status == 0 && !handle.is_null() {
                registry.by_carbon_id.insert(carbon_id, id);
                registry.shadows.insert(carbon_id, Shadow { handle });
            }
        }
    }

    impl Drop for Shadow {
        fn drop(&mut self) {
            unsafe { UnregisterEventHotKey(self.handle) };
        }
    }

    extern "C" fn carbon_handler(
        _call: *mut c_void,
        event: *mut c_void,
        _user_data: *mut c_void,
    ) -> i32 {
        let mut hotkey = EventHotKeyID { signature: 0, id: 0 };
        let status = unsafe {
            GetEventParameter(
                event,
                K_EVENT_PARAM_DIRECT_OBJECT,
                K_EVENT_PARAM_TYPE_HOTKEY_ID,
                ptr::null_mut(),
                std::mem::size_of::<EventHotKeyID>(),
                ptr::null_mut(),
                &mut hotkey as *mut _ as *mut c_void,
            )
        };
        if status != 0 || hotkey.signature != SIGNATURE {
            return -9874; // eventNotHandledErr
        }
        let pressed = unsafe { GetEventKind(event) } == K_EVENT_HOTKEY_PRESSED;
        with_registry(|registry| {
            if let (Some(id), Some(sender)) =
                (registry.by_carbon_id.get(&hotkey.id), registry.sender.as_ref())
            {
                let _ = sender.send((id.clone(), pressed));
            }
        });
        0
    }

    fn install_handler() {
        let types = [
            EventTypeSpec {
                event_class: K_EVENT_CLASS_KEYBOARD,
                event_kind: K_EVENT_HOTKEY_PRESSED,
            },
            EventTypeSpec {
                event_class: K_EVENT_CLASS_KEYBOARD,
                event_kind: K_EVENT_HOTKEY_RELEASED,
            },
        ];
        let mut handler = ptr::null_mut();
        unsafe {
            InstallEventHandler(
                GetApplicationEventTarget(),
                carbon_handler,
                types.len() as u32,
                types.as_ptr(),
                ptr::null_mut(),
                &mut handler,
            );
        }
    }
}
