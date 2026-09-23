"use strict";
// What Flow needs to know about the machine it is running on: the window the
// user is actually in, whether this is a moment to speak out loud, and what the
// platform can honestly do. Everything here is best effort and returns null
// rather than guessing. The orb says "unknown" far better than it says wrong.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, ipcMain, nativeImage, screen } = require("electron");
const flowInput = require("./flow-input.cjs");
const flowCursor = require("./flow-cursor.cjs");

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
    // Empty is "nothing is selected" and absent is "could not read it": the
    // addon tells them apart and so must the context it fills.
    ...(selection == null ? {} : { selection: String(selection) }),
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
    // macOS answers this from CoreAudio; the other platforms have no cheap
    // read and return null, which auto-quiet treats as "could not tell".
    micBusy: ask("microphoneInUse"),
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
  return { platform: process.platform, wayland, permissions, secureInput, hookError, report, armed: flowInput.isArmed() };
}

// ── the device bridge ────────────────────────────────────────────────────────
// The agent service runs in its own process and the addon lives here, so every
// perception and control call arrives as one named round trip. The contract the
// device tools rely on: this returns a value or it names what went wrong. An
// empty result is a lie a model cannot recover from.

// A destructive tool that already asked the user. Home is the deliberate cwd:
// Flow belongs to no project, and running a command in the app bundle or in
// whatever folder Chat last used would be a surprise either way. The login
// shell is used so the command sees the PATH the person actually has.
const SHELL_TIMEOUT_MS = 30_000;
const SHELL_OUTPUT_CAP = 64 * 1024;

const addon = () => flowInput.load();

/**
 * The display a capture means when neither a display nor a window was named.
 *
 * Falling back to the cursor means crossing from Electron's coordinates into
 * the addon's, which are the same on macOS and X11 and physical pixels on a
 * scaled Windows display. The point is converted and then matched by which
 * display contains it, because two displays that differ only in scale have
 * origins that never compare equal across that boundary.
 */
function frontDisplayId() {
  const displays = addon().displays();
  const front = addon().foregroundWindow();
  if (front && typeof front.displayId === "number") return front.displayId;
  const dip = screen.getCursorScreenPoint();
  const point = typeof screen.dipToScreenPoint === "function" ? screen.dipToScreenPoint(dip) : dip;
  const here = displays.find((d) => point.x >= d.x && point.x < d.x + d.width
    && point.y >= d.y && point.y < d.y + d.height);
  return (here ?? displays.find((d) => d.primary) ?? displays[0])?.id;
}

const screenPoint = (p) => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 });

/**
 * Run one control action, with the halo up for as long as it lasts.
 *
 * Every pointer call in the addon is a promise now, because the pointer
 * travels rather than teleports and the main thread has a cursor to draw while
 * it does. Awaiting is what makes a tool result mean "this happened", and what
 * lets the screenshot that follows show the result rather than the middle.
 */
async function control(action) {
  const done = flowCursor.begin(action);
  try {
    return await dispatch(action);
  } finally {
    done();
  }
}

function dispatch(action) {
  const api = addon();
  switch (action?.kind) {
    case "move": return api.moveMouse(screenPoint(action.point));
    case "click": return api.click(screenPoint(action.point), action.button, action.count);
    case "mouse_down": return api.mouseDown(screenPoint(action.point), action.button);
    case "mouse_up": return api.mouseUp(screenPoint(action.point), action.button);
    case "drag": return api.drag((action.path ?? []).map(screenPoint), action.button);
    case "scroll": return api.scroll(screenPoint(action.point), action.horizontal, action.vertical);
    case "type": return api.typeText(String(action.text ?? ""));
    case "keypress": return api.keypress(action.keys ?? []);
    case "window":
      if (action.op === "activate") return api.activateWindow(action.windowId);
      if (action.op === "minimize") return api.minimizeWindow(action.windowId);
      if (action.op === "close") return api.closeWindow(action.windowId);
      throw new Error(`I do not know how to "${action.op}" a window.`);
    case "window_move": return api.moveWindow(action.windowId, screenPoint(action.point));
    case "window_resize": return api.resizeWindow(action.windowId, action.width, action.height);
    case "open_app": return api.openApp(String(action.name ?? ""));
    case "open_url": return api.openUrl(String(action.url ?? ""));
    default: throw new Error(`I do not know the action "${action?.kind}".`);
  }
}

function shell(command) {
  const text = String(command ?? "").trim();
  if (!text) throw new Error("There was no command to run.");
  const win = process.platform === "win32";
  const bin = win ? (process.env.COMSPEC || "cmd.exe") : (process.env.SHELL || "/bin/sh");
  const args = win ? ["/d", "/s", "/c", text] : ["-lc", text];
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: os.homedir(), timeout: SHELL_TIMEOUT_MS, maxBuffer: SHELL_OUTPUT_CAP, windowsHide: true },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? "").slice(0, SHELL_OUTPUT_CAP),
        stderr: String(stderr ?? "").slice(0, SHELL_OUTPUT_CAP) || (err && err.killed ? `The command was still running after ${SHELL_TIMEOUT_MS / 1000} seconds, so it was stopped.` : ""),
      }));
  });
}

/** `camera_frame` is deliberately absent: no camera reaches this process. The
 *  owner renderer answers that one from the capture the live session already owns. */
async function deviceCall(fn, args = {}) {
  const api = addon();
  switch (fn) {
    case "capabilities": return api.capabilities();
    case "displays": return api.displays();
    case "capture": {
      const shot = args.windowId != null
        ? await api.captureWindow(args.windowId)
        : await api.captureDisplay(args.displayId ?? frontDisplayId());
      return { png: Buffer.from(shot.png).toString("base64"), shot: shot.shot };
    }
    case "shot_to_screen": {
      const p = api.shotToScreen(args.shot, Number(args.point?.x) || 0, Number(args.point?.y) || 0);
      return { space: "screen", x: p.x, y: p.y };
    }
    case "recognize_text":
      return api.recognizeText(Buffer.from(String(args.png ?? ""), "base64"), args.shot);
    case "windows": return api.windowList();
    case "foreground": return api.foregroundWindow();
    case "control": { await control(args); return null; }
    case "shell": return shell(args.command);
    default: throw new Error(`"${fn}" is not something this machine can be asked to do.`);
  }
}

/** The first text recognition of a process pays for loading the OS engine, which
 *  is tens of seconds on macOS. Paying it on a blank tile at launch means the
 *  first real one is not mistaken for a hang. */
async function warmOcr() {
  const size = 64;
  const png = nativeImage.createFromBitmap(Buffer.alloc(size * size * 4, 255), { width: size, height: size }).toPNG();
  await addon().recognizeText(png, { originX: 0, originY: 0, scale: 1, width: size, height: size });
}

// Same { ok, value } shape as the rest of the flow namespace, so a caller never
// has to remember which half of it throws.
function guard(fn) {
  return async (_event, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  };
}

function install() {
  flowCursor.install();
  ipcMain.handle("openlive:flow-context", guard(captureContext));
  ipcMain.handle("openlive:flow-signals", guard(signals));
  ipcMain.handle("openlive:flow-capabilities", guard(capabilities));
  ipcMain.handle("openlive:flow-device", guard(deviceCall));
  ipcMain.handle("openlive:flow-warm-ocr", guard(warmOcr));
  // Only a quit that is really happening; see flow-input.cjs for the cancelled one.
  app.on("will-quit", () => { cached = null; flowCursor.dispose(); });
}

module.exports = { install, captureContext };
