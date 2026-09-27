"use strict";
// Owner of the ol-input native addon: it loads lazily, its lifecycle is tied
// to the app's, and everything it emits is forwarded to the renderer over IPC.
// Nothing here initialises the hook on its own: that call is what asks for
// Accessibility, and onboarding decides when the user sees that prompt.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { app, ipcMain, shell } = require("electron");

// macOS never reports a secure-input change, so it has to be polled.
const SECURE_INPUT_POLL_MS = 1000;

// macOS shows each permission prompt once per app. After a refusal, or after a
// rebuild whose signature no longer matches the stored grant, asking again is
// silently ignored. Resetting the app's own entry back to "not asked" first is
// what lets every "Allow" bring up the real system prompt.
const TCC_SERVICES = { accessibility: ["Accessibility", "PostEvent"], microphone: ["Microphone"], screen: ["ScreenCapture"] };
const PRIVACY = "x-apple.systempreferences:com.apple.preference.security?Privacy_";
const SETTINGS_PANES = {
  darwin: { accessibility: `${PRIVACY}Accessibility`, microphone: `${PRIVACY}Microphone`, screen: `${PRIVACY}ScreenCapture` },
  win32: { microphone: "ms-settings:privacy-microphone" },
};

let addon = null;
let hooked = false;
let secureTimer = null;
let armed = true; // the tray's quick disarm; the hook itself is suspended to match
let target = () => null; // the webContents that receives effects

function load() {
  if (addon) return addon;
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, "ol-input")
    : path.join(__dirname, "..", "..", "native", "ol-input");
  addon = require(dir);
  return addon;
}

function send(channel, payload) {
  const wc = target();
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}

// Every call crosses into Rust, where a failure is an error and never a crash.
// Returning it as a value keeps the renderer's call sites free of try/catch.
function guard(fn) {
  return async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  };
}

function startSecureInputPoll() {
  if (secureTimer) return;
  secureTimer = setInterval(() => {
    try {
      const status = load().secureInputStatus();
      if (status.changed) send("openlive:flow-secure-input", status);
    } catch (e) {
      console.error("[flow-input] secure input poll failed:", e);
      clearInterval(secureTimer);
      secureTimer = null;
    }
  }, SECURE_INPUT_POLL_MS);
  secureTimer.unref?.();
}

function initialize() {
  const api = load();
  api.initializeInjector();
  // A hook thread that died stays installed, and installing is a no-op while it
  // is, so it has to be dropped before a retry can start a live one.
  if (hooked && api.hookError()) { api.shutdown(); hooked = false; }
  if (!hooked) {
    api.initializeHook((effect) => send("openlive:flow-effect", effect));
    hooked = true;
    if (!armed) api.suspendHook();
  }
  startSecureInputPoll();
  return api.permissionStatus();
}

/** The tray's quick disarm. Suspending the hook is the honest implementation:
 *  no effect can arrive, so nothing downstream has to remember to ignore one.
 *  A never-initialised addon is already disarmed, so a failure here is not one. */
function setArmed(next) {
  armed = !!next;
  if (!hooked) return armed;
  try { armed ? load().resumeHook() : load().suspendHook(); }
  catch (e) { console.error("[flow-input] arm:", e); }
  return armed;
}

const isArmed = () => armed;

/** The one meaning of "Ready", shared with the Flow window: armed, granted, and
 *  a key listener that is still alive. "stopped" when that listener died,
 *  "access" when the grant is what is missing. */
function readiness() {
  if (!armed) return "off";
  try {
    const api = load();
    if (api.hookError()) return "stopped";
    return api.permissionStatus().accessibility ? "ready" : "access";
  } catch { return "off"; }
}

function granted(what) {
  const s = load().permissionStatus();
  return what === "accessibility" ? s.accessibility : what === "microphone" ? s.microphone === "granted" : s.screenRecording;
}

