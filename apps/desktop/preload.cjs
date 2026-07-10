"use strict";
// contextIsolation is on. Expose ONLY the small, explicit bridge the UI needs:
// window controls (the window is frameless), the floating-overlay mini mode, and
// the OS bridge for agent tools (clipboard / open URL).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openlive", {
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
  // OS bridge for agent tools. op: "clipboard_read" | "clipboard_write" | "open_url".
  // Resolves to a short result string the agent speaks back.
  bridge: (op, arg) => ipcRenderer.invoke("openlive:bridge", { op, arg }),
  // True when running inside the desktop app.
  isDesktop: true,
  // App version, passed from main via additionalArguments (set from the release tag).
  version: (process.argv.find((a) => a.startsWith("--openlive-version=")) || "").split("=")[1] || "",
  // The native menu (⌘,) asks the UI to open Settings.
  onOpenSettings: (cb) => ipcRenderer.on("openlive:open-settings", () => cb()),
});
