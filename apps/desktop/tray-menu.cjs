"use strict";
// The tray (menu bar) menu as data: what it says in each state and which action
// each item runs. main.cjs owns the state and the actions, and rebuilds the menu
// whenever what it would say changes.

/** Plain words for every state the menu can be in. */
const STATUS = {
  ready: "Flow is ready",
  open: "Flow is open",
  access: "Flow needs permission",
  stopped: "Flow stopped listening",
  off: "Flow is off",
};
const DICTATE = {
  on: "Dictate is on",
  off: "Dictate is off",
  access: "Dictate needs permission",
  stopped: "Dictate stopped listening",
};

const KEYS = {
  darwin: { ctrl: "⌃", control: "⌃", option: "⌥", opt: "⌥", alt: "⌥", shift: "⇧", command: "⌘", cmd: "⌘", meta: "⌘", super: "⌘", win: "⌘", fn: "fn" },
  win32: { ctrl: "Ctrl", control: "Ctrl", option: "Alt", opt: "Alt", alt: "Alt", shift: "Shift", command: "Win", cmd: "Win", meta: "Win", super: "Win", win: "Win", fn: "Fn" },
  linux: { ctrl: "Ctrl", control: "Ctrl", option: "Alt", opt: "Alt", alt: "Alt", shift: "Shift", command: "Super", cmd: "Super", meta: "Super", super: "Super", win: "Super", fn: "Fn" },
};

/** A binding (ol-input's grammar, e.g. "ctrl" or "ctrl_right+shift") as this platform writes keys. */
function keyNames(binding, platform) {
  const names = KEYS[platform] ?? KEYS.linux;
  const keys = String(binding).split("+").map((part) => {
    const [, name, side] = /^(.+?)(?:_(left|right))?$/.exec(part);
    const key = names[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
    return side ? `${side === "left" ? "Left" : "Right"} ${key}` : key;
  });
  return keys.join(platform === "darwin" ? "" : "+");
}

/** Flow's gesture: two quick taps of the registered binding. Empty while nothing is registered. */
function hotkeyLabel(binding, platform) {
  return binding ? `Double-tap ${keyNames(binding, platform)}` : "";
}

/** The status line: plain words, and the gesture while it would work. */
function statusLine({ readiness, open, binding, platform }) {
  const state = readiness === "ready" && open ? "open" : readiness;
  const hotkey = readiness === "ready" ? hotkeyLabel(binding, platform) : "";
  return [STATUS[state] ?? STATUS.off, hotkey].filter(Boolean).join("  ·  ");
}

/** Dictate's line. `dictate` is { on, binding } from its settings, null until read;
 *  `hook` is the key listener's own state, which Flow's off switch does not touch. */
function dictateLine({ dictate, hook, platform }) {
  if (!dictate?.on) return DICTATE.off;
  const state = hook === "ready" ? "on" : hook === "access" ? "access" : "stopped";
  const key = state === "on" && dictate.binding ? `Hold ${keyNames(dictate.binding, platform)}` : "";
  return [DICTATE[state], key].filter(Boolean).join("  ·  ");
}

/** `act` holds the click handlers: open, startFlow, flowOn, flowOff, dictateOn, dictateOff, allowAccess, settings, quit. */
function trayTemplate(state, act) {
  const dictateOn = !!state.dictate?.on;
  return [
    // Flow and Dictate run with no window at all, so the menu bar is the only
    // place their state is always visible.
    { label: statusLine(state), enabled: false },
    { label: dictateLine(state), enabled: false },
    { type: "separator" },
    // Always enabled: `isVisible()` stays true for a window that's merely BEHIND
    // another app, so gating on it would grey out the one control that brings
    // OpenLive forward, the commonest reason to reach for the tray at all.
    { label: "Open OpenLive", click: act.open },
    // Enabled only when a double tap would work; the status line says why not.
    // Electron cannot show a double tap as an accelerator, so the status line carries it.
    { label: "Start Flow", enabled: state.readiness === "ready", click: act.startFlow },
    // The same switches as Flow's and Dictate's homes.
    { label: state.armed ? "Turn Flow off" : "Turn Flow on", click: state.armed ? act.flowOff : act.flowOn },
    // Unknown until its settings are read.
    { label: dictateOn ? "Turn Dictate off" : "Turn Dictate on", enabled: !!state.dictate, click: dictateOn ? act.dictateOff : act.dictateOn },
    // The one state the menu can fix in place.
    ...(state.readiness === "access" || (dictateOn && state.hook === "access") ? [{ label: state.platform === "darwin" ? "Allow Accessibility…" : "Allow input access…", click: act.allowAccess }] : []),
    { label: "Settings…", accelerator: "CmdOrCtrl+,", click: act.settings },
    { type: "separator" },
    // No accelerator: ⌘Q and Ctrl+Q close to the menu bar, and only this item quits.
    { label: "Quit OpenLive", click: act.quit },
  ];
}

module.exports = { trayTemplate, statusLine, dictateLine, hotkeyLabel, STATUS, DICTATE };
