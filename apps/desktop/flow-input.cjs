"use strict";
// Owner of the ol-input native addon: it loads lazily, its lifecycle is tied
// to the app's, and everything it emits is forwarded to the renderer over IPC.
// Nothing here initialises the hook on its own: that call is what asks for
// Accessibility, and onboarding decides when the user sees that prompt.
const path = require("node:path");
const { app, ipcMain } = require("electron");

// macOS never reports a secure-input change, so it has to be polled.
const SECURE_INPUT_POLL_MS = 1000;

let addon = null;
let hooked = false;
let secureTimer = null;
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
  if (!hooked) {
    api.initializeHook((effect) => send("openlive:flow-effect", effect));
    hooked = true;
  }
  startSecureInputPoll();
  return api.permissionStatus();
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
  ipcMain.handle("openlive:flow-request", guard((what) => {
    const api = load();
    if (what === "accessibility") return api.requestAccessibility();
    if (what === "microphone") return api.requestMicrophone();
    if (what === "screen") return api.requestScreenRecording();
    throw new Error(`unknown permission "${what}"`);
  }));

  ipcMain.handle("openlive:flow-parse-binding", guard((b) => load().parseBinding(b)));
  ipcMain.handle("openlive:flow-register", guard((id, binding, activation, holdMs) =>
    load().registerBinding(id, binding, activation, holdMs)));
  ipcMain.handle("openlive:flow-unregister", guard((id) => load().unregisterBinding(id)));
  ipcMain.handle("openlive:flow-suspend", guard(() => load().suspendHook()));
  ipcMain.handle("openlive:flow-resume", guard(() => load().resumeHook()));
  ipcMain.handle("openlive:flow-trigger", guard((id, pressed) => load().triggerExternal(id, pressed)));
  ipcMain.handle("openlive:flow-processing-finished", guard(() => load().notifyProcessingFinished()));
  ipcMain.handle("openlive:flow-start-failed", guard(() => load().notifyStartFailed()));

  ipcMain.handle("openlive:flow-insert", guard((text, method) => load().insertText(text, method)));
  ipcMain.handle("openlive:flow-insert-begin", guard((method) => load().beginInsertion(method)));
  ipcMain.handle("openlive:flow-insert-push", guard((session, chunk) => load().pushInsertion(session, chunk)));
  ipcMain.handle("openlive:flow-insert-end", guard((session) => load().endInsertion(session)));

  ipcMain.handle("openlive:flow-secure-input", guard(() => load().secureInputStatus()));
  ipcMain.handle("openlive:flow-recording-refusal", guard(() => load().bindingRecordingRefusal()));
  ipcMain.handle("openlive:flow-hook-error", guard(() => load().hookError()));

  app.on("before-quit", teardown);
}

module.exports = { install, teardown };
