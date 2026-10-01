//! D-Bus as the backend uses it: one call with a deadline, the session bus,
//! and the accessibility bus with its status switch.
//!
//! Calls go out raw (`call_method`) rather than through generated proxies:
//! a proxy introspects and caches properties, a cost per object the tree walk
//! cannot afford, and the AT-SPI interfaces have not changed shape in a decade.

use futures_lite::future;
use openlive_cu_core::CuError;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::future::Future;
use std::time::Duration;
use zbus::zvariant::{DynamicType, OwnedValue, Type, Value};
use zbus::Connection;

/// Per call. A hung app otherwise holds a tree walk for D-Bus's default of 25 seconds a call.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(1);

pub fn block<F: Future>(f: F) -> F::Output {
    async_io::block_on(f)
}

pub async fn within<T>(limit: Duration, f: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    future::or(f, async {
        async_io::Timer::after(limit).await;
        Err("timed out".to_owned())
    })
    .await
}

/// One method call and its decoded reply, or why there is none.
pub async fn call<B, R>(conn: &Connection, dest: &str, path: &str, iface: &str, method: &str, body: &B) -> Result<R, String>
where
    B: Serialize + DynamicType,
    R: DeserializeOwned + Type,
{
    within(CALL_TIMEOUT, async {
        let msg = conn.call_method(Some(dest), path, Some(iface), method, body).await.map_err(|e| e.to_string())?;
        msg.body().deserialize::<R>().map_err(|e| e.to_string())
    })
    .await
}

pub async fn get<R: TryFrom<OwnedValue>>(conn: &Connection, dest: &str, path: &str, iface: &str, prop: &str) -> Result<R, String> {
    let v: OwnedValue = call(conn, dest, path, "org.freedesktop.DBus.Properties", "Get", &(iface, prop)).await?;
    R::try_from(v).map_err(|_| format!("{iface}.{prop} has an unexpected type"))
}

pub async fn set(conn: &Connection, dest: &str, path: &str, iface: &str, prop: &str, value: Value<'_>) -> Result<(), String> {
    call::<_, ()>(conn, dest, path, "org.freedesktop.DBus.Properties", "Set", &(iface, prop, value)).await
}

pub fn session() -> Result<Connection, CuError> {
    block(Connection::session()).map_err(|e| CuError::new(
        openlive_cu_core::ErrorCode::UnsupportedPlatform,
        format!("there is no D-Bus session bus ({e}); OpenLive Computer Use needs to run inside the user's desktop session"),
    ))
}

const BUS: &str = "org.a11y.Bus";
const BUS_PATH: &str = "/org/a11y/bus";
const STATUS: &str = "org.a11y.Status";

/// The accessibility bus, a separate daemon the session bus starts on request.
pub fn a11y(session: &Connection) -> Result<Connection, String> {
    block(async {
        let address: String = call(session, BUS, BUS_PATH, BUS, "GetAddress", &()).await?;
        within(Duration::from_secs(5), async {
            zbus::connection::Builder::address(address.as_str()).map_err(|e| e.to_string())?.build().await.map_err(|e| e.to_string())
        })
        .await
    })
    .map_err(|e| format!("the accessibility bus (at-spi2-core) is not running: {e}"))
}

/// `org.a11y.Status.IsEnabled`: what GTK, Qt and the AT-SPI bridges read to
/// decide whether to expose their trees.
pub fn a11y_enabled(session: &Connection) -> bool {
    block(get::<bool>(session, BUS, BUS_PATH, STATUS, "IsEnabled")).unwrap_or(false)
}

/// Turn the session's accessibility on. Only `IsEnabled`: `ScreenReaderEnabled`
/// tells apps a screen reader is running, which on GNOME launches Orca and in
/// editors changes how they behave (the same reason the macOS backend keeps
/// editors off Chromium's switch).
pub fn enable_a11y(session: &Connection) -> Result<(), String> {
    block(set(session, BUS, BUS_PATH, STATUS, "IsEnabled", Value::Bool(true)))
}

/// The process behind a bus name, as the bus daemon saw it connect.
pub async fn pid_of(conn: &Connection, name: &str) -> Option<i32> {
    call::<_, u32>(conn, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID", &(name,))
        .await
        .ok()
        .and_then(|p| i32::try_from(p).ok())
}
