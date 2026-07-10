"use strict";
// OpenLive desktop shell. Runs the web (Next) + agent (ws) servers locally and
// shows the UI in a native window. Everything is on localhost — the voice models
// run in the renderer (Chromium/WebGPU), the LLM call goes out from the agent.
const { app, BrowserWindow, Menu, session, shell, dialog, desktopCapturer, ipcMain, screen } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");

// Crash early, loud, and visible instead of dying silently.
process.on("uncaughtException", (e) => { console.error("[main] uncaught:", e); });
process.on("unhandledRejection", (e) => { console.error("[main] unhandled rejection:", e); });

// The on-device voice models (Whisper STT, Kokoro TTS) run on WebGPU. If it's
// unavailable the app falls back to CPU/WASM, which is several times slower and
// makes the conversation feel laggy. Expose WebGPU + don't let a blocklisted GPU
// silently drop us to software. Must be set before app is ready.
app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("enable-features", "WebGPU");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

const DEV = process.env.ELECTRON_DEV === "1";
const AGENT_PORT = 47823;      // uncommon, baked into the web build's CSP/WS url
const WEB_PORT = Number(process.env.WEB_PORT) || (DEV ? 3000 : 47824);
// MUST be "localhost", not "127.0.0.1": Next dev's HMR websocket rejects a
// 127.0.0.1 origin (ERR_INVALID_HTTP_RESPONSE), and with Turbopack a dead HMR
// socket blocks hydration → the UI renders but nothing is clickable.
const WEB_HOST = "localhost";
const WEB_URL = `http://${WEB_HOST}:${WEB_PORT}`;
const DARK_BG = "#0b0b0c";

let mainWin = null;
let splashWin = null;
const children = [];

// ── single instance ─────────────────────────────────────────────────────────
// Dev runs under its own profile so it can coexist with an installed OpenLive.
// Sharing the app id + user-data dir means they fight over this lock, and dev
// would silently quit (exit 0) whenever the installed app is open.
if (DEV) app.setPath("userData", `${app.getPath("userData")}-dev`);
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on("second-instance", () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

// ── media (mic/camera) permissions — Electron blocks getUserMedia otherwise ──
function wirePermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media" || permission === "clipboard-read" || permission === "clipboard-sanitized-write");
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === "media");

  // Screen share: without a handler, getDisplayMedia() fails in Electron. Prefer
  // the native OS picker (lets the user choose a screen/window); fall back to the
  // primary screen so sharing always works.
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ["screen", "window"] })
      .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  }, { useSystemPicker: true });
}

// ── server processes (prod only; in dev they're started by `pnpm dev`) ───────
// If a server crashes while the app is running, respawn it (up to a few times in
// a short window) so a transient failure doesn't leave a dead, useless window.
const restarts = {}; // name → { count, first }
function spawnServer(name, scriptRel, env) {
  const script = path.join(process.resourcesPath, scriptRel);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    const i = children.indexOf(child); if (i >= 0) children.splice(i, 1);
    if (app.isQuitting || !code) return;
    console.error(`[${name}] exited with ${code}`);
    const r = (restarts[name] ||= { count: 0, first: Date.now() });
    if (Date.now() - r.first > 60000) { r.count = 0; r.first = Date.now(); } // reset the window
    if (++r.count > 5) {
      dialog.showErrorBox("OpenLive stopped", `The ${name} service keeps crashing. Please relaunch the app.`);
      return;
    }
    setTimeout(() => { if (!app.isQuitting) spawnServer(name, scriptRel, env); }, 500);
  });
  children.push(child);
  return child;
}

function startServers() {
  if (DEV) return; // dev servers come from `pnpm dev`
  const dataDir = path.join(app.getPath("userData"), "data");
  const secret = crypto.randomUUID();
  // Agent (internal): the renderer connects to it directly over ws on localhost.
  spawnServer("agent", "agent/agent.mjs", {
    AGENT_PORT: String(AGENT_PORT),
    OPENLIVE_DATA_DIR: dataDir,
    WEB_PUBLIC_URL: WEB_URL,
    // No OPENLIVE_AGENT_SECRET → the agent accepts the direct localhost socket.
  });
  // Web (Next standalone) serves the UI + the /api settings routes (JSON store).
  spawnServer("web", "web/server.js", {
    PORT: String(WEB_PORT),
    HOSTNAME: WEB_HOST,
    NODE_ENV: "production",
    OPENLIVE_DATA_DIR: dataDir,
    OPENLIVE_AGENT_SECRET: secret,
  });
}

// ── wait for the web server to answer before showing the window ──────────────
function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode > 0); });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}
async function waitForServers(timeoutMs = 60000) {
  const t0 = Date.now();
  const agentUrl = `http://localhost:${AGENT_PORT}`;
  let webOk = false, agentOk = false;
  while (Date.now() - t0 < timeoutMs) {
    if (!webOk) webOk = await ping(WEB_URL);
    if (!agentOk) agentOk = await ping(agentUrl);
    if (webOk && agentOk) return true;
    await new Promise((r) => setTimeout(r, 120)); // tight poll so the window shows the instant both are up
  }
  return false;
}

// ── window bounds: remember size/position across launches ─────────────────────
const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    // Only restore if the saved rect still lands on a connected display.
    const onScreen = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x >= b.x - 40 && s.y >= b.y - 40 && s.x < b.x + b.width - 40 && s.y < b.y + b.height - 40;
    });
    if (s.width > 400 && s.height > 300 && (s.x == null || onScreen)) return s;
  } catch { /* no saved state */ }
  return null;
}
function saveWindowState() {
  if (!mainWin || mainWin.isAlwaysOnTop()) return; // don't persist the floating-mini rect
  try { fs.writeFileSync(stateFile(), JSON.stringify(mainWin.getBounds())); } catch { /* best-effort */ }
}

