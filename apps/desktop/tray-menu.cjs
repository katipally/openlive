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

const KEYS = {
  darwin: { ctrl: "⌃", control: "⌃", option: "⌥", opt: "⌥", alt: "⌥", shift: "⇧", command: "⌘", cmd: "⌘", meta: "⌘", super: "⌘", win: "⌘", fn: "fn" },
  win32: { ctrl: "Ctrl", control: "Ctrl", option: "Alt", opt: "Alt", alt: "Alt", shift: "Shift", command: "Win", cmd: "Win", meta: "Win", super: "Win", win: "Win", fn: "Fn" },
  linux: { ctrl: "Ctrl", control: "Ctrl", option: "Alt", opt: "Alt", alt: "Alt", shift: "Shift", command: "Super", cmd: "Super", meta: "Super", super: "Super", win: "Super", fn: "Fn" },
};

/** Flow's gesture as this platform writes keys: two quick taps of the
 *  registered binding (ol-input's grammar, e.g. "ctrl" or "ctrl_right+shift").
 *  Empty while nothing is registered. */
function hotkeyLabel(binding, platform) {
  if (!binding) return "";
  const names = KEYS[platform] ?? KEYS.linux;
  const keys = String(binding).split("+").map((part) => {
    const [, name, side] = /^(.+?)(?:_(left|right))?$/.exec(part);
    const key = names[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
    return side ? `${side === "left" ? "Left" : "Right"} ${key}` : key;
  });
  return `Double-tap ${keys.join(platform === "darwin" ? "" : "+")}`;
}

/** The status line: plain words, and the gesture while it would work. */
function statusLine({ readiness, open, binding, platform }) {
  const state = readiness === "ready" && open ? "open" : readiness;
  const hotkey = readiness === "ready" ? hotkeyLabel(binding, platform) : "";
  return [STATUS[state] ?? STATUS.off, hotkey].filter(Boolean).join("  ·  ");
}

/** `act` holds the click handlers: open, startFlow, allowAccess, settings, quit. */
function trayTemplate(state, act) {
  return [
    // Flow runs with no window at all, so the menu bar is the only place its
    // state is always visible.
    { label: statusLine(state), enabled: false },
    { type: "separator" },
    // Always enabled: `isVisible()` stays true for a window that's merely BEHIND
    // another app, so gating on it would grey out the one control that brings
    // OpenLive forward, the commonest reason to reach for the tray at all.
    { label: "Open OpenLive", click: act.open },
    // Enabled only when a double tap would work; the status line says why not.
    // Electron cannot show a double tap as an accelerator, so the status line carries it.
    { label: "Start Flow", enabled: state.readiness === "ready", click: act.startFlow },
    // The one state the menu can fix in place.
    ...(state.readiness === "access" ? [{ label: state.platform === "darwin" ? "Allow Accessibility…" : "Allow input access…", click: act.allowAccess }] : []),
    { label: "Settings…", accelerator: "CmdOrCtrl+,", click: act.settings },
    { type: "separator" },
    // No accelerator: ⌘Q and Ctrl+Q close to the menu bar, and only this item quits.
    { label: "Quit OpenLive", click: act.quit },
  ];
}

module.exports = { trayTemplate, statusLine, hotkeyLabel, STATUS };
