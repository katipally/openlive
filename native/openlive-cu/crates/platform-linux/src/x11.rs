//! X11: the window list from EWMH, pixels from the root window, focus through
//! `_NET_ACTIVE_WINDOW`, and posted input through XTEST, all over x11rb's
//! pure-Rust connection, so the helper links no X library.

use crate::codes::{self, Keymap, Level};
use crate::ewmh;
use crate::geom::{self, PixelOrder};
use ::image::RgbaImage;
use openlive_cu_core::protocol::Rect;
use openlive_cu_core::{CuError, ErrorCode};
use std::thread::sleep;
use std::time::Duration;
use x11rb::connection::{Connection, RequestConnection as _};
use x11rb::protocol::xproto::{
    self, AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, EventMask, ImageFormat, ImageOrder, InputFocus, KeyButMask,
    MapState, StackMode, Window,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::CURRENT_TIME;

x11rb::atom_manager! {
    pub Atoms: AtomsCookie {
        _NET_CLIENT_LIST_STACKING,
        _NET_CLIENT_LIST,
        _NET_ACTIVE_WINDOW,
        _NET_SUPPORTING_WM_CHECK,
        _NET_WM_PID,
        _NET_WM_NAME,
        _NET_FRAME_EXTENTS,
        _GTK_FRAME_EXTENTS,
        _NET_WM_WINDOW_TYPE,
        _NET_WM_WINDOW_TYPE_DOCK,
        _NET_WM_WINDOW_TYPE_DESKTOP,
        _NET_WM_STATE,
        _NET_WM_STATE_HIDDEN,
        UTF8_STRING,
    }
}

/// Between the parts of a click: the other backends' pause, which apps keep up with.
const PAUSE: Duration = Duration::from_millis(50);
/// Keystrokes per burst of typed text, with a breath between bursts so a busy app drops nothing.
const TEXT_CHUNK: usize = 16;
/// Time for clients to take in a remapped key before it is pressed.
const REMAP_SETTLE: Duration = Duration::from_millis(40);
const DRAG_STEPS: u32 = 10;

/// One top-level window, as the window manager lists it.
#[derive(Debug, Clone)]
pub struct XWindow {
    pub id: u32,
    pub pid: Option<i32>,
    pub title: Option<String>,
    /// `WM_CLASS` instance and class.
    pub class: Option<(String, String)>,
    /// What the user sees: decorations in, client-side shadows out.
    pub frame: Rect,
    pub hidden: bool,
}

pub struct X11 {
    conn: RustConnection,
    root: Window,
    atoms: Atoms,
    screen: Rect,
    xtest: bool,
}

fn x(e: impl std::fmt::Display) -> CuError {
    CuError::internal(format!("X11: {e}"))
}

impl X11 {
    pub fn connect() -> Result<X11, CuError> {
        let (conn, screen_num) = RustConnection::connect(None).map_err(|e| CuError::new(
            ErrorCode::UnsupportedPlatform,
            format!("cannot reach the X display ({e}); OpenLive Computer Use needs to run inside the user's desktop session"),
        ))?;
        let s = &conn.setup().roots[screen_num];
        let (root, screen) = (s.root, Rect { x: 0.0, y: 0.0, width: f64::from(s.width_in_pixels), height: f64::from(s.height_in_pixels) });
        let atoms = Atoms::new(&conn).map_err(x)?.reply().map_err(x)?;
        let xtest = conn.extension_information(x11rb::protocol::xtest::X11_EXTENSION_NAME).ok().flatten().is_some();
        Ok(X11 { conn, root, atoms, screen, xtest })
    }

    fn property(&self, win: Window, atom: u32, kind: impl Into<u32>) -> Option<xproto::GetPropertyReply> {
        let reply = self.conn.get_property(false, win, atom, kind, 0, 1 << 16).ok()?.reply().ok()?;
        (reply.type_ != u32::from(AtomEnum::NONE)).then_some(reply)
    }

    fn words(&self, win: Window, atom: u32, kind: impl Into<u32>) -> Option<Vec<u32>> {
        self.property(win, atom, kind).and_then(|r| r.value32().map(Iterator::collect))
    }

    pub fn active(&self) -> Option<u32> {
        self.words(self.root, self.atoms._NET_ACTIVE_WINDOW, AtomEnum::WINDOW).and_then(|w| w.first().copied()).filter(|w| *w != 0)
    }

    /// A window manager is running (one that speaks EWMH).
    fn managed(&self) -> bool {
        self.words(self.root, self.atoms._NET_SUPPORTING_WM_CHECK, AtomEnum::WINDOW).is_some_and(|w| !w.is_empty())
    }

    /// Top-level windows, front to back. Without a window manager (a bare
    /// Xvfb, a kiosk) the root's mapped children stand in, in stacking order.
    /// A handful of round trips per window. O(n).
    pub fn windows(&self) -> Vec<XWindow> {
        let a = &self.atoms;
        let mut ids = self.words(self.root, a._NET_CLIENT_LIST_STACKING, AtomEnum::WINDOW)
            .or_else(|| self.words(self.root, a._NET_CLIENT_LIST, AtomEnum::WINDOW))
            .unwrap_or_else(|| self.bare_windows());
        ids.reverse();
        let skip = [a._NET_WM_WINDOW_TYPE_DOCK, a._NET_WM_WINDOW_TYPE_DESKTOP];
        ids.into_iter().filter_map(|id| {
            if self.words(id, a._NET_WM_WINDOW_TYPE, AtomEnum::ATOM).is_some_and(|t| t.iter().any(|t| skip.contains(t))) {
                return None;
            }
            let geometry = self.conn.get_geometry(id).ok()?.reply().ok()?;
            let origin = self.conn.translate_coordinates(id, self.root, 0, 0).ok()?.reply().ok()?;
            let client = Rect { x: f64::from(origin.dst_x), y: f64::from(origin.dst_y), width: f64::from(geometry.width), height: f64::from(geometry.height) };
            let ext = |atom| self.words(id, atom, AtomEnum::CARDINAL).and_then(|w| ewmh::extents(&w)).unwrap_or_default();
            let frame = ewmh::visible_frame(client, ext(a._NET_FRAME_EXTENTS), ext(a._GTK_FRAME_EXTENTS));
            if frame.width < 2.0 || frame.height < 2.0 {
                return None;
            }
            let title = self.property(id, a._NET_WM_NAME, a.UTF8_STRING).and_then(|r| ewmh::text(&r.value))
                .or_else(|| self.property(id, AtomEnum::WM_NAME.into(), AtomEnum::ANY).and_then(|r| ewmh::text(&r.value)));
            Some(XWindow {
                id,
                pid: self.words(id, a._NET_WM_PID, AtomEnum::CARDINAL).and_then(|w| w.first().copied()).and_then(|p| i32::try_from(p).ok()).filter(|p| *p > 0),
                title,
                class: self.property(id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING).and_then(|r| ewmh::wm_class(&r.value)),
                frame,
                hidden: self.words(id, a._NET_WM_STATE, AtomEnum::ATOM).is_some_and(|s| s.contains(&a._NET_WM_STATE_HIDDEN)),
            })
        }).collect()
    }

    /// The root's mapped, managed-looking children, bottom to top.
    fn bare_windows(&self) -> Vec<u32> {
        let Some(tree) = self.conn.query_tree(self.root).ok().and_then(|c| c.reply().ok()) else { return Vec::new() };
        tree.children.into_iter().filter(|w| {
            let viewable = self.conn.get_window_attributes(*w).ok().and_then(|c| c.reply().ok()).is_some_and(|a| a.map_state == MapState::VIEWABLE && !a.override_redirect);
            viewable && self.property(*w, AtomEnum::WM_CLASS.into(), AtomEnum::STRING).is_some()
        }).collect()
    }

    /// The pixels of `frame` as the screen shows them, whatever is on top.
    /// Parts off the screen come back black, so the picture covers the frame exactly.
    pub fn capture(&self, frame: Rect) -> Result<RgbaImage, String> {
        let visible = geom::intersect(&frame, &self.screen).ok_or("the window is off the screen")?;
        let (vx, vy, vw, vh) = (visible.x.round() as i16, visible.y.round() as i16, visible.width.round() as u16, visible.height.round() as u16);
        let reply = self.conn.get_image(ImageFormat::Z_PIXMAP, self.root, vx, vy, vw, vh, !0).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
        let setup = self.conn.setup();
        let bpp = setup.pixmap_formats.iter().find(|f| f.depth == reply.depth).map(|f| f.bits_per_pixel);
        if bpp != Some(32) {
            return Err(format!("the X screen uses {}-bit pixels; only 24- and 32-bit colour can be captured", bpp.unwrap_or(reply.depth)));
        }
        let order = if setup.image_byte_order == ImageOrder::LSB_FIRST { PixelOrder::Bgrx } else { PixelOrder::Xrgb };
        let img = geom::to_rgba(&reply.data, u32::from(vw), u32::from(vh), usize::from(vw) * 4, order).ok_or("the X server sent a short image")?;
        geom::compose(&[(Rect { x: f64::from(vx), y: f64::from(vy), width: f64::from(vw), height: f64::from(vh) }, &img)], frame).ok_or_else(|| "nothing of the window is on screen".into())
    }

    /// Ask the window manager to activate the window (`_NET_ACTIVE_WINDOW`,
    /// source 2, as a pager does), which also raises and restores it. With no
    /// window manager, the core protocol's raise and focus.
    pub fn activate(&self, id: u32) {
        if self.managed() {
            let event = ClientMessageEvent::new(32, id, self.atoms._NET_ACTIVE_WINDOW, [2, CURRENT_TIME, 0, 0, 0]);
            let _ = self.conn.send_event(false, self.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event);
        } else {
            let _ = self.conn.configure_window(id, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
            let _ = self.conn.set_input_focus(InputFocus::PARENT, id, CURRENT_TIME);
        }
        let _ = self.conn.flush();
    }

    /// Which window has the keyboard: the active one, or without a window manager the focus itself.
    pub fn focused(&self) -> Option<u32> {
        if self.managed() {
            return self.active();
        }
        self.conn.get_input_focus().ok()?.reply().ok().map(|f| f.focus).filter(|f| *f > 1)
    }

    // ── XTEST ───────────────────────────────────────────────────────────────

    fn require_xtest(&self) -> Result<(), CuError> {
        if self.xtest {
            return Ok(());
        }
        Err(CuError::new(ErrorCode::PermissionDenied, "this X server has no XTEST extension, so input cannot be posted to it; the element actions still work"))
    }

    fn fake(&self, kind: u8, detail: u8, at: (i16, i16)) -> Result<(), CuError> {
        self.conn.xtest_fake_input(kind, detail, CURRENT_TIME, self.root, at.0, at.1, 0).map_err(x)?;
        Ok(())
    }

    fn flush(&self) -> Result<(), CuError> {
        self.conn.sync().map_err(x)
    }

    fn at(p: (f64, f64)) -> (i16, i16) {
        (p.0.round().clamp(-32768.0, 32767.0) as i16, p.1.round().clamp(-32768.0, 32767.0) as i16)
    }

    pub fn move_to(&self, p: (f64, f64)) -> Result<(), CuError> {
        self.require_xtest()?;
        self.fake(xproto::MOTION_NOTIFY_EVENT, 0, Self::at(p))?;
        self.flush()
    }

    pub fn button(&self, button: u8, down: bool) -> Result<(), CuError> {
        self.require_xtest()?;
        self.fake(if down { xproto::BUTTON_PRESS_EVENT } else { xproto::BUTTON_RELEASE_EVENT }, button, (0, 0))?;
        self.flush()
    }

    /// One move, then a press and release per click, close enough together to count as a double click.
    pub fn click(&self, p: (f64, f64), button: u8, count: u8) -> Result<(), CuError> {
        self.move_to(p)?;
        sleep(PAUSE);
        for _ in 0..count {
            self.button(button, true)?;
            sleep(PAUSE);
            self.button(button, false)?;
            sleep(PAUSE);
        }
        Ok(())
    }

    pub fn drag(&self, from: (f64, f64), to: (f64, f64)) -> Result<(), CuError> {
        let point = |t: f64| (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
        self.move_to(from)?;
        sleep(PAUSE);
        self.button(1, true)?;
        sleep(PAUSE);
        let moved = (1..=DRAG_STEPS).try_for_each(|step| {
            sleep(Duration::from_millis(15));
            self.move_to(point(f64::from(step) / f64::from(DRAG_STEPS)))
        });
        // Released even when a move failed: a button left down breaks the user's next click.
        let released = self.button(1, false);
        moved.and(released)
    }

    /// The wheel turns where the pointer is: X has no wheel event, only buttons 4 to 7, a notch a click.
    pub fn scroll(&self, p: (f64, f64), button: u8, notches: u32) -> Result<(), CuError> {
        self.move_to(p)?;
        sleep(PAUSE);
        for _ in 0..notches {
            self.button(button, true)?;
            self.button(button, false)?;
        }
        Ok(())
    }

    fn keymap(&self) -> Result<Keymap, CuError> {
        let setup = self.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = self.conn.get_keyboard_mapping(min, max - min + 1).map_err(x)?.reply().map_err(x)?;
        Ok(Keymap { min_keycode: min, per_keycode: usize::from(reply.keysyms_per_keycode), keysyms: reply.keysyms })
    }

    fn key(&self, code: u8, down: bool) -> Result<(), CuError> {
        self.fake(if down { xproto::KEY_PRESS_EVENT } else { xproto::KEY_RELEASE_EVENT }, code, (0, 0))
    }

    /// Press keysyms one after another, each with the shift or AltGr its key
    /// needs. A keysym no key makes is bound to a spare keycode for the press,
    /// as xdotool does, and the keymap is put back after. With Caps Lock on, it
    /// is turned off for the typing and on again after, or every letter would flip case.
    pub fn press_keysyms(&self, held: &[u32], keysyms: &[u32]) -> Result<(), CuError> {
        self.require_xtest()?;
        let map = self.keymap()?;
        let code_of = |sym: u32, fallback: u32| map.find(sym).or_else(|| map.find(fallback)).map(|(c, _)| c);
        let shift = code_of(codes::SHIFT_L, 0xffe2);
        let altgr = code_of(codes::ISO_LEVEL3_SHIFT, 0xff7e);
        let mut mods: Vec<u8> = Vec::new();
        for m in held {
            // Right-hand twins: Shift_R, Control_R, Alt_R, Super_R; Meta_L for an Alt-less map.
            let twin = match *m { codes::SHIFT_L => 0xffe2, codes::CONTROL_L => 0xffe4, codes::ALT_L => 0xffe7, codes::SUPER_L => 0xffec, other => other };
            mods.push(code_of(*m, twin).ok_or_else(|| CuError::invalid(format!("this keyboard has no key for modifier 0x{m:x}")))?);
        }
        let caps = self.conn.query_pointer(self.root).ok().and_then(|c| c.reply().ok()).is_some_and(|p| p.mask.contains(KeyButMask::LOCK));
        let caps_key = if caps { code_of(codes::CAPS_LOCK, codes::CAPS_LOCK) } else { None };
        let spare = map.spare();
        let mut bound: Option<u32> = None;
        let tap = |code: u8| -> Result<(), CuError> { self.key(code, true)?; self.key(code, false) };

        let run = (|| -> Result<(), CuError> {
            if let Some(c) = caps_key {
                tap(c)?;
            }
            for m in &mods {
                self.key(*m, true)?;
            }
            for (i, sym) in keysyms.iter().enumerate() {
                let found = map.find(*sym).filter(|(_, level)| !level.needs_altgr() || altgr.is_some());
                let (code, level) = match found {
                    Some(hit) => hit,
                    None => {
                        let code = spare.ok_or_else(|| CuError::new(ErrorCode::ActionNotSupported, "this keyboard layout has no key for a character in the text, and no free key to borrow for it; use pasteText"))?;
                        if bound != Some(*sym) {
                            let row = vec![*sym; map.per_keycode.max(1)];
                            self.conn.change_keyboard_mapping(1, code, row.len() as u8, &row).map_err(x)?;
                            self.flush()?;
                            sleep(REMAP_SETTLE);
                            bound = Some(*sym);
                        }
                        (code, Level::Plain)
                    }
                };
                let extra: Vec<u8> = [(level.needs_shift(), shift), (level.needs_altgr(), altgr)].into_iter().filter_map(|(need, c)| need.then_some(c).flatten()).filter(|c| !mods.contains(c)).collect();
                for m in &extra {
                    self.key(*m, true)?;
                }
                tap(code)?;
                for m in extra.iter().rev() {
                    self.key(*m, false)?;
                }
                if (i + 1) % TEXT_CHUNK == 0 {
                    self.flush()?;
                    sleep(Duration::from_millis(8));
                }
            }
            Ok(())
        })();
        // Modifiers always come back up and the keymap back to what it was: a stuck key or a borrowed one breaks the user's next keystroke.
        for m in mods.iter().rev() {
            let _ = self.key(*m, false);
        }
        if let (Some(code), Some(_)) = (spare, bound) {
            let _ = self.flush();
            sleep(REMAP_SETTLE);
            let row = vec![0u32; map.per_keycode.max(1)];
            let _ = self.conn.change_keyboard_mapping(1, code, row.len() as u8, &row);
        }
        if let Some(c) = caps_key {
            let _ = tap(c);
        }
        let flushed = self.flush();
        run.and(flushed)
    }
}

/// Which of `windows` a click at `p` lands on, by the stacking order.
pub fn window_at(windows: &[XWindow], p: (f64, f64)) -> Option<u32> {
    let frames: Vec<(u32, Rect)> = windows.iter().filter(|w| !w.hidden).map(|w| (w.id, w.frame)).collect();
    ewmh::topmost_at(&frames, p.0, p.1)
}