/** The running bundle's id: OpenLive's when packaged, Electron's in dev, which
 *  is the process macOS actually holds the grant against either way. */
let bundleId = null;
function ownBundleId() {
  if (bundleId === null) {
    try {
      const plist = fs.readFileSync(path.join(path.dirname(process.execPath), "..", "Info.plist"), "utf8");
      bundleId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? "";
    } catch { bundleId = ""; }
  }
  return bundleId;
}

// A failed reset is not fatal: the request still runs, and Settings is one click away.
const resetGrant = (service) => new Promise((resolve) => {
  execFile("/usr/bin/tccutil", ["reset", service, ownBundleId()], (e) => {
    if (e) console.error(`[flow-input] tccutil reset ${service}:`, e.message);
    resolve();
  });
});

/** Asks for `what` with the system's own prompt, every time it is not held. */
async function request(what) {
  if (!TCC_SERVICES[what]) throw new Error(`unknown permission "${what}"`);
  if (process.platform === "darwin" && ownBundleId() && !granted(what)) await Promise.all(TCC_SERVICES[what].map(resetGrant));
  const api = load();
  if (what === "accessibility") return api.requestAccessibility();
  if (what === "microphone") return api.requestMicrophone();
  return api.requestScreenRecording();
}

/** The system settings page for `what`. False where the platform has none. */
async function openSettings(what) {
  const url = SETTINGS_PANES[process.platform]?.[what];
  if (!url) return false;
  await shell.openExternal(url);
  return true;
}

function teardown() {
  if (secureTimer) { clearInterval(secureTimer); secureTimer = null; }
  if (!addon) return;
  try { addon.shutdown(); } catch (e) { console.error("[flow-input] shutdown failed:", e); }
  hooked = false;
}

// `getTarget` returns the webContents that should receive hook effects.
function install(getTarget) {
  target = getTarget;

  ipcMain.handle("openlive:flow-init", guard(() => initialize()));
  ipcMain.handle("openlive:flow-permissions", guard(() => load().permissionStatus()));
  ipcMain.handle("openlive:flow-request", guard((what) => (what === "postEvents" ? load().requestPostEvents() : request(what))));
  ipcMain.handle("openlive:flow-open-settings", guard((what) => openSettings(what)));

  ipcMain.handle("openlive:flow-register", guard((id, binding) => load().registerBinding(id, binding)));
  ipcMain.handle("openlive:flow-unregister", guard((id) => load().unregisterBinding(id)));
  ipcMain.handle("openlive:flow-suspend", guard(() => load().suspendHook()));
  ipcMain.handle("openlive:flow-resume", guard(() => load().resumeHook()));
  // Test-only: lets a page open Flow as a double Ctrl would. Released builds
  // leave it unregistered so no page script can turn the mic on.
  if (!app.isPackaged) ipcMain.handle("openlive:flow-trigger", guard((id, pressed) => load().triggerExternal(id, pressed)));
  ipcMain.handle("openlive:flow-closed", guard(() => load().notifyClosed()));

  ipcMain.handle("openlive:flow-insert", guard((text, method) => load().insertText(text, method)));
  ipcMain.handle("openlive:flow-insert-begin", guard((method) => load().beginInsertion(method)));
  ipcMain.handle("openlive:flow-insert-push", guard((session, chunk) => load().pushInsertion(session, chunk)));
  ipcMain.handle("openlive:flow-insert-end", guard((session) => load().endInsertion(session)));

  ipcMain.handle("openlive:flow-secure-input", guard(() => load().secureInputStatus()));
  ipcMain.handle("openlive:flow-hook-error", guard(() => load().hookError()));

  // will-quit, not before-quit: ⌘Q only closes to the menu bar now, and that
  // cancelled quit still fires before-quit, which left Flow with no key listener.
  app.on("will-quit", teardown);
}

module.exports = { install, teardown, load, setArmed, isArmed, readiness, request };
