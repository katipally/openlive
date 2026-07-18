"use strict";
// contextIsolation is on. Expose ONLY the small, explicit bridge the UI needs:
// window controls (the window is frameless), the floating-overlay mini mode, and
// the OS bridge for agent tools (clipboard / open URL).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openlive", {
  platform: process.platform,
  // Enter minimized mode: shrink to a small floating pill (always-on-top).
  mini: () => ipcRenderer.send("openlive:mini"),
  // Restore the normal window.
  unmini: () => ipcRenderer.send("openlive:unmini"),
  // Resize the pill to fit its content (previews stack inline above the pill and it
  // grows upward). The renderer measures its own height and passes it here.
  miniSize: (h) => ipcRenderer.send("openlive:mini-size", h),
  // Custom window controls — the window is frameless (no native traffic lights).
  winClose: () => ipcRenderer.send("openlive:win-close"),
  winMin: () => ipcRenderer.send("openlive:win-min"),
  winZoom: () => ipcRenderer.send("openlive:win-zoom"),
  winFullscreen: () => ipcRenderer.send("openlive:win-fullscreen"),
  // OS bridge for agent tools. op: "clipboard_read" | "clipboard_write" | "open_url".
  // Resolves to a short result string the agent speaks back.
  bridge: (op, arg) => ipcRenderer.invoke("openlive:bridge", { op, arg }),
  // OS notification — shown only when the app isn't focused (main decides).
  notify: (title, body) => ipcRenderer.send("openlive:notify", { title, body }),
  // Settings → General: launch-at-login (boolean sets, undefined reads) and the
  // configurable global mini-mode talk hotkey.
  loginItem: (v) => ipcRenderer.invoke("openlive:login-item", v),
  setMiniHotkey: (acc) => ipcRenderer.invoke("openlive:set-mini-hotkey", acc),
  // True when running inside the desktop app.
  isDesktop: true,
  // App version, passed from main via additionalArguments (set from the release tag).
  version: (process.argv.find((a) => a.startsWith("--openlive-version=")) || "").split("=")[1] || "",
  // Per-launch auth token for the local agent WS (packaged builds only; empty in
  // dev). liveClient appends it as ?token= — a bare browser WebSocket can't set
  // headers, so the query param is the only channel.
  agentToken: (process.argv.find((a) => a.startsWith("--openlive-agent-token=")) || "").split("=")[1] || "",
  // The bound project folder — main scopes the agent's reveal/open file ops to it.
  setWorkspace: (dir) => ipcRenderer.send("openlive:workspace", dir),
  // System sleep/wake. "suspend" → pause the mic/VAD cleanly; "resume" → offer
  // reconnect. Same replace-on-subscribe rule as the other handlers.
  onPower: (cb) => { ipcRenderer.removeAllListeners("openlive:power"); ipcRenderer.on("openlive:power", (_e, s) => cb(s)); },
  // Mini-mode state pushed by main (tray menu can enter/leave mini without the
  // renderer's involvement — it must follow, or the pill goes dead).
  onMinimized: (cb) => { ipcRenderer.removeAllListeners("openlive:minimized"); ipcRenderer.on("openlive:minimized", (_e, v) => cb(!!v)); },
  // The native menu (⌘,) asks the UI to open Settings. Single listener, same
  // replace-on-subscribe rule as the handlers below: the renderer re-subscribes on
  // every remount (and on every hot reload in dev), so a plain `.on` stacked a new
  // listener each time until Electron warned about a leak and ⌘, fired N times.
  onOpenSettings: (cb) => { ipcRenderer.removeAllListeners("openlive:open-settings"); ipcRenderer.on("openlive:open-settings", () => cb()); },
  // Global push-to-talk toggle (mini mode's Alt+Space). Single listener: each call
  // replaces the previous callback so remounts don't stack stale handlers.
  onPttToggle: (cb) => { ipcRenderer.removeAllListeners("openlive:ptt-toggle"); ipcRenderer.on("openlive:ptt-toggle", () => cb()); },
  // Mini-panel bridge. The main renderer (voice pipeline) publishes state; the panel
  // window renders it and sends control commands back. Single listener each, same
  // replace-on-subscribe rule as above.
  panelState: (s) => ipcRenderer.send("openlive:panel-state", s),
  onPanelState: (cb) => { ipcRenderer.removeAllListeners("openlive:panel-state"); ipcRenderer.on("openlive:panel-state", (_e, s) => cb(s)); },
  panelCmd: (c) => ipcRenderer.send("openlive:panel-cmd", c),
  onPanelCmd: (cb) => { ipcRenderer.removeAllListeners("openlive:panel-cmd"); ipcRenderer.on("openlive:panel-cmd", (_e, c) => cb(c)); },
});
