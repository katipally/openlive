//! One frame from a portal screen-cast stream, through libpipewire loaded at
//! run time.
//!
//! The pipewire crate links libpipewire when the helper is built, so a
//! machine without it could not start the helper at all, X11 or not. Loading
//! it with dlopen keeps it optional: without it, Wayland pictures say what to
//! install and everything else works. The part of the C API used here (a
//! thread loop, a context on the portal's fd, one input stream) has been
//! stable since PipeWire 0.3; the structs below mirror its headers.

use crate::geom;
use crate::spa;
use ::image::RgbaImage;
use libloading::Library;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::os::fd::{IntoRawFd, OwnedFd};
use std::ptr::{null, null_mut};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const LIBRARY: &str = "libpipewire-0.3.so.0";
const DIRECTION_INPUT: u32 = 0;
const FLAG_AUTOCONNECT: u32 = 1 << 0;
const FLAG_MAP_BUFFERS: u32 = 1 << 2;
const STATE_ERROR: c_int = -1;
const DATA_DMABUF: u32 = 3;
const CHUNK_CORRUPTED: i32 = 1;
const EVENTS_VERSION: u32 = 2;
/// How long the compositor gets to deliver a frame.
const FRAME_TIMEOUT: Duration = Duration::from_secs(3);

#[repr(C)]
struct SpaHook {
    link: [*mut c_void; 2],
    funcs: *const c_void,
    data: *mut c_void,
    removed: *mut c_void,
    private: *mut c_void,
}

type Cb0 = unsafe extern "C" fn(*mut c_void);

#[repr(C)]
struct StreamEvents {
    version: u32,
    destroy: Option<Cb0>,
    state_changed: Option<unsafe extern "C" fn(*mut c_void, c_int, c_int, *const c_char)>,
    control_info: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    io_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32)>,
    param_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    add_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
    remove_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
    process: Option<Cb0>,
    drained: Option<Cb0>,
    command: Option<unsafe extern "C" fn(*mut c_void, *const c_void)>,
    trigger_done: Option<Cb0>,
}

#[repr(C)]
struct PwBuffer {
    buffer: *mut SpaBuffer,
}

#[repr(C)]
struct SpaBuffer {
    n_metas: u32,
    n_datas: u32,
    metas: *mut c_void,
    datas: *mut SpaData,
}

#[repr(C)]
struct SpaData {
    kind: u32,
    flags: u32,
    fd: i64,
    mapoffset: u32,
    maxsize: u32,
    data: *mut c_void,
    chunk: *mut SpaChunk,
}

#[repr(C)]
struct SpaChunk {
    offset: u32,
    size: u32,
    stride: i32,
    flags: i32,
}

type Opaque = *mut c_void;

struct Pw {
    _lib: Library,
    thread_loop_new: unsafe extern "C" fn(*const c_char, *const c_void) -> Opaque,
    thread_loop_get_loop: unsafe extern "C" fn(Opaque) -> Opaque,
    thread_loop_start: unsafe extern "C" fn(Opaque) -> c_int,
    thread_loop_stop: unsafe extern "C" fn(Opaque),
    thread_loop_destroy: unsafe extern "C" fn(Opaque),
    thread_loop_lock: unsafe extern "C" fn(Opaque),
    thread_loop_unlock: unsafe extern "C" fn(Opaque),
    thread_loop_timed_wait: unsafe extern "C" fn(Opaque, c_int) -> c_int,
    thread_loop_signal: unsafe extern "C" fn(Opaque, bool),
    context_new: unsafe extern "C" fn(Opaque, Opaque, usize) -> Opaque,
    context_destroy: unsafe extern "C" fn(Opaque),
    context_connect_fd: unsafe extern "C" fn(Opaque, c_int, Opaque, usize) -> Opaque,
    core_disconnect: unsafe extern "C" fn(Opaque) -> c_int,
    properties_new_string: unsafe extern "C" fn(*const c_char) -> Opaque,
    stream_new: unsafe extern "C" fn(Opaque, *const c_char, Opaque) -> Opaque,
    stream_destroy: unsafe extern "C" fn(Opaque),
    stream_add_listener: unsafe extern "C" fn(Opaque, *mut SpaHook, *const StreamEvents, *mut c_void),
    stream_connect: unsafe extern "C" fn(Opaque, u32, u32, u32, *const *const c_void, u32) -> c_int,
    stream_disconnect: unsafe extern "C" fn(Opaque) -> c_int,
    stream_dequeue_buffer: unsafe extern "C" fn(Opaque) -> *mut PwBuffer,
    stream_queue_buffer: unsafe extern "C" fn(Opaque, *mut PwBuffer) -> c_int,
}

