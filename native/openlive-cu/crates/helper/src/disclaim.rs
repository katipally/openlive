//! Make this process its own TCC "responsible process".
//!
//! macOS charges Accessibility and Screen Recording to the app that spawned a
//! process, so a helper started by OpenLive's server would borrow OpenLive's
//! grants instead of holding its own. Re-spawning ourselves with responsibility
//! disclaimed makes the child answer to its own signature: the grant attaches to
//! "OpenLive Computer Use", survives OpenLive updates, and is what System
//! Settings lists. Chromium, LLDB and Qt Creator use the same private call for
//! the same reason. Where the call is missing, the helper runs in place.
//!
//! This process stays as a thin parent: it forwards termination signals to the
//! child and exits with the child's status, so the client still owns one pid.
//!
//! Only a helper inside its app bundle disclaims, and `OPENLIVE_CU_DISCLAIM=0`
//! turns it off. A process responsible for itself needs its own grant for every
//! protected folder it touches, its own executable included: a dev build under
//! ~/Desktop or ~/Documents would stall at launch on a folder prompt. Dev runs
//! with it off, so the grants are whatever launched OpenLive.

use std::ffi::{c_char, c_int, CString};
use std::os::unix::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::{Duration, Instant};

const SWITCH: &str = "OPENLIVE_CU_DISCLAIM";

type SetDisclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;

static CHILD: AtomicI32 = AtomicI32::new(0);
static TERMINATING: AtomicBool = AtomicBool::new(false);
/// A child still alive this long after being told to stop is killed: it may be
/// wedged before its own handlers run, and nothing else knows its pid.
const KILL_AFTER: Duration = Duration::from_secs(2);

extern "C" fn forward(sig: c_int) {
    TERMINATING.store(true, Ordering::SeqCst);
    let pid = CHILD.load(Ordering::SeqCst);
    if pid > 0 {
        // SAFETY: kill is async-signal-safe and pid is our own child.
        unsafe { libc::kill(pid, sig) };
    }
}

/// Returns in the process that should do the work. Never returns in the parent.
pub fn become_responsible() {
    if std::env::var_os(SWITCH).is_some_and(|v| v == "0") {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    if !exe.to_string_lossy().contains(".app/Contents/MacOS/") {
        return;
    }
    // SAFETY: dlsym with a NUL-terminated name; a null result means the symbol is absent.
    let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_spawnattrs_setdisclaim".as_ptr()) };
    if sym.is_null() {
        return;
    }
    // SAFETY: the symbol has had this signature since macOS 10.14.
    let set_disclaim: SetDisclaim = unsafe { std::mem::transmute(sym) };
    let Ok(path) = CString::new(exe.as_os_str().as_bytes()) else { return };
    let args: Vec<CString> = std::env::args_os().filter_map(|a| CString::new(a.as_bytes()).ok()).collect();
    // The child runs with the switch off, so it does not disclaim again.
    let env: Vec<CString> = std::env::vars_os()
        .filter(|(k, _)| k != SWITCH)
        .chain(std::iter::once((SWITCH.into(), "0".into())))
        .filter_map(|(k, v)| CString::new([k.as_bytes(), b"=", v.as_bytes()].concat()).ok())
        .collect();
    let argv: Vec<*mut c_char> = args.iter().map(|a| a.as_ptr().cast_mut()).chain(std::iter::once(std::ptr::null_mut())).collect();
    let envp: Vec<*mut c_char> = env.iter().map(|e| e.as_ptr().cast_mut()).chain(std::iter::once(std::ptr::null_mut())).collect();

    // SAFETY: plain posix_spawn with initialised attributes and NUL-terminated
    // argv/envp that outlive the call.
    let pid = unsafe {
        let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
        if libc::posix_spawnattr_init(&mut attr) != 0 {
            return;
        }
        let mut pid: libc::pid_t = 0;
        let ok = set_disclaim(&mut attr, 1) == 0
            && libc::posix_spawn(&mut pid, path.as_ptr(), std::ptr::null(), &attr, argv.as_ptr(), envp.as_ptr()) == 0;
        libc::posix_spawnattr_destroy(&mut attr);
        if !ok {
            return;
        }
        pid
    };

    CHILD.store(pid, Ordering::SeqCst);
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: installing a handler that only calls kill.
        unsafe { libc::signal(sig, forward as *const () as libc::sighandler_t) };
    }
    let mut status: c_int = 0;
    let mut told: Option<Instant> = None;
    loop {
        // SAFETY: polling our own child.
        let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if r == pid {
            break;
        }
        if r < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            std::process::exit(1);
        }
        if TERMINATING.load(Ordering::SeqCst) {
            let since = *told.get_or_insert_with(Instant::now);
            if since.elapsed() > KILL_AFTER {
                // SAFETY: our own child, not yet reaped.
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if libc::WIFSIGNALED(status) {
        std::process::exit(128 + libc::WTERMSIG(status));
    }
    std::process::exit(libc::WEXITSTATUS(status));
}
