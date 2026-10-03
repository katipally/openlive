"use strict";
// Owner of the ol-input native addon: it loads lazily, its lifecycle is tied
// to the app's, and everything it emits is forwarded to the renderer over IPC.
// Nothing here initialises the hook on its own: that call is what asks for
// Accessibility, and onboarding decides when the user sees that prompt.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { app, ipcMain, shell } = require("electron");
const { askedFrom, permissionGranted, permissionName } = require("./telemetry-map.cjs");

// macOS never reports a secure-input change, so it has to be polled.
const SECURE_INPUT_POLL_MS = 1000;

// macOS shows each permission prompt once per app. After a refusal, or after a
// rebuild whose signature no longer matches the stored grant, asking again is
// silently ignored. Resetting the app's own entry back to "not asked" first is
// what lets every "Allow" bring up the real system prompt.
const TCC_SERVICES = { accessibility: ["Accessibility", "PostEvent"], microphone: ["Microphone"], screen: ["ScreenCapture"] };
const PRIVACY = "x-apple.systempreferences:com.apple.preference.security?Privacy_";
const SETTINGS_PANES = {
  darwin: {
    accessibility: `${PRIVACY}Accessibility`, microphone: `${PRIVACY}Microphone`, screen: `${PRIVACY}ScreenCapture`,
    // Where "Press 🌐 key to" lives, for a push-to-talk Fn (Ventura and later).
    keyboard: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
  },
  win32: { microphone: "ms-settings:privacy-microphone" },
};

let addon = null;
let hooked = false;
// Why the hook could not start, e.g. no read access to /dev/input on Linux.
// The addon only reports a hook that started and then died.
let startError = null;
let secureTimer = null;
let armed = true; // Flow's on/off switch, on its home; Flow's binding alone is muted to match, so Dictate's keeps working
const FLOW_BINDING = "flow";
const DICTATE_BINDING = "dictate";
const PTT_BINDING = "ptt";
const ROLES = { [FLOW_BINDING]: "toggle", [DICTATE_BINDING]: "toggle", [PTT_BINDING]: "hold" };
// Packaged QA only, set by hand in the environment: F19, F20 and F18 stand in
// for Flow's, Dictate's and the push-to-talk keys, so a QA run can synthesize
// them without touching Control or Option, which a dev build running beside it
// also listens to. It also lets a page fire the external trigger.
const QA_KEYS = process.env.OPENLIVE_QA_KEYS === "1";
const QA = { [FLOW_BINDING]: "f19", [DICTATE_BINDING]: "f20", [PTT_BINDING]: "f18" };
let wanted = {}; // id -> the binding the settings ask for, null for none
const bindings = new Map(); // id -> the binding registered with the hook
let route = () => {}; // where each hook effect goes, main's to decide
let target = () => null; // the webContents that receives the secure-input status
let ownField = () => null; // OpenLive's own window's webContents while it has the keyboard, else null
const ownSessions = new Map(); // insertion session -> the own window it types into
let ownSession = 2 ** 30; // above any session id the addon hands out
// What Dictate types into in OpenLive's own window: a text field that takes input, or an editable element.
const OWN_EDITABLE = `(() => { const e = document.activeElement; return !!e && (e.isContentEditable || ((e.tagName === "TEXTAREA"
  || (e.tagName === "INPUT" && /^(text|search|email|url|tel|password|number)$/.test(e.type))) && !e.disabled && !e.readOnly)); })()`;
// The selection inside that text box, as Dictate's edits read it: OpenLive's
// own page, read directly rather than through the OS. Never a password's.
const OWN_SELECTION = `(() => { const e = document.activeElement; if (!e || e.disabled || e.readOnly) return "";
  if (e.isContentEditable) return String(getSelection() ?? "");
  const box = e.tagName === "TEXTAREA" || (e.tagName === "INPUT" && /^(text|search|email|url|tel|number)$/.test(e.type));
  return box && e.selectionStart != null ? e.value.slice(e.selectionStart, e.selectionEnd ?? e.selectionStart) : ""; })()`;
let telemetry = null;

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
    try { api.initializeHook((effect) => route(effect)); }
    catch (e) {
      startError = String(e && e.message ? e.message : e);
      telemetry.reportOnboardingStep("flow_hook_failed");
      throw e;
    }
    startError = null;
    hooked = true;
    telemetry.reportOnboardingStep("flow_hook_started");
    if (!armed) api.suspendHook(FLOW_BINDING);
    // A hook that just started holds no binding, whatever was registered on the last one.
    bindings.clear();
    syncBindings();
  }
  startSecureInputPoll();
  return api.permissionStatus();
}