fn load() -> Result<Pw, String> {
    // SAFETY: loading a system library whose initialisers are safe to run, and
    // reading symbols whose C signatures the types above transcribe.
    unsafe {
        let lib = Library::new(LIBRARY).map_err(|e| format!("{LIBRARY} could not be loaded ({e})"))?;
        macro_rules! sym {
            ($name:literal) => {
                *lib.get($name).map_err(|e| format!("{LIBRARY} lacks {}: {e}", String::from_utf8_lossy(&$name[..$name.len() - 1])))?
            };
        }
        let init: unsafe extern "C" fn(*mut c_int, *mut *mut *mut c_char) = sym!(b"pw_init\0");
        init(null_mut(), null_mut());
        Ok(Pw {
            thread_loop_new: sym!(b"pw_thread_loop_new\0"),
            thread_loop_get_loop: sym!(b"pw_thread_loop_get_loop\0"),
            thread_loop_start: sym!(b"pw_thread_loop_start\0"),
            thread_loop_stop: sym!(b"pw_thread_loop_stop\0"),
            thread_loop_destroy: sym!(b"pw_thread_loop_destroy\0"),
            thread_loop_lock: sym!(b"pw_thread_loop_lock\0"),
            thread_loop_unlock: sym!(b"pw_thread_loop_unlock\0"),
            thread_loop_timed_wait: sym!(b"pw_thread_loop_timed_wait\0"),
            thread_loop_signal: sym!(b"pw_thread_loop_signal\0"),
            context_new: sym!(b"pw_context_new\0"),
            context_destroy: sym!(b"pw_context_destroy\0"),
            context_connect_fd: sym!(b"pw_context_connect_fd\0"),
            core_disconnect: sym!(b"pw_core_disconnect\0"),
            properties_new_string: sym!(b"pw_properties_new_string\0"),
            stream_new: sym!(b"pw_stream_new\0"),
            stream_destroy: sym!(b"pw_stream_destroy\0"),
            stream_add_listener: sym!(b"pw_stream_add_listener\0"),
            stream_connect: sym!(b"pw_stream_connect\0"),
            stream_disconnect: sym!(b"pw_stream_disconnect\0"),
            stream_dequeue_buffer: sym!(b"pw_stream_dequeue_buffer\0"),
            stream_queue_buffer: sym!(b"pw_stream_queue_buffer\0"),
            _lib: lib,
        })
    }
}

fn pw() -> Result<&'static Pw, String> {
    static PW: OnceLock<Result<Pw, String>> = OnceLock::new();
    PW.get_or_init(load).as_ref().map_err(|e| format!("{e}. Install PipeWire (the pipewire or libpipewire-0.3-0 package) to give OpenLive pictures of windows on Wayland."))
}

pub fn available() -> bool {
    pw().is_ok()
}

/// What the callbacks share with the waiting thread. Touched only under the thread loop's lock.
struct Shared {
    pw: &'static Pw,
    thread_loop: Opaque,
    stream: Opaque,
    format: Option<spa::VideoFormat>,
    frame: Option<Result<RgbaImage, String>>,
}

unsafe extern "C" fn on_state(data: *mut c_void, _old: c_int, state: c_int, error: *const c_char) {
    // SAFETY: `data` is the `Shared` registered with the listener, alive until the stream is destroyed.
    let s = unsafe { &mut *(data as *mut Shared) };
    if state == STATE_ERROR && s.frame.is_none() {
        let why = if error.is_null() { "unknown error".into() } else { unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned() };
        s.frame = Some(Err(format!("the screen-cast stream failed: {why}")));
        unsafe { (s.pw.thread_loop_signal)(s.thread_loop, false) };
    }
}

unsafe extern "C" fn on_param(data: *mut c_void, id: u32, param: *const c_void) {
    if id != spa::PARAM_FORMAT || param.is_null() {
        return;
    }
    // SAFETY: as in `on_state`; a pod is a size word, a type word and that many body bytes.
    let s = unsafe { &mut *(data as *mut Shared) };
    let size = unsafe { *(param as *const u32) } as usize;
    let bytes = unsafe { std::slice::from_raw_parts(param as *const u8, 8 + size) };
    s.format = spa::parse_format(bytes);
}

unsafe extern "C" fn on_process(data: *mut c_void) {
    // SAFETY: as in `on_state`. Buffers come from the stream and go back to it
    // before this returns; their memory is mapped (MAP_BUFFERS) for that long.
    let s = unsafe { &mut *(data as *mut Shared) };
    let pw = s.pw;
    let b = unsafe { (pw.stream_dequeue_buffer)(s.stream) };
    if b.is_null() {
        return;
    }
    if s.frame.is_none() {
        if let Some(read) = unsafe { read_frame(&*(*b).buffer, s.format) } {
            s.frame = Some(read);
            unsafe { (pw.thread_loop_signal)(s.thread_loop, false) };
        }
    }
    unsafe { (pw.stream_queue_buffer)(s.stream, b) };
}

