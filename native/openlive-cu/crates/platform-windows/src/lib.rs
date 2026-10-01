//! The Windows backend: UI Automation for the tree and semantic actions,
//! Windows.Graphics.Capture (PrintWindow when it fails) for pixels, SendInput
//! for the input nothing else can do. Coordinates are physical pixels: the
//! helper is per-monitor DPI aware, so window frames, element bounds and
//! SendInput all speak the same space.
//!
//! Adapted in part from Cua Driver's platform-windows (https://github.com/trycua/cua,
//! MIT, Copyright (c) 2025 Cua AI, Inc.): the WGC capture sequence (free-threaded
//! frame pool, polled frame, staging copy) and the minimized-window refusal.
//! And from Orca's Windows runtime (MIT, Copyright (c) 2026 Lovecast Inc.): the
//! pattern order for a click (Invoke, Toggle, SelectionItem) and the focus check
//! before keystrokes. See THIRD_PARTY_NOTICES.

pub mod codes;
pub mod pipe;
pub mod roles;
pub mod shot;

#[cfg(windows)]
mod backend;
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod input;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use backend::WindowsBackend;
