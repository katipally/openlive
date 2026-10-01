//! One connection's request loop and the method table, the same on every OS.

use crate::auth::token_matches;
use crate::backend::{refuse_blocked, Action, Backend, Button, ClickAt, Direction, Observation, Resolved};
use crate::framing::{read_line, write_line};
use crate::geometry::ShotGeometry;
use crate::image::{encode, MAX_LONG_EDGE};
use crate::keys;
use crate::protocol::*;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::time::Duration;

/// How long the screen gets to catch up before the state after an action is read.
const DEFAULT_SETTLE_MS: u64 = 250;
const MAX_SETTLE_MS: u64 = 3_000;
pub const MAX_CLICKS: u8 = 3;
const MAX_SCROLL_PAGES: f64 = 20.0;

/// How a connection ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// The peer hung up after at least one authenticated request: the helper's owner is gone.
    OwnerLeft,
    /// The peer never authenticated, or was refused.
    Stranger,
    /// The owner asked the helper to exit.
    Terminate,
}

pub struct Server<B: Backend> {
    backend: B,
    token: String,
    /// The last picture of each window, by window id: what the model's pixel coordinates are in.
    shots: HashMap<u64, ShotGeometry>,
    sleep: fn(Duration),
    /// Told when the first request with the right token arrives.
    pub on_owner: fn(),
}

impl<B: Backend> Server<B> {
    pub fn new(backend: B, token: String) -> Self {
        Server { backend, token, shots: HashMap::new(), sleep: std::thread::sleep, on_owner: || {} }
    }

