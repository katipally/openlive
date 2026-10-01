//! The built helper end to end on a real desktop: start it, connect to its
//! private pipe (Windows) or socket (Linux), and ask only what changes nothing
//! (handshake, permissions, listWindows, and with OPENLIVE_CU_SMOKE_APP one
//! app's state). Nothing is clicked or typed. Opt in with OPENLIVE_CU_SMOKE=1,
//! as CI's Windows and Linux jobs do (Linux under Xvfb with an accessibility bus).
#![cfg(any(windows, target_os = "linux"))]

use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TOKEN: &str = "smoke-token-0123456789abcdef";

fn ask(stream: &mut BufReader<Stream>, id: u64, method: &str) -> Value {
    ask_with(stream, id, method, json!({}))
}

fn ask_with(stream: &mut BufReader<Stream>, id: u64, method: &str, params: Value) -> Value {
    let line = format!("{}\n", json!({ "id": id, "token": TOKEN, "method": method, "params": params }));
    stream.get_mut().write_all(line.as_bytes()).unwrap();
    let mut reply = String::new();
    stream.read_line(&mut reply).unwrap();
    let reply: Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["id"], id);
    assert_eq!(reply["ok"], true, "{method}: {reply}");
    reply["result"].clone()
}

#[test]
fn handshakes_reports_grants_and_lists_windows() {
    if std::env::var_os("OPENLIVE_CU_SMOKE").is_none() {
        return eprintln!("skipped: set OPENLIVE_CU_SMOKE=1 to run the helper against this desktop");
    }
    let dir = std::env::temp_dir().join(format!("olcu-smoke-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let token_file = dir.join("token");
    std::fs::write(&token_file, TOKEN).unwrap();
    let pipe = if cfg!(windows) { format!(r"\\.\pipe\openlive-cu-smoke-{}", std::process::id()) } else { dir.join("cu.sock").to_string_lossy().into_owned() };
    let mut child = Command::new(env!("CARGO_BIN_EXE_openlive-cu"))
        .args(["--socket", &pipe, "--token-file"])
        .arg(&token_file)
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    let stream = loop {
        match pipe.as_str().to_fs_name::<GenericFilePath>().and_then(Stream::connect) {
            Ok(s) => break s,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => panic!("the helper never opened its pipe: {e}"),
        }
    };
    let mut stream = BufReader::new(stream);

    let hello = ask(&mut stream, 1, "handshake");
    assert_eq!(hello["platform"], if cfg!(windows) { "windows" } else { "linux" });
    assert_eq!(hello["protocol"], 1);
    let grants = ask(&mut stream, 2, "permissions");
    let ids: Vec<&str> = grants["grants"].as_array().unwrap().iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["accessibility", "screenRecording"]);
    if hello["ready"] == true {
        let windows = ask(&mut stream, 3, "listWindows");
        for w in windows["windows"].as_array().unwrap() {
            assert!(w["id"].as_u64().is_some() && w["width"].as_f64().unwrap() >= 48.0, "{w}");
        }
        println!("{} windows", windows["windows"].as_array().unwrap().len());
        if let Ok(app) = std::env::var("OPENLIVE_CU_SMOKE_APP") {
            let state = ask_with(&mut stream, 5, "getAppState", json!({ "app": app }));
            println!("{}", state["treeText"].as_str().unwrap_or_default());
            assert!(state["elementCount"].as_u64().unwrap() > 0, "{app} showed no accessibility tree");
            assert!(state["screenshot"]["width"].as_u64().is_some() || state["screenshotError"].is_string(), "{state}");
        }
    } else if cfg!(windows) {
        // A runner whose job runs as a service is in session 0: the helper must say so, not fail.
        assert!(hello["reason"].as_str().unwrap().contains("session 0"), "{hello}");
    } else {
        // No display or session bus: the helper must say so, not fail.
        assert!(hello["reason"].as_str().unwrap().contains("session"), "{hello}");
    }
    ask(&mut stream, 4, "terminate");
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(dir);
}
