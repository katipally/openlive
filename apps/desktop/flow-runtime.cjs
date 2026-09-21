"use strict";
// What Flow needs to know about the machine it is running on: the window the
// user is actually in, whether this is a moment to speak out loud, and what the
// platform can honestly do. Everything here is best effort and returns null
// rather than guessing. The pill says "unknown" far better than it says wrong.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, ipcMain, screen } = require("electron");
const flowInput = require("./flow-input.cjs");

// Shelling out is the only way to read most of these, so a burst of turns must
// not become a burst of processes.
const SIGNAL_TTL_MS = 4000;

// Processes that exist ONLY while a call is up, so their presence is a fact and
// not a guess. Matching the app itself is the renderer's job: it holds the
// user's own list of apps to stay quiet around, and matches the foreground app.
const IN_CALL_PROCESSES = ["cpthost", "aomhost", "webexmta", "ptone"];

function run(cmd, args, timeout = 1500) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

// The perception exports land with Block 4, so each one is asked for by name and
// simply absent until it exists. Flow says what it can see and nothing more.
function ask(name, fallback = null) {
  try {
    const api = flowInput.load();
    return typeof api[name] === "function" ? api[name]() : fallback;
  } catch { return fallback; }
}

const foregroundWindow = () => ask("foregroundWindow");

function captureContext() {
  const win = foregroundWindow() ?? {};
  const selection = ask("selectedText");
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return {
    ...(win.appName ? { app: String(win.appName) } : {}),
    ...(win.title ? { windowTitle: String(win.title) } : {}),
    ...(selection ? { selection: String(selection) } : {}),
    screen: { width: display.size.width, height: display.size.height, scale: display.scaleFactor },
    capturedAt: Date.now(),
  };
}

// ── auto-quiet signals ───────────────────────────────────────────────────────

/** True only when a call is actually up, null when the process list is unreadable. */
async function inCall() {
  const out = process.platform === "win32"
    ? await run("tasklist", ["/fo", "csv", "/nh"])
    : await run("/bin/ps", ["-Ao", "comm="]);
  if (out == null) return null;
  const hay = out.toLowerCase();
  return IN_CALL_PROCESSES.some((p) => hay.includes(p));
}

/** macOS keeps its Focus assertions in a plist-adjacent JSON; other platforms
 *  have no cheap read, and a wrong answer here silences the user's assistant. */
function doNotDisturb() {
  if (process.platform !== "darwin") return null;
  const dir = path.join(os.homedir(), "Library", "DoNotDisturb", "DB");
  for (const name of ["Assertions.json", "ModeConfigurations.json"]) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      const data = Array.isArray(raw.data) ? raw.data[0] : null;
      if (!data) continue;
      if (Array.isArray(data.storeAssertionRecords)) return data.storeAssertionRecords.length > 0;
      const modes = data.modeConfigurations;
      if (modes) return Object.values(modes).some((m) => m && m.mode && m.mode.enabled === true);
    } catch { /* not present on this macOS version */ }
  }
  return null;
}

async function outputMuted() {
  if (process.platform === "darwin") {
    const out = await run("/usr/bin/osascript", ["-e", "output muted of (get volume settings)"]);
    return out == null ? null : out.trim() === "true";
  }
  if (process.platform === "linux") {
    const out = await run("pactl", ["get-sink-mute", "@DEFAULT_SINK@"]);
    return out == null ? null : /\byes\b/i.test(out);
  }
  return null;
}

let cached = null;
async function signals() {
  if (cached && Date.now() - cached.at < SIGNAL_TTL_MS) return cached.value;
  const [call, muted] = await Promise.all([inCall(), outputMuted()]);
  const value = {
    app: foregroundWindow()?.appName ?? null,
    inCall: call,
    dnd: doNotDisturb(),
    outputMuted: muted,
    // No platform exposes "another process holds the microphone" without a
    // native audio-device read. Block 4 owns that; until then Flow does not
    // pretend to know.
    micBusy: null,
  };
  cached = { at: Date.now(), value };
  return value;
}

function capabilities() {
  let permissions = null;
  let secureInput = null;
  let hookError = null;
  try {
    const api = flowInput.load();
    permissions = api.permissionStatus();
    secureInput = api.secureInputStatus();
    hookError = api.hookError();
  } catch (e) {
    hookError = String(e && e.message ? e.message : e);
  }
  // The addon's own report is the truth about this session when it has one;
  // the environment is only the fallback for builds that predate it.
  const report = ask("capabilities");
  const wayland = report
    ? report.session === "wayland"
    : process.platform === "linux" && (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland";
  return { platform: process.platform, wayland, permissions, secureInput, hookError, report };
}

// Same { ok, value } shape as the rest of the flow namespace, so a caller never
// has to remember which half of it throws.
function guard(fn) {
  return async () => {
    try { return { ok: true, value: await fn() }; }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  };
}

function install() {
  ipcMain.handle("openlive:flow-context", guard(captureContext));
  ipcMain.handle("openlive:flow-signals", guard(signals));
  ipcMain.handle("openlive:flow-capabilities", guard(capabilities));
  app.on("before-quit", () => { cached = null; });
}

module.exports = { install, captureContext };
