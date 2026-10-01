//! The built helper end to end on a real Windows desktop: start it, connect to
//! its private pipe, and ask only what changes nothing (handshake, permissions,
//! listWindows). Nothing is clicked or typed. Opt in with OPENLIVE_CU_SMOKE=1,
//! as CI's Windows job does.
#![cfg(windows)]

use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TOKEN: &str = "smoke-token-0123456789abcdef";

fn ask(stream: &mut BufReader<Stream>, id: u64, method: &str) -> Value {
    let line = format!("{}\n", json!({ "id": id, "token": TOKEN, "method": method, "params": {} }));
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
    let pipe = format!(r"\\.\pipe\openlive-cu-smoke-{}", std::process::id());
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
    assert_eq!(hello["platform"], "windows");
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
    } else {
        // A runner whose job runs as a service is in session 0: the helper must say so, not fail.
        assert!(hello["reason"].as_str().unwrap().contains("session 0"), "{hello}");
    }
    ask(&mut stream, 4, "terminate");
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(dir);
}
