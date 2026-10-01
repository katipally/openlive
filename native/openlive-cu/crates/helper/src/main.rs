//! `openlive-cu --socket <path> --token-file <path>`
//!
//! One helper per OpenLive server. It listens on a local socket (a Unix socket
//! on macOS and Linux, a named pipe on Windows) in a directory only this user
//! can open, serves the one client holding the token, and exits when that
//! client hangs up or asks it to, or when nobody claims it in time.

use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
use openlive_cu_core::auth::take_token;
use openlive_cu_core::serve::{Ended, Server};
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[cfg(target_os = "macos")]
mod disclaim;

/// A helper nobody connects to within this long was orphaned at birth.
const UNCLAIMED_DEADLINE: Duration = Duration::from_secs(30);

static CLAIMED: AtomicBool = AtomicBool::new(false);

fn main() {
    #[cfg(target_os = "macos")]
    disclaim::become_responsible();

    let (socket, token_file) = match args() {
        Ok(a) => a,
        Err(why) => fail(&why),
    };
    let token = take_token(&token_file).unwrap_or_else(|e| fail(&format!("token file: {e}")));
    let listener = socket
        .as_os_str()
        .to_fs_name::<GenericFilePath>()
        .and_then(|name| private(ListenerOptions::new().name(name)).create_sync())
        .unwrap_or_else(|e| fail(&format!("listen on {}: {e}", socket.display())));

    std::thread::spawn(|| {
        std::thread::sleep(UNCLAIMED_DEADLINE);
        if !CLAIMED.load(Ordering::SeqCst) {
            std::process::exit(3);
        }
    });

    let serve = move || {
        let mut server = Server::new(backend(), token);
        server.on_owner = || CLAIMED.store(true, Ordering::SeqCst);
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            match server.serve(&mut BufReader::new(&conn), &mut &conn) {
                Ok(Ended::Stranger) => continue,
                Ok(Ended::OwnerLeft | Ended::Terminate) => std::process::exit(0),
                // A broken pipe from the owner is the owner leaving.
                Err(_) if CLAIMED.load(Ordering::SeqCst) => std::process::exit(0),
                Err(_) => continue,
            }
        }
    };

    // AppKit keeps the list of running apps current only while the main run
    // loop turns, so on macOS requests are served off the main thread.
    #[cfg(target_os = "macos")]
    {
        std::thread::spawn(serve);
        openlive_cu_macos::run_main_loop();
    }
    #[cfg(not(target_os = "macos"))]
    serve();
}

#[cfg(target_os = "macos")]
fn backend() -> openlive_cu_macos::MacBackend {
    openlive_cu_macos::MacBackend::new()
}
#[cfg(target_os = "windows")]
fn backend() -> openlive_cu_windows::WindowsBackend {
    openlive_cu_windows::WindowsBackend::new()
}

/// A Unix socket is private by the 0700 directory it sits in.
#[cfg(not(windows))]
fn private(opts: ListenerOptions<'_>) -> ListenerOptions<'_> {
    opts
}

/// A named pipe lives in a global namespace with a default descriptor that lets
/// Everyone read it, so it gets a DACL naming this user alone (see pipe.rs).
/// Without one the helper does not listen at all.
#[cfg(windows)]
fn private(opts: ListenerOptions<'_>) -> ListenerOptions<'_> {
    use interprocess::os::windows::{local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor};
    use openlive_cu_windows::pipe;
    let sd = pipe::current_user_sid()
        .and_then(|sid| pipe::sddl(&sid).ok_or_else(|| std::io::Error::other(format!("not a SID: {sid}"))))
        .and_then(|sddl| widestring::U16CString::from_str(sddl).map_err(std::io::Error::other))
        .and_then(|wide| SecurityDescriptor::deserialize(&wide))
        .unwrap_or_else(|e| fail(&format!("pipe security: {e}")));
    opts.security_descriptor(sd)
}
#[cfg(target_os = "linux")]
fn backend() -> openlive_cu_linux::LinuxBackend {
    openlive_cu_linux::LinuxBackend::new()
}

fn args() -> Result<(PathBuf, PathBuf), String> {
    let (mut socket, mut token) = (None, None);
    let mut it = std::env::args_os().skip(1);
    while let Some(flag) = it.next() {
        let value = it.next().map(PathBuf::from);
        match flag.to_str() {
            Some("--socket") => socket = value,
            Some("--token-file") => token = value,
            _ => return Err(format!("unknown argument {flag:?}")),
        }
    }
    match (socket, token) {
        (Some(s), Some(t)) => Ok((s, t)),
        _ => Err("usage: openlive-cu --socket <path> --token-file <path>".into()),
    }
}

fn fail(why: &str) -> ! {
    eprintln!("openlive-cu: {why}");
    std::process::exit(2);
}