    /// Serve one connection until it closes. A request with the wrong token is
    /// answered `unauthorized` and the connection is dropped.
    pub fn serve(&mut self, reader: &mut impl BufRead, writer: &mut impl Write) -> io::Result<Ended> {
        let mut owner = false;
        loop {
            let Some(line) = read_line(reader)? else {
                return Ok(if owner { Ended::OwnerLeft } else { Ended::Stranger });
            };
            let req: Request = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(e) => {
                    let id = serde_json::from_str::<Value>(&line).ok().and_then(|v| v.get("id")?.as_u64()).unwrap_or(0);
                    write_line(writer, &Response::err(id, CuError::new(ErrorCode::InvalidRequest, e.to_string())))?;
                    continue;
                }
            };
            if !token_matches(&self.token, &req.token) {
                write_line(writer, &Response::err(req.id, CuError::new(ErrorCode::Unauthorized, "bad token")))?;
                return Ok(Ended::Stranger);
            }
            if !owner {
                owner = true;
                (self.on_owner)();
            }
            let reply = match self.handle(&req.method, req.params) {
                Ok(v) => Response::ok(req.id, v),
                Err(e) => Response::err(req.id, e),
            };
            write_line(writer, &reply)?;
            if req.method == "terminate" {
                return Ok(Ended::Terminate);
            }
        }
    }

    pub fn handle(&mut self, method: &str, params: Value) -> Result<Value, CuError> {
        let p = Params(params);
        if let Some(why) = self.backend.unsupported() {
            if !matches!(method, "handshake" | "permissions" | "terminate") {
                return Err(CuError::new(ErrorCode::UnsupportedPlatform, why));
            }
        }
        match method {
            "handshake" => {
                let reason = self.backend.unsupported();
                to_value(Handshake { protocol: PROTOCOL_VERSION, version: env!("CARGO_PKG_VERSION"), platform: self.backend.platform(), ready: reason.is_none(), reason, pid: std::process::id() })
            }
            "terminate" => Ok(json!({})),
            "permissions" => Ok(json!({ "grants": self.backend.grants() })),
            "requestPermission" => {
                let id: String = p.req("id")?;
                self.backend.request_grant(&id)?;
                Ok(json!({ "grants": self.backend.grants() }))
            }
            "listApps" => Ok(json!({ "apps": self.backend.list_apps()? })),
            "listWindows" => Ok(json!({ "windows": self.backend.list_windows(p.opt::<String>("app")?.as_deref())? })),
            "getAppState" => {
                let target = self.resolve(&p)?;
                to_value(self.snapshot(&target, p.opt("screenshot")?.unwrap_or(true))?)
            }
            "click" | "performSecondaryAction" | "setValue" | "typeText" | "pasteText" | "pressKey" | "hotkey" | "scroll" | "drag"
            | "move" | "mouseDown" | "mouseUp" => {
                let target = self.resolve(&p)?;
                let action = self.action(method, &p, &target)?;
                let report = self.backend.act(&target, &action)?;
                let settle = p.opt::<u64>("settleMs")?.unwrap_or(DEFAULT_SETTLE_MS).min(MAX_SETTLE_MS);
                (self.sleep)(Duration::from_millis(settle));
                // The window may have closed or changed: read back whichever window it now is.
                let after = self.backend.resolve(Some(&format!("pid:{}", target.app.pid)), Some(target.window.id))
                    .or_else(|_| self.backend.resolve(Some(&format!("pid:{}", target.app.pid)), None));
                let (state, state_error) = match after.and_then(|t| self.snapshot(&t, p.opt("screenshot")?.unwrap_or(true))) {
                    Ok(s) => (Some(s), None),
                    Err(e) => (None, Some(e.message)),
                };
                to_value(ActionResult { action: report, state, state_error })
            }
            other => Err(CuError::new(ErrorCode::UnknownMethod, format!("unknown method '{other}'"))),
        }
    }

    fn resolve(&mut self, p: &Params) -> Result<Resolved, CuError> {
        let target = self.backend.resolve(p.opt::<String>("app")?.as_deref(), p.opt("windowId")?)?;
        refuse_blocked(&target.app)?;
        Ok(target)
    }

    fn snapshot(&mut self, target: &Resolved, screenshot: bool) -> Result<Snapshot, CuError> {
        let Observation { tree_text, element_count, focused, truncated, image } = self.backend.observe(target, screenshot, MAX_LONG_EDGE)?;
        let (shot, screenshot_error) = match image.map(|r| r.and_then(encode)) {
            Some(Ok(e)) => {
                self.shots.insert(target.window.id, ShotGeometry { frame: target.window.frame, width: e.width, height: e.height });
                let data = base64::engine::general_purpose::STANDARD.encode(&e.bytes);
                (Some(Screenshot { data, mime: e.mime, width: e.width, height: e.height }), None)
            }
            Some(Err(why)) => (None, Some(why)),
            None => (None, None),
        };
        Ok(Snapshot { app: target.app.clone(), window: target.window.clone(), tree_text, element_count, focused_element: focused, truncated, screenshot: shot, screenshot_error })
    }

    /// A pixel in the last picture of this window, as a desktop point. The window
    /// may have moved since; it may not have changed size, or the picture no
    /// longer describes it.
    fn point(&self, target: &Resolved, x: f64, y: f64) -> Result<ClickAt, CuError> {
        let shot = self.shots.get(&target.window.id).ok_or_else(|| CuError::invalid(
            "there is no picture of this window yet to take coordinates from: call getAppState first, or use an element index",
        ))?;
        let (now, then) = (target.window.frame, shot.frame);
        if (now.width - then.width).abs() > 1.0 || (now.height - then.height).abs() > 1.0 {
            return Err(CuError::new(ErrorCode::WindowNotFound, "the window changed size since its last picture: call getAppState again"));
        }
        let (sx, sy) = ShotGeometry { frame: now, ..*shot }.to_screen(x, y)?;
        Ok(ClickAt::Point(sx, sy))
    }

    /// An element index, or an x/y pair in the last picture, under the given key names.
    fn at(&self, p: &Params, target: &Resolved, index: &str, x: &str, y: &str) -> Result<ClickAt, CuError> {
        if let Some(i) = p.opt::<usize>(index)? {
            return Ok(ClickAt::Element(i));
        }
        match (p.opt::<f64>(x)?, p.opt::<f64>(y)?) {
            (Some(x), Some(y)) => self.point(target, x, y),
            _ => Err(CuError::invalid(format!("give {index}, or both {x} and {y}"))),
        }
    }

    fn action(&self, method: &str, p: &Params, target: &Resolved) -> Result<Action, CuError> {
        let mac = self.backend.platform() == "macos";
        Ok(match method {
            "click" => {
                let button = button(p)?;
                let count = p.opt::<u8>("count")?.unwrap_or(1);
                if !(1..=MAX_CLICKS).contains(&count) {
                    return Err(CuError::invalid(format!("count must be 1 to {MAX_CLICKS}")));
                }
                Action::Click { at: self.at(p, target, "elementIndex", "x", "y")?, button, count }
            }
            "performSecondaryAction" => Action::SecondaryAction { element: p.req("elementIndex")?, action: p.req("action")? },
            "setValue" => Action::SetValue { element: p.req("elementIndex")?, value: p.req("value")? },
            "typeText" => Action::TypeText { text: nonempty(p.req("text")?)? },
            "pasteText" => Action::PasteText { text: nonempty(p.req("text")?)? },
            "pressKey" | "hotkey" => Action::PressKey { chord: keys::parse(&p.req::<String>("key")?, mac)?, hotkey: method == "hotkey" },
            "scroll" => {
                let direction = match p.req::<String>("direction")?.as_str() {
                    "up" => Direction::Up,
                    "down" => Direction::Down,
                    "left" => Direction::Left,
                    "right" => Direction::Right,
                    d => return Err(CuError::invalid(format!("unknown direction '{d}'"))),
                };
                let pages = p.opt::<f64>("pages")?.unwrap_or(1.0);
                if !(pages > 0.0 && pages <= MAX_SCROLL_PAGES) {
                    return Err(CuError::invalid(format!("pages must be above 0 and at most {MAX_SCROLL_PAGES}")));
                }
                Action::Scroll { at: self.at(p, target, "elementIndex", "x", "y")?, direction, pages }
            }
            "drag" => Action::Drag {
                from: self.at(p, target, "fromElementIndex", "fromX", "fromY")?,
                to: self.at(p, target, "toElementIndex", "toX", "toY")?,
            },
            "move" => Action::Move { at: self.at(p, target, "elementIndex", "x", "y")? },
            "mouseDown" => Action::MouseDown { at: self.at(p, target, "elementIndex", "x", "y")?, button: button(p)? },
            "mouseUp" => Action::MouseUp { at: self.at(p, target, "elementIndex", "x", "y")?, button: button(p)? },
            _ => unreachable!("routed by handle"),
        })
    }
}