/** Flow's off switch. Suspending the hook is the honest implementation:
 *  no effect can arrive, so nothing downstream has to remember to ignore one.
 *  A never-initialised addon is already disarmed, so a failure here is not one. */
function setArmed(next) {
  armed = !!next;
  if (!hooked) return armed;
  try { armed ? load().resumeHook(FLOW_BINDING) : load().suspendHook(FLOW_BINDING); }
  catch (e) { console.error("[flow-input] arm:", e); }
  return armed;
}

const isArmed = () => armed;

/** The keys the settings ask for, `{ flow, dictate, ptt }`, each a binding in
 *  ol-input's grammar or null for none. Registered at once while the hook runs,
 *  and the moment it starts otherwise, so a rebind needs no restart. */
function setBindings(next) {
  wanted = Object.fromEntries(Object.keys(ROLES).map((id) => [id, watched(id, next?.[id])]));
  if (hooked) syncBindings();
}

/** The binding the hook watches, or would, for `key` under `id`: the QA
 *  stand-in while those are on, null for none. */
const watched = (id, key) => (key ? (QA_KEYS ? QA[id] : String(key)) : null);

/** Registers what changed. A failure leaves that binding off and is logged: one
 *  bad key in a hand-edited file must not cost the other two. */
function syncBindings() {
  const api = load();
  for (const [id, role] of Object.entries(ROLES)) {
    const want = wanted[id] ?? null;
    if ((bindings.get(id) ?? null) === want) continue;
    try {
      if (bindings.has(id)) { api.unregisterBinding(id); bindings.delete(id); }
      if (want) { api.registerBinding(id, want, role); bindings.set(id, want); }
    } catch (e) { console.error(`[flow-input] ${id} key:`, e); }
  }
}

/** The binding the hook watches under `id` (ol-input's grammar, e.g. "ctrl"), or
 *  null. A toggle is narrowed away from the push-to-talk key, as the hook does. */
function binding(id) {
  const key = bindings.get(id);
  const ptt = bindings.get(PTT_BINDING);
  if (!key || !ptt || ROLES[id] !== "toggle") return key ?? null;
  try { return load().narrowToggle(key, ptt); } catch { return key; }
}

/** The one meaning of "Ready", shared with the Flow window: armed, granted, and
 *  a key listener that is still alive. "stopped" when that listener died,
 *  "access" when the grant is what is missing. */
function readiness() {
  return armed ? hookReadiness() : "off";
}

/** The key listener's own state, whatever Flow's off switch says: Dictate listens through it too. */
function hookReadiness() {
  try {
    const api = load();
    if (hookFailure()) return "stopped";
    return api.permissionStatus().accessibility ? "ready" : "access";
  } catch { return "off"; }
}

/** The message the key listener failed with, whether it died or never started. */
function hookFailure() {
  try { return load().hookError() || startError; } catch { return startError; }
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
async function prompt(what) {
  if (!TCC_SERVICES[what]) throw new Error(`unknown permission "${what}"`);
  if (process.platform === "darwin" && ownBundleId() && !granted(what)) await Promise.all(TCC_SERVICES[what].map(resetGrant));
  const api = load();
  if (what === "accessibility") return api.requestAccessibility();
  if (what === "microphone") return api.requestMicrophone();
  return api.requestScreenRecording();
}

/** `prompt`, and the post-event grant's own, with the answer counted for the onboarding funnel.
 *  `from` is the screen that asked; only a name from telemetry's closed set is kept. */
async function request(what, from) {
  const answer = await (what === "postEvents" ? load().requestPostEvents() : prompt(what));
  telemetry.track("os_permission_request", { permission: permissionName(what), granted_now: permissionGranted(what, answer), asked_from: askedFrom(from) });
  return answer;
}

/** The system settings page for `what`. False where the platform has none. */
async function openSettings(what) {
  const url = SETTINGS_PANES[process.platform]?.[what];
  if (!url) return false;
  await shell.openExternal(url);
  return true;
}

/** Only the three timings, each a whole number of ms, and the restore switch, so a stray field never reaches the addon. */
function insertionTiming(t) {
  const ms = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 60_000) : undefined);
  return t && {
    modifierHoldMs: ms(t.modifierHoldMs), clipboardQuietMs: ms(t.clipboardQuietMs), clipboardTimeoutMs: ms(t.clipboardTimeoutMs),
    restoreClipboard: typeof t.restoreClipboard === "boolean" ? t.restoreClipboard : undefined,
  };
}