// ── windows ──────────────────────────────────────────────────────────────────
function createSplash() {
  splashWin = new BrowserWindow({
    width: 420, height: 300, frame: false, resizable: false, movable: true,
    backgroundColor: DARK_BG, show: true, center: true, hasShadow: true,
    webPreferences: { contextIsolation: true },
  });
  splashWin.loadFile(path.join(__dirname, "splash.html"), { query: { v: app.getVersion() } });
  splashWin.on("closed", () => { splashWin = null; });
}

function createMainWindow() {
  const saved = loadWindowState();
  mainWin = new BrowserWindow({
    width: saved?.width || 1180, height: saved?.height || 800, minWidth: 940, minHeight: 640,
    ...(saved && saved.x != null ? { x: saved.x, y: saved.y } : {}),
    backgroundColor: DARK_BG, show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Hand the app version to the preload (app.* isn't reachable there).
      additionalArguments: [`--openlive-version=${app.getVersion()}`],
    },
  });
  for (const ev of ["resize", "move", "close"]) mainWin.on(ev, saveWindowState);

  // Open external links (docs, etc.) in the real browser, not the app window.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });

  mainWin.loadURL(WEB_URL);
  mainWin.once("ready-to-show", () => {
    mainWin.show();
    if (splashWin) splashWin.close();
    // DevTools available via View menu / Cmd+Opt+I — not auto-opened (it covered the UI).
  });
  mainWin.on("closed", () => { mainWin = null; });
}

// ── minimized (floating overlay) mode ───────────────────────────────────────
let savedBounds = null;
function positionFloating(w, h) {
  if (!mainWin) return;
  const area = screen.getDisplayMatching(mainWin.getBounds()).workArea;
  mainWin.setMinimumSize(Math.min(320, w), Math.min(80, h));
  mainWin.setBounds({ width: w, height: h, x: area.x + area.width - w - 24, y: area.y + area.height - h - 24 });
}
function wireMiniIpc() {
  ipcMain.on("openlive:mini", (_e, { width, height }) => {
    if (!mainWin) return;
    if (!savedBounds) savedBounds = mainWin.getBounds();
    mainWin.setResizable(false);
    positionFloating(width || 520, height || 120);
    mainWin.setAlwaysOnTop(true, "floating");
    mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (process.platform === "darwin" && mainWin.setWindowButtonVisibility) mainWin.setWindowButtonVisibility(false);
  });
  ipcMain.on("openlive:size", (_e, { width, height }) => {
    if (mainWin && mainWin.isAlwaysOnTop()) positionFloating(width || 520, height || 120);
  });
  ipcMain.on("openlive:unmini", () => {
    if (!mainWin) return;
    mainWin.setAlwaysOnTop(false);
    mainWin.setVisibleOnAllWorkspaces(false);
    mainWin.setResizable(true);
    mainWin.setMinimumSize(940, 640);
    if (savedBounds) { mainWin.setBounds(savedBounds); savedBounds = null; }
    if (process.platform === "darwin" && mainWin.setWindowButtonVisibility) mainWin.setWindowButtonVisibility(true);
  });
}

// ── application menu (About shows version, Cmd+, opens Settings) ──────────────
function buildMenu() {
  const isMac = process.platform === "darwin";
  const openSettings = () => mainWin && mainWin.webContents.send("openlive:open-settings");
  const template = [
    ...(isMac ? [{ role: "appMenu", submenu: [
      { role: "about", label: "About OpenLive" },
      { type: "separator" },
      { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings },
      { label: "Open at Login", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
        click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked }) },
      { type: "separator" },
      { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" }, { role: "quit" },
    ] }] : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "OpenLive on GitHub", click: () => shell.openExternal("https://github.com/katipally/openlive") },
      ...(isMac ? [] : [{ label: "Settings", accelerator: "CmdOrCtrl+,", click: openSettings },
                        { type: "separator" }, { role: "about", label: "About OpenLive" }]),
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({ applicationName: "OpenLive", applicationVersion: app.getVersion(), copyright: "© OpenLive" });
}

// ── auto-update (packaged prod only; needs the published latest*.yml) ─────────
function initAutoUpdate() {
  if (DEV || !app.isPackaged) return;
  let updater;
  try { ({ autoUpdater: updater } = require("electron-updater")); } catch { return; }
  updater.autoDownload = true;
  updater.on("update-downloaded", async ({ version }) => {
    const { response } = await dialog.showMessageBox(mainWin, {
      type: "info", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1,
      message: `OpenLive ${version} is ready`, detail: "Restart to finish updating.",
    });
    if (response === 0) { app.isQuitting = true; updater.quitAndInstall(); }
  });
  updater.on("error", (e) => console.error("[updater]", e?.message || e));
  updater.checkForUpdates().catch(() => {});
  setInterval(() => updater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000); // every 6h
}

async function boot() {
  buildMenu();
  wirePermissions();
  wireMiniIpc();
  createSplash();
  startServers();
  const ok = await waitForServers();
  if (!ok) {
    dialog.showErrorBox("OpenLive couldn't start", `The local servers didn't come up. Try relaunching.`);
    app.quit();
    return;
  }
  createMainWindow();
  initAutoUpdate();
}

app.whenReady().then(boot);

app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { app.isQuitting = true; for (const c of children) { try { c.kill(); } catch { /* */ } } });
