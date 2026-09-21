"use strict";
// What Flow needs to know about the machine it is running on: the window the
// user is actually in, whether this is a moment to speak out loud, and what the
// platform can honestly do. Everything here is best effort and returns null
// rather than guessing — the pill says "unknown" far better than it says wrong.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, ipcMain, screen } = require("electron");
const flowInput = require("./flow-input.cjs");

// Shelling out is the only way to read most of these, so a burst of turns must
// not become a burst of processes.
const SIGNAL_TTL_MS = 4000;

// Matched against the foreground app and the process list. Lowercased substring
// match, so "zoom.us" catches "zoom.us.app" and Teams' several executable names.
const MEETING_APPS = [
  "zoom", "microsoft teams", "teams", "webex", "bluejeans", "gotomeeting", "ringcentral",
  "skype", "facetime", "discord", "whereby", "around", "gather", "chime", "lifesize",
];

function run(cmd, args, timeout = 1500) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

/** Block 4 adds the native window read. Until it lands Flow says what it can see. */
function foregroundWindow() {
  try {
    const api = flowInput.load();
    return typeof api.foregroundWindow === "function" ? api.foregroundWindow() : null;
  } catch { return null; }
}

function captureContext() {
  const win = foregroundWindow() ?? {};
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return {
    ...(win.app ? { app: String(win.app) } : {}),
    ...(win.title ? { windowTitle: String(win.title) } : {}),
    ...(win.selection ? { selection: String(win.selection) } : {}),
    ...(win.url ? { url: String(win.url) } : {}),
    screen: { width: display.size.width, height: display.size.height, scale: display.scaleFactor },
    capturedAt: Date.now(),
  };
}

// ── auto-quiet signals ───────────────────────────────────────────────────────

async function runningMeetingApps() {
  const out = process.platform === "win32"
    ? await run("tasklist", ["/fo", "csv", "/nh"])
    : await run("/bin/ps", ["-Ao", "comm="]);
  if (out == null) return null;
  const hay = out.toLowerCase();
  return MEETING_APPS.filter((a) => hay.includes(a));
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
  const [meetingApps, muted] = await Promise.all([runningMeetingApps(), outputMuted()]);
  const value = {
    app: foregroundWindow()?.app ?? null,
    meetingApps,
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
  const wayland = process.platform === "linux" && (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland";
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
  return { platform: process.platform, wayland, permissions, secureInput, hookError };
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

module.exports = { install, captureContext, MEETING_APPS };