/** What macOS does on a press of Fn (Globe), read, never written: 0 Do Nothing,
 *  1 Change Input Source, 2 Emoji & Symbols, 3 Start Dictation. Null where it
 *  cannot be read, which on a Mac never set by hand means the system default,
 *  something other than Do Nothing. Fn held to talk runs that action too. */
function fnUsage() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/defaults", ["read", "com.apple.HIToolbox", "AppleFnUsageType"], (e, out) => {
      const n = e ? NaN : Number.parseInt(String(out).trim(), 10);
      resolve(Number.isInteger(n) ? n : null);
    });
  });
}

function teardown() {
  if (secureTimer) { clearInterval(secureTimer); secureTimer = null; }
  if (!addon) return;
  try { addon.shutdown(); } catch (e) { console.error("[flow-input] shutdown failed:", e); }
  hooked = false;
}

// `routeEffect` takes each hook effect; `getTarget` returns the webContents
// that hears the secure-input status; `getOwnField`, OpenLive's own window's
// while it has the keyboard.
function install(routeEffect, getTarget, telemetryClient, getOwnField = () => null) {
  route = routeEffect;
  target = getTarget;
  telemetry = telemetryClient;
  ownField = getOwnField;

  ipcMain.handle("openlive:flow-init", guard(() => initialize()));
  ipcMain.handle("openlive:flow-permissions", guard(() => load().permissionStatus()));
  ipcMain.handle("openlive:flow-request", guard(request));
  ipcMain.handle("openlive:flow-open-settings", guard((what) => openSettings(what)));

  ipcMain.handle("openlive:flow-suspend", guard(() => load().suspendHook()));
  ipcMain.handle("openlive:flow-resume", guard(() => load().resumeHook()));
  // Test-only: lets a page fire a gesture or a hold as the keys would. Released
  // builds leave it unregistered so no page script can turn the mic on, unless
  // QA set OPENLIVE_QA_KEYS by hand.
  if (!app.isPackaged || QA_KEYS) ipcMain.handle("openlive:flow-trigger", guard((id, pressed) => load().triggerExternal(id, pressed)));

  ipcMain.handle("openlive:flow-insert", guard((text, method, timing) => load().insertText(text, method, insertionTiming(timing))));
  // OpenLive's own window takes Dictate's words from Electron itself: no system
  // events, so no Accessibility tree, clipboard or posted keys are involved, and
  // its own fields work the same on every platform. A session keeps the window it began in.
  // With nothing there to type into it fails, so the caller copies instead, as it does for other apps.
  ipcMain.handle("openlive:flow-insert-begin", guard(async (method, timing) => {
    const own = ownField();
    if (!own) return load().beginInsertion(method, insertionTiming(timing));
    if (!(await own.executeJavaScript(OWN_EDITABLE, true))) throw new Error("No text box in focus.");
    ownSessions.set(++ownSession, own);
    return ownSession;
  }));
  ipcMain.handle("openlive:flow-insert-push", guard((session, chunk) => {
    const own = ownSessions.get(session);
    return own ? own.insertText(String(chunk)) : load().pushInsertion(session, chunk);
  }));
  ipcMain.handle("openlive:flow-insert-end", guard((session) => (ownSessions.delete(session) ? undefined : load().endInsertion(session))));
  // Dictate's spoken commands and command mode: a key chord, and the selection read by copying it.
  ipcMain.handle("openlive:flow-keys", guard((keys, times) => load().keypress((Array.isArray(keys) ? keys : []).map(String), Number.isInteger(times) ? times : undefined)));
  // Dictate's edit by voice: the selection through the accessibility API only, never a copy.
  ipcMain.handle("openlive:flow-accessible-selection", guard(() => {
    const own = ownField();
    return own ? own.executeJavaScript(OWN_SELECTION, true) : load().accessibleSelection();
  }));
  ipcMain.handle("openlive:flow-focus-editable", guard(() => {
    const own = ownField();
    return own ? own.executeJavaScript(OWN_EDITABLE, true) : load().focusEditable();
  }));

  ipcMain.handle("openlive:flow-secure-input", guard(() => load().secureInputStatus()));
  ipcMain.handle("openlive:flow-hook-error", guard(() => hookFailure()));
  ipcMain.handle("openlive:flow-fn-usage", guard(fnUsage));

  // will-quit, not before-quit: ⌘Q only closes to the menu bar now, and that
  // cancelled quit still fires before-quit, which left Flow with no key listener.
  app.on("will-quit", teardown);
}

module.exports = { FLOW_BINDING, DICTATE_BINDING, PTT_BINDING, install, teardown, load, setArmed, isArmed, setBindings, binding, watched, readiness, hookReadiness, request, hookFailure, insertionTiming };
