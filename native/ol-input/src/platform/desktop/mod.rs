//! Capture, window and pointer primitives, one module per OS, alongside the
//! keyboard and permission primitives in the modules next door.

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "linux")]
pub use linux as current;
#[cfg(target_os = "macos")]
pub use macos as current;
#[cfg(target_os = "windows")]
pub use windows as current;