fn button(p: &Params) -> Result<Button, CuError> {
    Ok(match p.opt::<String>("button")?.as_deref().unwrap_or("left") {
        "left" => Button::Left,
        "right" => Button::Right,
        "middle" => Button::Middle,
        b => return Err(CuError::invalid(format!("unknown button '{b}'"))),
    })
}

fn nonempty(text: String) -> Result<String, CuError> {
    if text.is_empty() { Err(CuError::invalid("text is empty")) } else { Ok(text) }
}

fn to_value(v: impl serde::Serialize) -> Result<Value, CuError> {
    serde_json::to_value(v).map_err(|e| CuError::internal(e.to_string()))
}

/// Request params, read one typed field at a time so each error names its field.
struct Params(Value);

impl Params {
    fn opt<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Result<Option<T>, CuError> {
        match self.0.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => T::deserialize(v).map(Some).map_err(|e| CuError::invalid(format!("{key}: {e}"))),
        }
    }
    fn req<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Result<T, CuError> {
        self.opt(key)?.ok_or_else(|| CuError::invalid(format!("{key} is required")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::not_yet;
    use ::image::RgbaImage;
    use std::io::Cursor;

    const TOKEN: &str = "test-token-0123456789";

    #[derive(Default)]
    struct Fake {
        acted: Vec<Action>,
        observed: usize,
        frame: Option<Rect>,
        stub: bool,
    }

    fn app(bundle: &str) -> AppInfo {
        AppInfo { name: "Notes".into(), bundle_id: Some(bundle.into()), pid: 7, active: true }
    }

    impl Backend for Fake {
        fn platform(&self) -> &'static str { "macos" }
        fn unsupported(&self) -> Option<String> { self.stub.then(|| not_yet("testos").message) }
        fn grants(&self) -> Vec<Grant> { vec![Grant { id: "accessibility", granted: true, settings_url: None, detail: None }] }
        fn request_grant(&mut self, _: &str) -> Result<(), CuError> { Ok(()) }
        fn list_apps(&mut self) -> Result<Vec<AppInfo>, CuError> { Ok(vec![app("com.apple.Notes")]) }
        fn list_windows(&mut self, _: Option<&str>) -> Result<Vec<WindowInfo>, CuError> { Ok(vec![]) }
        fn resolve(&mut self, a: Option<&str>, _: Option<u64>) -> Result<Resolved, CuError> {
            let bundle = if a == Some("1Password") { "com.1password.1password" } else { "com.apple.Notes" };
            let frame = self.frame.unwrap_or(Rect { x: 100.0, y: 100.0, width: 400.0, height: 300.0 });
            Ok(Resolved { app: app(bundle), window: WindowInfo { id: 9, app_name: "Notes".into(), bundle_id: None, pid: 7, title: Some("N".into()), frame, on_screen: true } })
        }
        fn observe(&mut self, _: &Resolved, shot: bool, max: u32) -> Result<Observation, CuError> {
            self.observed += 1;
            assert_eq!(max, MAX_LONG_EDGE);
            Ok(Observation { tree_text: "0 window N".into(), element_count: 1, focused: None, truncated: false, image: shot.then(|| Ok(RgbaImage::new(800, 600))) })
        }
        fn act(&mut self, _: &Resolved, a: &Action) -> Result<ActionReport, CuError> {
            self.acted.push(a.clone());
            Ok(ActionReport::new("accessibility", "AXPress", true))
        }
    }

    fn server(fake: Fake) -> Server<Fake> {
        let mut s = Server::new(fake, TOKEN.into());
        s.sleep = |_| {};
        s
    }

    fn run(s: &mut Server<Fake>, lines: &[Value]) -> (Vec<Value>, Ended) {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let mut out = Vec::new();
        let ended = s.serve(&mut Cursor::new(input), &mut out).unwrap();
        (String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect(), ended)
    }

    fn req(id: u64, method: &str, params: Value) -> Value {
        json!({ "id": id, "token": TOKEN, "method": method, "params": params })
    }

    #[test]
    fn refuses_a_bad_token_and_hangs_up() {
        let mut s = server(Fake::default());
        let (out, ended) = run(&mut s, &[json!({"id": 1, "token": "nope", "method": "listApps"}), req(2, "listApps", json!({}))]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["error"]["code"], "unauthorized");
        assert_eq!(ended, Ended::Stranger);
    }

    #[test]
    fn answers_in_order_and_reports_the_owner_leaving() {
        let mut s = server(Fake::default());
        let (out, ended) = run(&mut s, &[req(1, "handshake", json!({})), req(2, "nope", json!({})), json!("garbage"), req(3, "listApps", json!({}))]);
        assert_eq!(out[0]["result"]["protocol"], PROTOCOL_VERSION);
        assert_eq!(out[0]["result"]["ready"], true);
        assert_eq!(out[1]["error"]["code"], "unknown_method");
        assert_eq!(out[2]["error"]["code"], "invalid_request");
        assert_eq!(out[3]["result"]["apps"][0]["bundleId"], "com.apple.Notes");
        assert_eq!(ended, Ended::OwnerLeft);
    }

    #[test]
    fn terminate_ends_the_loop() {
        let mut s = server(Fake::default());
        let (out, ended) = run(&mut s, &[req(1, "terminate", json!({})), req(2, "listApps", json!({}))]);
        assert_eq!(out.len(), 1);
        assert_eq!(ended, Ended::Terminate);
    }

    #[test]
    fn get_app_state_returns_tree_then_pixels() {
        let mut s = server(Fake::default());
        let v = s.handle("getAppState", json!({})).unwrap();
        assert_eq!(v["treeText"], "0 window N");
        assert_eq!(v["screenshot"]["mime"], "image/png");
        assert_eq!(v["screenshot"]["width"], 800);
        assert_eq!(v["window"]["width"], 400.0);
        let v = s.handle("getAppState", json!({ "screenshot": false })).unwrap();
        assert!(v.get("screenshot").is_none());
    }

    #[test]
    fn pixel_clicks_convert_through_the_last_picture() {
        let mut s = server(Fake::default());
        let err = s.handle("click", json!({ "x": 10, "y": 10 })).unwrap_err();
        assert!(err.message.contains("no picture"), "{err}");
        s.handle("getAppState", json!({})).unwrap();
        // The picture is 800x600 of a 400x300 window at (100, 100).
        s.handle("click", json!({ "x": 400, "y": 300, "count": 2 })).unwrap();
        assert_eq!(s.backend.acted[0], Action::Click { at: ClickAt::Point(300.0, 250.0), button: Button::Left, count: 2 });
        assert!(s.handle("click", json!({ "x": 801, "y": 1 })).is_err());
        // A resized window has outgrown its picture.
        s.backend.frame = Some(Rect { x: 0.0, y: 0.0, width: 500.0, height: 300.0 });
        assert!(s.handle("click", json!({ "x": 1, "y": 1 })).unwrap_err().message.contains("changed size"));
    }

    #[test]
    fn every_action_comes_back_with_fresh_state() {
        let mut s = server(Fake::default());
        let v = s.handle("click", json!({ "elementIndex": 3, "button": "right" })).unwrap();
        assert_eq!(v["action"]["path"], "accessibility");
        assert_eq!(v["action"]["verified"], true);
        assert_eq!(v["state"]["treeText"], "0 window N");
        assert_eq!(s.backend.observed, 1);
        assert_eq!(s.backend.acted[0], Action::Click { at: ClickAt::Element(3), button: Button::Right, count: 1 });
    }

    #[test]
    fn hover_and_half_clicks_take_an_element_or_a_point() {
        let mut s = server(Fake::default());
        s.handle("move", json!({ "elementIndex": 2 })).unwrap();
        s.handle("getAppState", json!({})).unwrap();
        s.handle("mouseDown", json!({ "x": 0, "y": 0, "button": "right" })).unwrap();
        s.handle("mouseUp", json!({ "x": 800, "y": 600 })).unwrap();
        assert_eq!(s.backend.acted, vec![
            Action::Move { at: ClickAt::Element(2) },
            Action::MouseDown { at: ClickAt::Point(100.0, 100.0), button: Button::Right },
            Action::MouseUp { at: ClickAt::Point(500.0, 400.0), button: Button::Left },
        ]);
        assert!(s.handle("mouseDown", json!({ "elementIndex": 1, "button": "thumb" })).is_err());
        assert!(s.handle("move", json!({})).unwrap_err().message.contains("elementIndex"));
    }

    #[test]
    fn validates_arguments_by_name() {
        let mut s = server(Fake::default());
        assert!(s.handle("click", json!({})).unwrap_err().message.contains("elementIndex"));
        assert!(s.handle("click", json!({ "elementIndex": 1, "count": 9 })).is_err());
        assert!(s.handle("typeText", json!({ "text": "" })).is_err());
        assert!(s.handle("setValue", json!({ "elementIndex": "x", "value": "v" })).unwrap_err().message.starts_with("elementIndex"));
        assert!(s.handle("scroll", json!({ "elementIndex": 1, "direction": "sideways" })).is_err());
        assert!(s.handle("hotkey", json!({ "key": "cmd+shift" })).is_err());
        s.handle("hotkey", json!({ "key": "CmdOrCtrl+A" })).unwrap();
        assert!(matches!(&s.backend.acted[0], Action::PressKey { chord, hotkey: true } if chord.modifiers.meta && chord.key == "a"));
    }

    #[test]
    fn password_managers_are_refused() {
        let mut s = server(Fake::default());
        assert_eq!(s.handle("getAppState", json!({ "app": "1Password" })).unwrap_err().code, ErrorCode::AppBlocked);
        assert!(s.backend.acted.is_empty());
    }

    #[test]
    fn a_stub_backend_says_so_but_still_handshakes() {
        let mut s = server(Fake { stub: true, ..Default::default() });
        let h = s.handle("handshake", json!({})).unwrap();
        assert_eq!(h["ready"], false);
        assert!(h["reason"].as_str().unwrap().contains("not yet supported"));
        assert_eq!(s.handle("listApps", json!({})).unwrap_err().code, ErrorCode::UnsupportedPlatform);
        assert!(s.handle("permissions", json!({})).is_ok());
    }
}
