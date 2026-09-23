"use strict";
// The pointer, while Flow is the one holding it.
//
// The machine has exactly one cursor, and during a device action Flow is
// moving it. So this does not invent a second pointer that could drift from
// the first: it draws a halo around where the real pointer actually is,
// sampled from the OS every frame, and the arrow it paints there is the one
// the eye follows. The two cannot disagree, because there is only one
// position and both are read from it.
//
// The window is transparent, click-through, above everything, and hidden from
// screen capture, so the agent never photographs its own cursor and mistakes
// it for something on screen.
const path = require("node:path");
const { BrowserWindow, screen, systemPreferences } = require("electron");

/** The sample rate the native glide posts at, so the halo lands on every step. */
const FRAME_MS = 8;
/** How long the halo lingers after the last action. Long enough to cover the
 *  brain thinking between two steps, so a multi-step run reads as one piece of
 *  work rather than the overlay blinking on and off through it. */
const LINGER_MS = 2_000;

let win = null;
let timer = null;
let hideAt = 0;
/** The overlay's top-left on the desktop. Every point sent to the renderer is
 *  relative to it, and it only changes when the displays do. */
let origin = { x: 0, y: 0 };
/** Actions can overlap when a drag is still finishing as the next call starts. */
let running = 0;
/** The page is loaded and listening. Before that a message would be sent into
 *  a window that has no handlers yet, and the first action of a session is
 *  exactly when that happens. */
let ready = false;
let pending = null;

const reducedMotion = () => {
  try { return systemPreferences.getAnimationSettings().prefersReducedMotion === true; }
  catch { return false; }
};

/** The whole desktop as one rectangle, so a glide that crosses displays is not
 *  clipped halfway and no second window has to exist to catch it. */
function desktopBounds() {
  const all = screen.getAllDisplays();
  const left = Math.min(...all.map((d) => d.bounds.x));
  const top = Math.min(...all.map((d) => d.bounds.y));
  return {
    x: left,
    y: top,
    width: Math.max(...all.map((d) => d.bounds.x + d.bounds.width)) - left,
    height: Math.max(...all.map((d) => d.bounds.y + d.bounds.height)) - top,
  };
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    ...desktopBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "flow-cursor-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    },
  });
  // Nothing here is a target: every click belongs to whatever is underneath.
  win.setIgnoreMouseEvents(true, { forward: false });
  win.setAlwaysOnTop(true, "screen-saver", 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // macOS and Windows honour this by leaving the window out of every capture,
  // which is what keeps the agent from photographing its own cursor. X11 has
  // no equivalent, so there the halo is simply part of what it sees.
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, "flow-cursor.html"));
  origin = { x: win.getBounds().x, y: win.getBounds().y };
  win.webContents.once("did-finish-load", () => {
    ready = true;
    if (pending) { send("cursor:aim", pending); pending = null; }
  });
  win.on("closed", () => { win = null; ready = false; pending = null; });
  return win;
}

/** A display was plugged in, unplugged or rearranged under a window that
 *  claims to be the whole desktop. */
function refit() {
  if (!win || win.isDestroyed()) return;
  const bounds = desktopBounds();
  win.setBounds(bounds);
  origin = { x: bounds.x, y: bounds.y };
}

const send = (channel, payload) => {
  if (ready && win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

/** Read the pointer and hand it to the renderer in that window's own pixels. */
function follow() {
  if (!win || win.isDestroyed()) { stop(); return; }
  const point = screen.getCursorScreenPoint();
  send("cursor:at", { x: point.x - origin.x, y: point.y - origin.y });
  if (running === 0 && Date.now() >= hideAt) stop();
}

function start() {
  if (timer) return;
  timer = setInterval(follow, FRAME_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (win && !win.isDestroyed()) win.hide();
}

/**
 * A point from the addon, in the window coordinates this overlay draws in.
 *
 * The addon speaks the platform's own screen coordinates, which on a scaled
 * Windows display are physical pixels while every Electron window is measured
 * in device-independent ones. macOS and X11 already agree, and there the
 * conversion is not offered and not needed.
 */
function toWindow(point) {
  const dip = typeof screen.screenToDipPoint === "function"
    ? screen.screenToDipPoint({ x: point.x, y: point.y })
    : point;
  return { x: dip.x - origin.x, y: dip.y - origin.y };
}

/** Where an action is headed, in screen coordinates, or null when it is not
 *  the kind of action that goes anywhere. */
function destination(action) {
  switch (action?.kind) {
    case "move": case "click": case "mouse_down": case "mouse_up": case "scroll":
      return action.point ?? null;
    case "drag":
      return action.path?.[action.path.length - 1] ?? null;
    default:
      return null;
  }
}

/** Actions with nowhere to go that are still Flow working the machine. Typing
 *  is most of what a run of actions actually is, and showing nothing through it
 *  reads as Flow having stopped. */
const KEYBOARD = new Set(["type", "keypress"]);

/**
 * Show the pointer working, for as long as the action it was given runs.
 *
 * Returns the call that ends it. Typing has nowhere to go, so it shows the
 * halo where the pointer already is and nothing that claims to aim. A window
 * command shows nothing at all rather than flashing at whatever the pointer
 * happened to be sitting on.
 */
function begin(action) {
  const target = destination(action);
  const keyboard = KEYBOARD.has(action?.kind);
  if (!target && !keyboard) return () => {};

  const overlay = ensureWindow();
  running += 1;
  hideAt = Date.now() + LINGER_MS;
  const aim = {
    ...(target ? toWindow(target) : {}),
    kind: action.kind,
    button: action.button ?? "left",
    count: action.count ?? 1,
    reducedMotion: reducedMotion(),
  };
  if (ready) send("cursor:aim", aim); else pending = aim;
  // `showInactive` so the app the pointer is about to click keeps its focus:
  // a window that steals focus to draw a cursor would change what the click
  // then lands on.
  if (!overlay.isVisible()) overlay.showInactive();
  start();

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    running = Math.max(0, running - 1);
    hideAt = Date.now() + LINGER_MS;
    send("cursor:done", null);
  };
}

function install() {
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
    screen.on(event, refit);
  }
  // Built now rather than on the first action, because a window still loading
  // cannot draw: the halo would miss the whole of the first thing Flow ever
  // does, which is the one everybody is watching for.
  ensureWindow();
}

function dispose() {
  stop();
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  ready = false;
  pending = null;
  running = 0;
}

module.exports = { install, begin, dispose };