/// The picture in a buffer, or `None` to wait for the next (an empty or damaged one).
unsafe fn read_frame(buffer: &SpaBuffer, format: Option<spa::VideoFormat>) -> Option<Result<RgbaImage, String>> {
    if buffer.n_datas == 0 || buffer.datas.is_null() {
        return None;
    }
    // SAFETY: n_datas > 0, so the first data and its chunk are valid while the buffer is dequeued.
    let d = unsafe { &*buffer.datas };
    if d.chunk.is_null() {
        return None;
    }
    let chunk = unsafe { &*d.chunk };
    if chunk.size == 0 || chunk.flags & CHUNK_CORRUPTED != 0 {
        return None;
    }
    let Some(f) = format else { return Some(Err("the screen-cast stream never said its format".into())) };
    if d.data.is_null() {
        let why = if d.kind == DATA_DMABUF { "the compositor sent GPU buffers only" } else { "the frame was not readable" };
        return Some(Err(why.into()));
    }
    let Some(order) = spa::pixel_order(f.format) else { return Some(Err(format!("the stream settled on video format {}, which is not 32-bit RGB", f.format))) };
    let offset = (chunk.offset % d.maxsize.max(1)) as usize;
    let len = (chunk.size as usize).min((d.maxsize as usize).saturating_sub(offset));
    // SAFETY: the mapped region is `maxsize` bytes; offset and length stay inside it.
    let bytes = unsafe { std::slice::from_raw_parts((d.data as *const u8).add(offset), len) };
    Some(geom::to_rgba(bytes, f.width, f.height, chunk.stride.max(0) as usize, order).ok_or_else(|| "the frame was smaller than its format says".into()))
}

/// One frame from stream `node` on the PipeWire remote the portal opened.
pub fn frame(remote: OwnedFd, node: u32) -> Result<RgbaImage, String> {
    let pw = pw()?;
    // SAFETY: the calls follow PipeWire's documented thread-loop pattern: the
    // loop is started, every call on its objects is made with its lock held,
    // and everything is torn down in reverse order before `shared`, `hook` and
    // `events` (which the stream points at) are dropped.
    unsafe {
        let thread_loop = (pw.thread_loop_new)(c"openlive-cu-capture".as_ptr(), null());
        if thread_loop.is_null() {
            return Err("PipeWire could not start a loop".into());
        }
        let context = (pw.context_new)((pw.thread_loop_get_loop)(thread_loop), null_mut(), 0);
        if context.is_null() || (pw.thread_loop_start)(thread_loop) < 0 {
            if !context.is_null() {
                (pw.context_destroy)(context);
            }
            (pw.thread_loop_destroy)(thread_loop);
            return Err("PipeWire could not start".into());
        }
        (pw.thread_loop_lock)(thread_loop);
        // The fd is the context's from here on, closed with the core.
        let core = (pw.context_connect_fd)(context, remote.into_raw_fd(), null_mut(), 0);
        // Owned through a raw pointer from here: the stream's callbacks reach it the same way.
        let shared = Box::into_raw(Box::new(Shared { pw, thread_loop, stream: null_mut(), format: None, frame: None }));
        let mut hook = Box::new(SpaHook { link: [null_mut(); 2], funcs: null(), data: null_mut(), removed: null_mut(), private: null_mut() });
        let events = Box::new(StreamEvents {
            version: EVENTS_VERSION,
            destroy: None,
            state_changed: Some(on_state),
            control_info: None,
            io_changed: None,
            param_changed: Some(on_param),
            add_buffer: None,
            remove_buffer: None,
            process: Some(on_process),
            drained: None,
            command: None,
            trigger_done: None,
        });
        let result = if core.is_null() {
            Err("PipeWire refused the portal's connection".to_owned())
        } else {
            let props = (pw.properties_new_string)(c"media.type=Video media.category=Capture media.role=Screen".as_ptr());
            let stream = (pw.stream_new)(core, c"openlive-cu".as_ptr(), props);
            if stream.is_null() {
                Err("PipeWire could not create a stream".to_owned())
            } else {
                (*shared).stream = stream;
                (pw.stream_add_listener)(stream, &mut *hook, &*events, shared as *mut c_void);
                // SPA reads pods as 32-bit words: give it an 8-byte aligned copy.
                let pod = spa::enum_format();
                let mut aligned = vec![0u64; pod.len().div_ceil(8)];
                std::ptr::copy_nonoverlapping(pod.as_ptr(), aligned.as_mut_ptr() as *mut u8, pod.len());
                let params = [aligned.as_ptr() as *const c_void];
                let got = if (pw.stream_connect)(stream, DIRECTION_INPUT, node, FLAG_AUTOCONNECT | FLAG_MAP_BUFFERS, params.as_ptr(), 1) < 0 {
                    Err("PipeWire would not connect to the screen-cast stream".to_owned())
                } else {
                    let deadline = Instant::now() + FRAME_TIMEOUT;
                    while (*shared).frame.is_none() && Instant::now() < deadline {
                        (pw.thread_loop_timed_wait)(thread_loop, 1);
                    }
                    (*shared).frame.take().unwrap_or_else(|| Err("the compositor sent no frame in time".into()))
                };
                (pw.stream_disconnect)(stream);
                (pw.stream_destroy)(stream);
                got
            }
        };
        if !core.is_null() {
            (pw.core_disconnect)(core);
        }
        (pw.thread_loop_unlock)(thread_loop);
        (pw.thread_loop_stop)(thread_loop);
        (pw.context_destroy)(context);
        (pw.thread_loop_destroy)(thread_loop);
        drop((Box::from_raw(shared), hook, events));
        result
    }
}
