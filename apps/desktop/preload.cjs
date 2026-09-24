"use strict";
// contextIsolation is on. Expose ONLY the small, explicit bridge the UI needs:
// window controls (the window is frameless), Flow and its orb window, and the
// OS bridge for agent tools (clipboard / open URL).
const { contextBridge, ipcRenderer } = require("electron");

let settingsCb = null;
let settingsAsked = false;
ipcRenderer.on("openlive:open-settings", () => { if (settingsCb) settingsCb(); else settingsAsked = true; });

/** Replace-on-subscribe, returning the way to let go again: a renderer that
 *  unmounts must not leave its handler behind for the next one to trip over. */
const listen = (channel, cb) => {
  ipcRenderer.removeAllListeners(channel);
  const fn = (_e, v) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld("openlive", {
  platform: process.platform,
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
  // Settings → General: launch-at-login (boolean sets, undefined reads).
  loginItem: (v) => ipcRenderer.invoke("openlive:login-item", v),
  // Settings → Models: an Ollama address off this computer. Main asks in a native
  // dialog and writes it itself. Resolves to { settings } | { cancelled } | { error }.
  confirmOllamaUrl: (url) => ipcRenderer.invoke("openlive:confirm-ollama-url", url),
  // True when running inside the desktop app.
  isDesktop: true,
  // App version, passed from main via additionalArguments (set from the release tag).
  version: (process.argv.find((a) => a.startsWith("--openlive-version=")) || "").split("=")[1] || "",
  // Per-launch auth token for the local agent WS (packaged builds only; empty in
  // dev). liveClient appends it as ?token= — a bare browser WebSocket can't set
  // headers, so the query param is the only channel.
  agentToken: (process.argv.find((a) => a.startsWith("--openlive-agent-token=")) || "").split("=")[1] || "",
  // The local agent's port. Chosen at launch (47823 unless something else holds
  // it), so the web build can't bake it in; 0 in windows that never get it.
  agentPort: Number((process.argv.find((a) => a.startsWith("--openlive-agent-port=")) || "").split("=")[1]) || 0,
  // The bound project folder — main scopes the agent's reveal/open file ops to it.
  setWorkspace: (dir) => ipcRenderer.send("openlive:workspace", dir),
  // System sleep/wake. "suspend" → pause the mic/VAD cleanly; "resume" → offer
  // reconnect. Same replace-on-subscribe rule as the other handlers.
  onPower: (cb) => listen("openlive:power", cb),
  // The native menu (⌘,) asks the UI to open Settings. Single listener, same
  // replace-on-subscribe rule as the handlers below: the renderer re-subscribes on
  // every remount (and on every hot reload in dev), so a plain `.on` stacked a new
  // listener each time until Electron warned about a leak and ⌘, fired N times.
  // An ask that lands before the page subscribes (the tray's Settings… on a window
  // it just opened) is held until it does.
  onOpenSettings: (cb) => { settingsCb = cb; if (settingsAsked) { settingsAsked = false; cb(); } },
  // Orb bridge. Flow's owner renderer publishes state; the orb window renders it
  // and sends control commands back. Single listener each, same
  // replace-on-subscribe rule as above.
  panelState: (s) => ipcRenderer.send("openlive:panel-state", s),
  onPanelState: (cb) => { ipcRenderer.removeAllListeners("openlive:panel-state"); ipcRenderer.on("openlive:panel-state", (_e, s) => cb(s)); },
  panelCmd: (c) => ipcRenderer.send("openlive:panel-cmd", c),
  onPanelCmd: (cb) => listen("openlive:panel-cmd", cb),
  // A live call, for the orb while the main window is minimised or hidden: the
  // main window publishes it (null when it ends), the orb shows it and sends
  // mute / end / expand back.
  callState: (s) => ipcRenderer.send("openlive:call-state", s),
  onCallOrb: (cb) => { ipcRenderer.removeAllListeners("openlive:call-orb"); ipcRenderer.on("openlive:call-orb", (_e, s) => cb(s)); },
  callCmd: (c) => ipcRenderer.send("openlive:call-cmd", c),
  // Flow's native input addon (global hold-to-talk hook + text insertion).
  // Every call resolves to { ok, value } or { ok: false, error } — a failure
  // in Rust is a value here, never a throw. `init` is what asks for
  // Accessibility, so only onboarding may call it.
  flow: {
    init: () => ipcRenderer.invoke("openlive:flow-init"),
    permissions: () => ipcRenderer.invoke("openlive:flow-permissions"),
    request: (what) => ipcRenderer.invoke("openlive:flow-request", what),
    register: (id, binding) => ipcRenderer.invoke("openlive:flow-register", id, binding),
    unregister: (id) => ipcRenderer.invoke("openlive:flow-unregister", id),
    suspend: () => ipcRenderer.invoke("openlive:flow-suspend"),
    resume: () => ipcRenderer.invoke("openlive:flow-resume"),
    trigger: (id, pressed) => ipcRenderer.invoke("openlive:flow-trigger", id, pressed),
    closed: () => ipcRenderer.invoke("openlive:flow-closed"),
    insert: (text, method) => ipcRenderer.invoke("openlive:flow-insert", text, method),
    insertBegin: (method) => ipcRenderer.invoke("openlive:flow-insert-begin", method),
    insertPush: (session, chunk) => ipcRenderer.invoke("openlive:flow-insert-push", session, chunk),
    insertEnd: (session) => ipcRenderer.invoke("openlive:flow-insert-end", session),
    secureInput: () => ipcRenderer.invoke("openlive:flow-secure-input"),
    hookError: () => ipcRenderer.invoke("openlive:flow-hook-error"),
    // What the user is looking at, whether this is a moment to speak out loud, and
    // what this platform can honestly do. Same { ok, value } shape as above.
    context: () => ipcRenderer.invoke("openlive:flow-context"),
    signals: () => ipcRenderer.invoke("openlive:flow-signals"),
    capabilities: () => ipcRenderer.invoke("openlive:flow-capabilities"),
    // One perception or control call into the addon, named by `fn`. Everything
    // but a camera frame is answered here; the camera never reaches main.
    device: (fn, args) => ipcRenderer.invoke("openlive:flow-device", fn, args),
    // Pay for loading the OS text recogniser at launch instead of on the first
    // real question about the screen.
    warmOcr: () => ipcRenderer.invoke("openlive:flow-warm-ocr"),
    // The orb: docked bottom-centre above the dock, summoned by the gesture and
    // gone on the gesture again. The window never resizes; only its content moves.
    summon: () => ipcRenderer.send("openlive:flow-summon"),
    dismiss: () => ipcRenderer.send("openlive:flow-dismiss"),
    // Closing: the main process asks, the orb plays its exit, then answers.
    onHiding: (cb) => { ipcRenderer.removeAllListeners("openlive:flow-hiding"); ipcRenderer.on("openlive:flow-hiding", () => cb()); },
    hidden: () => ipcRenderer.send("openlive:flow-hidden"),
    // Whether the orb window should take clicks at all. Off by default: it is
    // mostly empty air over the dock, and it must not swallow what lands there.
    interactive: (on) => ipcRenderer.send("openlive:flow-interactive", !!on),
    // The window was just shown, so its mouse state went back to click-through.
    onShown: (cb) => { ipcRenderer.removeAllListeners("openlive:flow-shown"); ipcRenderer.on("openlive:flow-shown", () => cb()); },
    visible: () => ipcRenderer.invoke("openlive:flow-visible"),
    // The orb's full-screen control: bring OpenLive up, on Flow, or on the
    // settings page `to` names ("models-settings", "flow-settings", ...).
    expand: (to) => ipcRenderer.send("openlive:flow-expand", /^[a-z]+-settings$/.test(to) ? to : ""),
    onShow: (cb) => listen("openlive:flow-show", (to) => cb(to || "")),
    // Continue an archived session: the main window asks, the owner renderer (the
    // only one holding the Flow socket) does it, so this has to cross windows.
    resumeSession: (sessionId) => ipcRenderer.send("openlive:flow-resume-session", sessionId),
    onResumeSession: (cb) => listen("openlive:flow-resume-session", cb),
    // The tray's "New Flow session" while Flow is open: the gesture would close it.
    onNewSession: (cb) => listen("openlive:flow-new-session", () => cb()),
    // Flow's settings were written. The owner renderer holds the registration and
    // the auto-quiet rules, so it has to be told or every change needs a relaunch.
    settingsChanged: () => ipcRenderer.send("openlive:flow-settings-changed"),
    onSettingsChanged: (cb) => listen("openlive:flow-settings-changed", () => cb()),
    // The tray's quick disarm. Main owns the state (it suspends the hook itself)
    // and broadcasts it, so the tray, the orb and the Flow window never disagree.
    setArmed: (armed) => ipcRenderer.send("openlive:flow-armed", !!armed),
    onArmed: (cb) => listen("openlive:flow-armed", (v) => cb(!!v)),
    // Single listener each, same replace-on-subscribe rule as the handlers above.
    onEffect: (cb) => listen("openlive:flow-effect", cb),
    onSecureInput: (cb) => listen("openlive:flow-secure-input", cb),
  },
});
