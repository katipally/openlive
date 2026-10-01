//! The Linux backend: AT-SPI for the tree and semantic actions on X11 and
//! Wayland alike; on X11, EWMH for windows, the root window for pixels and
//! XTEST for input; on Wayland, the xdg-desktop-portal RemoteDesktop session
//! for pixels (a PipeWire screen cast) and input. Coordinates are X screen
//! pixels on X11 and the compositor's logical coordinates on Wayland.
//!
//! Nothing links a system library: D-Bus (zbus) and X11 (x11rb) are spoken in
//! Rust, and libpipewire is loaded at run time only to take a Wayland picture.
//!
//! Adapted in part from Orca's Linux runtime (MIT, Copyright (c) 2026 Lovecast
//! Inc.): the action names a click tries, and the clipboard restore after a
//! paste. And from Cua Driver's platform-linux (https://github.com/trycua/cua,
//! MIT, Copyright (c) 2025 Cua AI, Inc.): switching on accessibility through
//! `org.a11y.Status.IsEnabled` alone, and leaving Cinnamon's switch alone.
//! See THIRD_PARTY_NOTICES.

pub mod codes;
pub mod desktop;
pub mod ewmh;
pub mod geom;
pub mod portal;
pub mod roles;
pub mod spa;

#[cfg(target_os = "linux")]
mod atspi;
#[cfg(target_os = "linux")]
mod backend;
#[cfg(target_os = "linux")]
mod bus;
#[cfg(target_os = "linux")]
mod clipboard;
#[cfg(target_os = "linux")]
mod pipewire;
#[cfg(target_os = "linux")]
mod wayland;
#[cfg(target_os = "linux")]
mod x11;

#[cfg(target_os = "linux")]
pub use backend::LinuxBackend;
