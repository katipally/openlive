// A stand-in for openlive-cu in tests: the same command line, the same token
// file, the same NDJSON over a real local socket. Unlike the real helper it
// answers requests concurrently, so a test can tell whether the client let two
// actions overlap.
//
//   FAKE_CU_READY=0        handshake says the backend is not ready
//   FAKE_CU_CRASH_ON=name  exit as soon as that method arrives
//   FAKE_CU_DELAY_MS=n     take this long over every action
//   FAKE_CU_LOG=file       append "start|end method" lines
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";

const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const socketPath = arg("--socket");
const token = readFileSync(arg("--token-file"), "utf8").trim();
rmSync(arg("--token-file"));
const delay = Number(process.env.FAKE_CU_DELAY_MS || 0);
const note = (line) => process.env.FAKE_CU_LOG && appendFileSync(process.env.FAKE_CU_LOG, `${line}\n`);

// A 1x1 PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const snapshot = (app = "Notes") => ({
  app: { name: app, bundleId: "com.apple.Notes", pid: 42, active: true },
  window: { id: 7, appName: app, pid: 42, title: "Groceries", x: 0, y: 0, width: 800, height: 600, onScreen: true },
  treeText: `App: ${app} (com.apple.Notes, pid 42)\nWindow: "Groceries"\n\n0 window Groceries\n\t1 button Save`,
  elementCount: 2,
  truncated: false,
  screenshot: { data: PIXEL, mime: "image/png", width: 1280, height: 960 },
});

const ACTIONS = new Set(["click", "performSecondaryAction", "setValue", "typeText", "pasteText", "pressKey", "hotkey", "scroll", "drag"]);

function answer(method, params) {
  if (method === "handshake") return { protocol: 1, version: "0.0.0", platform: "fake", ready: process.env.FAKE_CU_READY !== "0", reason: "not here", pid: process.pid };
  if (method === "permissions") return { grants: [{ id: "accessibility", granted: true }, { id: "screenRecording", granted: false, settingsUrl: "x-apple.systempreferences:test" }] };
  if (method === "listApps") return { apps: [{ name: "Notes", bundleId: "com.apple.Notes", pid: 42, active: true }] };
  if (method === "listWindows") return { windows: [snapshot().window] };
  if (method === "getAppState") return snapshot(params.app);
  if (ACTIONS.has(method)) return { action: { path: method === "click" && params.elementIndex !== undefined ? "accessibility" : "synthetic", actionName: method, verified: method === "setValue" }, state: snapshot() };
  throw Object.assign(new Error(`unknown method '${method}'`), { code: "unknown_method" });
}

net.createServer((conn) => {
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const req = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (req.token !== token) {
        conn.end(`${JSON.stringify({ id: req.id, ok: false, error: { code: "unauthorized", message: "bad token" } })}\n`);
        return;
      }
      if (req.method === process.env.FAKE_CU_CRASH_ON) process.exit(1);
      if (req.method === "terminate") {
        conn.end(`${JSON.stringify({ id: req.id, ok: true, result: {} })}\n`, () => process.exit(0));
        return;
      }
      note(`start ${req.method} ${req.params?.text ?? ""}`.trim());
      setTimeout(() => {
        note(`end ${req.method} ${req.params?.text ?? ""}`.trim());
        let reply;
        try { reply = { id: req.id, ok: true, result: answer(req.method, req.params ?? {}) }; }
        catch (e) { reply = { id: req.id, ok: false, error: { code: e.code ?? "internal", message: e.message } }; }
        conn.write(`${JSON.stringify(reply)}\n`);
      }, ACTIONS.has(req.method) ? delay : 0);
    }
  });
  // The owner hanging up is the helper's cue to go, as with the real one.
  conn.on("close", () => process.exit(0));
}).listen(socketPath);
