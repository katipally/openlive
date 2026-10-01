//! The Linux backend. A stub until phase 5c fills it in: every method that
//! touches the desktop answers `unsupported_platform`, so the client falls back
//! to ol-input's tools and the contract is already in place.

use openlive_cu_core::backend::{not_yet, Action, Backend, Observation, Resolved};
use openlive_cu_core::protocol::{ActionReport, AppInfo, CuError, Grant, WindowInfo};

#[derive(Default)]
pub struct LinuxBackend;

impl Backend for LinuxBackend {
    fn platform(&self) -> &'static str {
        "linux"
    }
    fn unsupported(&self) -> Option<String> {
        Some(not_yet("Linux").message)
    }
    fn grants(&self) -> Vec<Grant> {
        Vec::new()
    }
    fn request_grant(&mut self, _: &str) -> Result<(), CuError> {
        Err(not_yet("Linux"))
    }
    fn list_apps(&mut self) -> Result<Vec<AppInfo>, CuError> {
        Err(not_yet("Linux"))
    }
    fn list_windows(&mut self, _: Option<&str>) -> Result<Vec<WindowInfo>, CuError> {
        Err(not_yet("Linux"))
    }
    fn resolve(&mut self, _: Option<&str>, _: Option<u64>) -> Result<Resolved, CuError> {
        Err(not_yet("Linux"))
    }
    fn observe(&mut self, _: &Resolved, _: bool, _: u32) -> Result<Observation, CuError> {
        Err(not_yet("Linux"))
    }
    fn act(&mut self, _: &Resolved, _: &Action) -> Result<ActionReport, CuError> {
        Err(not_yet("Linux"))
    }
}
