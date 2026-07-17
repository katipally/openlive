"use strict";
// OpenLive desktop shell. Runs the web (Next) + agent (ws) servers locally and
// shows the UI in a native window. Everything is on localhost — the voice models
// run in the renderer (Chromium/WebGPU), the LLM call goes out from the agent.
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, session, shell, dialog, desktopCapturer, ipcMain, screen, clipboard, globalShortcut } = require("electron");
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { powerMonitor } = require("electron");

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

// Per-launch auth token for the local agent. Loopback binding keeps remote
// attackers out, but any LOCAL process could otherwise open ws://localhost:47823
// and drive the agent. The token rides to the agent + web servers as
// OPENLIVE_AGENT_SECRET (both already honor it) and to the renderer via argv.
// Dev keeps the open no-secret path (servers come from `pnpm dev`).
const AGENT_TOKEN = DEV ? "" : crypto.randomBytes(24).toString("base64url");

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

// ── process-tree kill + port helpers (cross-platform) ────────────────────────
const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8" }); } catch { return ""; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Kill a child AND every descendant. POSIX: our children are spawned `detached`,
// so each is its own process-group leader and a negative pid signals the whole
// group (child + grandchildren). Windows has no groups → taskkill /T walks the tree.
function killTree(pid, sig = "SIGTERM") {
  if (!pid) return;
  if (process.platform === "win32") { sh(`taskkill ${sig === "SIGKILL" ? "/F " : ""}/T /PID ${pid}`); return; }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
}

// Who (if anyone) is LISTENING on `port`, and is it one of ours? "Ours" = a process
// running our own binary (prod servers run via ELECTRON_RUN_AS_NODE = our exe), so a
// leftover is safe to kill; anything else is a foreign app we must not touch.
function portHolder(port) {
  const mine = path.basename(process.execPath).toLowerCase();
  if (process.platform === "win32") {
    for (const line of sh("netstat -ano -p tcp").split("\n")) {
      const c = line.trim().split(/\s+/); // proto | local | foreign | state | pid
      if (c.length < 5 || c[3] !== "LISTENING" || !c[1].endsWith(`:${port}`)) continue;
      const pid = Number(c[4]); if (!pid || pid === process.pid) continue;
      const row = sh(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).toLowerCase();
      return { pid, name: (row.split(",")[0] || "").replace(/"/g, "").trim(), ours: row.includes(mine) };
    }
    return null;
  }
  for (const p of sh(`lsof -ti tcp:${port} -sTCP:LISTEN`).split("\n").filter(Boolean)) {
    const pid = Number(p); if (!pid || pid === process.pid) continue;
    const comm = sh(`ps -p ${pid} -o comm=`).trim();
    return { pid, name: path.basename(comm), ours: comm.toLowerCase().includes(mine) };
  }
  return null;
}

// True iff we can bind the loopback port right now (i.e. it's actually free).
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

// PIDs of the servers we spawned, persisted so the NEXT launch can reap them even
// if this process was force-killed (Windows especially: children outlive the parent).
const pidFile = () => path.join(app.getPath("userData"), "server-pids.json");
function recordServerPids() {
  try { fs.writeFileSync(pidFile(), JSON.stringify(children.map((c) => c.pid).filter(Boolean))); } catch { /* best-effort */ }
}
function reapRecordedPids() {
  let pids = [];
  try { pids = JSON.parse(fs.readFileSync(pidFile(), "utf8")); } catch { return; }
  for (const pid of pids) if (alive(pid)) { console.error(`[main] reaping stale server pid ${pid}`); killTree(pid, "SIGKILL"); }
  try { fs.rmSync(pidFile(), { force: true }); } catch { /* */ }
}

// Make both ports bindable before we spawn, or explain why we can't. Reap our own
// recorded zombies first; then, for anything still holding a port, kill it if it's
// ours and bail with ONE clear message if it's a foreign app (respawning can't fix
// that — issue #6's "web service keeps crashing" loop was exactly this case).
async function ensurePortsFree() {
  reapRecordedPids();
  for (const port of [AGENT_PORT, WEB_PORT]) {
    const h = portHolder(port);
    if (h && h.ours) { console.error(`[main] killing stale ${h.name} (pid ${h.pid}) on port ${port}`); killTree(h.pid, "SIGKILL"); }
    // Poll briefly: a just-SIGKILLed zombie's socket takes a beat to be released by
    // the kernel, and we don't want to mistake our own dying process for a foreign app.
    let free = false;
    for (let i = 0; i < 15 && !(free = await portFree(port)); i++) await new Promise((r) => setTimeout(r, 100));
    if (!free) {
      const who = portHolder(port);
      dialog.showErrorBox("OpenLive can't start",
        `Port ${port} is being used by another program${who?.name ? ` (${who.name})` : ""}. ` +
        `Close it and relaunch OpenLive.`);
      return false;
    }
  }
  return true;
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
    detached: process.platform !== "win32", // own process group → clean tree-kill on quit
    windowsHide: true,
  });
  child.on("exit", (code) => {
    const i = children.indexOf(child); if (i >= 0) children.splice(i, 1);
    recordServerPids();
    if (app.isQuitting || !code) return;
    console.error(`[${name}] exited with ${code}`);
    // A dead server whose port is now held by a FOREIGN app can't be fixed by
    // respawning — say so once instead of the 5×-crash loop.
    const port = name === "agent" ? AGENT_PORT : WEB_PORT;
    const h = portHolder(port);
    if (h && !h.ours) {
      dialog.showErrorBox("OpenLive can't start", `Port ${port} is being used by another program${h.name ? ` (${h.name})` : ""}. Close it and relaunch OpenLive.`);
      return;
    }
    const r = (restarts[name] ||= { count: 0, first: Date.now() });
    if (Date.now() - r.first > 60000) { r.count = 0; r.first = Date.now(); } // reset the window
    if (++r.count > 5) {
      dialog.showErrorBox("OpenLive stopped", `The ${name} service keeps crashing. Relaunch the app; if it keeps happening, check that nothing else is using ports ${AGENT_PORT} and ${WEB_PORT}, and please attach any console output to a GitHub issue.`);
      return;
    }
    setTimeout(() => { if (!app.isQuitting) spawnServer(name, scriptRel, env); }, 500);
  });
  children.push(child);
  recordServerPids();
  return child;
}

async function startServers() {
  if (DEV) return true; // dev servers come from `pnpm dev`
  if (!(await ensurePortsFree())) return false;
  const dataDir = path.join(app.getPath("userData"), "data");
  // The agent binds loopback only (services/agent/src/server.ts defaults AGENT_HOST
  // to 127.0.0.1), so it is never reachable off this machine. That closes the LAN
  // exposure by itself; the renderer connects over localhost.
  spawnServer("agent", "agent/agent.mjs", {
    AGENT_PORT: String(AGENT_PORT),
    AGENT_HOST: "127.0.0.1",
    OPENLIVE_DATA_DIR: dataDir,
    WEB_PUBLIC_URL: WEB_URL,
    OPENLIVE_AGENT_SECRET: AGENT_TOKEN,
  });
  // Web (Next standalone) serves the UI + the /api settings routes (JSON store).
  // AGENT_PORT: the /api/voice proxy forwards to the agent on localhost.
  spawnServer("web", "web/server.js", {
    PORT: String(WEB_PORT),
    HOSTNAME: WEB_HOST,
    NODE_ENV: "production",
    OPENLIVE_DATA_DIR: dataDir,
    AGENT_PORT: String(AGENT_PORT),
    OPENLIVE_AGENT_SECRET: AGENT_TOKEN, // the /api/voice proxy forwards it as a header
  });
  return true;
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
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  splashWin.loadFile(path.join(__dirname, "splash.html"), { query: { v: app.getVersion() } });
  splashWin.on("closed", () => { splashWin = null; });
}

function createMainWindow() {
  const saved = loadWindowState();
  mainWin = new BrowserWindow({
    width: saved?.width || 1180, height: saved?.height || 800, minWidth: 940, minHeight: 640,
    ...(saved && saved.x != null ? { x: saved.x, y: saved.y } : {}),
    show: false,
    // Frameless + OPAQUE. We draw our own window controls (WindowControls.tsx) and
    // drag strip in CSS. NOT transparent: transparent windows take a slower macOS
    // compositing path that competes with the on-device WebGPU voice models (adds
    // turn latency) and rendered as a black wall on some GPUs. Mini mode hides this
    // window (renderer keeps running the voice pipeline) and shows the separate
    // panel window below. macOS rounds the frameless window natively (roundedCorners).
    frame: false,
    roundedCorners: true,
    backgroundColor: DARK_BG,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer runs untrusted-adjacent content (model-authored HTML renders
      // in-origin) — keep it in the Chromium sandbox. The preload only uses
      // contextBridge/ipcRenderer, which are available in sandboxed preloads.
      sandbox: true,
      // Mini mode HIDES this window while its renderer keeps running the whole voice
      // pipeline — throttled timers would wreck turn-taking (hold timers, TTS drain).
      backgroundThrottling: false,
      // Hand the app version to the preload (app.* isn't reachable there). Released
      // builds show the tag version (CI stamps it); unpackaged dev builds get a
      // "-dev" suffix so it's obvious you're not on a release.
      additionalArguments: [
        `--openlive-version=${app.isPackaged ? app.getVersion() : `${app.getVersion()}-dev`}`,
        // Only this window runs the voice pipeline / live socket; the mini panel
        // is a display-only relay and never needs the token.
        ...(AGENT_TOKEN ? [`--openlive-agent-token=${AGENT_TOKEN}`] : []),
      ],
    },
  });
  for (const ev of ["resize", "move", "close"]) mainWin.on(ev, saveWindowState);

  // Open external http(s) links (docs, etc.) in the real browser; DENY every other
  // popup (file:, data:, etc.) rather than letting it open an in-app window.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Keep the main frame pinned to our own UI: an in-page navigation to anywhere
  // other than the local app is blocked (http(s) is handed to the real browser).
  mainWin.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(WEB_URL)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWin.loadURL(WEB_URL);
  mainWin.once("ready-to-show", () => {
    mainWin.show();
    if (splashWin) splashWin.close();
    refreshTray();
    // DevTools available via View menu / Cmd+Opt+I — not auto-opened (it covered the UI).
  });
  // Closing does NOT quit on macOS — the app lives on in the tray, so the tray menu
  // has to re-read this (its "Open OpenLive" is now the only way back).
  mainWin.on("closed", () => { mainWin = null; refreshTray(); });
  for (const ev of ["show", "hide"]) mainWin.on(ev, refreshTray);
}

// ── minimized (floating panel) mode ──────────────────────────────────────────
// Mini mode HIDES the main window (its renderer keeps running the voice pipeline —
// backgroundThrottling is off) and shows a separate thin PANEL window with the pill
// UI. The panel is non-activating (clicking it never steals focus from the app
// you're working in), floats above fullscreen apps, and lives on every Space.
// State flows main-renderer → main process → panel; commands flow back the same
// way (a MediaStream can't cross windows, so previews arrive as ~1 fps JPEGs).
const PILL_W = 430, PILL_H = 56;
let panelWin = null;

function miniDisplay() {
  return screen.getDisplayMatching(mainWin ? mainWin.getBounds() : { x: 0, y: 0, width: 0, height: 0 });
}
function pillBottom(area) { return area.y + area.height - 72; } // clear the dock

function createPanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); return; }
  const area = miniDisplay().workArea;
  panelWin = new BrowserWindow({
    width: PILL_W, height: PILL_H,
    x: area.x + Math.round((area.width - PILL_W) / 2), y: pillBottom(area) - PILL_H,
    show: false, frame: false, resizable: false, skipTaskbar: true,
    roundedCorners: true, backgroundColor: DARK_BG,
    // macOS: a "panel"-type window is non-activating — clicks land on its buttons
    // without pulling focus away from whatever app the user is working in.
    ...(process.platform === "darwin" ? { type: "panel", focusable: false } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  panelWin.setAlwaysOnTop(true, "floating", 1);
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  panelWin.loadURL(`${WEB_URL}/mini`);
  panelWin.once("ready-to-show", () => { if (panelWin) panelWin.showInactive(); });
  panelWin.on("closed", () => { panelWin = null; });
}

// The global mini-mode talk hotkey. Configurable from Settings → General; kept in
// memory here (the renderer persists it and re-sends on each mini entry).
// globalShortcut has no keyup, so it's always a press-to-TOGGLE.
let miniHotkey = "Alt+Space";

// Module-scope so BOTH enterMini() and the set-mini-hotkey IPC handler can arm it.
// (It used to be declared inside wireMiniIpc(), so enterMini()'s call threw a
// swallowed ReferenceError → the "Alt+Space from anywhere" hotkey never armed.)
function registerMiniHotkey() {
  try {
    globalShortcut.unregisterAll();
    return globalShortcut.register(miniHotkey, () => { if (mainWin) mainWin.webContents.send("openlive:ptt-toggle"); });
  } catch { return false; }
}

// NOTE on `!mainWin`: closing the window does NOT quit on macOS (window-all-closed
// only quits elsewhere) — the app stays alive in the tray with mainWin === null.
// Both entry points below used to bail in that state, which left the tray icon a
// dead stub: "Open OpenLive" and "Mini mode" silently did nothing and only Quit
// worked. Recreating the window is the whole point of a tray icon, so they do.

/** Enter mini mode: spawn the always-on-top panel, hide the main window, arm the
 *  global talk hotkey. Shared by the minimize button (IPC) and the tray menu.
 *  `fromRenderer` suppresses the state echo: the renderer already knows about
 *  transitions IT started, and echoing them back closed a feedback loop with
 *  React StrictMode's mount→unmount→remount (each echo flipped the store, each
 *  flip re-fired mini/unmini → the panel window recreated in a tight loop). */
function enterMini(fromRenderer = false) {
  // Mini mode runs the voice pipeline in the MAIN renderer and only hides its
  // window, so it needs that window to exist before there's anything to minimise.
  if (!mainWin) {
    createMainWindow();
    mainWin.once("ready-to-show", () => enterMini(fromRenderer));
    return;
  }
  const apply = () => {
    if (!mainWin) return;
    createPanelWindow();
    mainWin.hide();
    // TRAY path only: tell the renderer it's minimized, so its panel bridge
    // mounts (otherwise every pill button is dead — no end/expand/camera).
    if (!fromRenderer) mainWin.webContents.send("openlive:minimized", true);
    refreshTray();
  };
  // Leaving fullscreen first: hiding a fullscreen window strands an empty Space.
  if (mainWin.isFullScreen() || mainWin.isSimpleFullScreen()) {
    mainWin.once("leave-full-screen", apply);
    mainWin.setFullScreen(false);
  } else apply();
  // Global push-to-talk while the panel is up: talk to the agent from any app.
  registerMiniHotkey();
}

/** Leave mini mode / bring the app forward. Shared by IPC, the tray menu, and
 *  notification clicks. */
function restoreMainWindow(fromRenderer = false) {
  globalShortcut.unregisterAll();
  if (panelWin && !panelWin.isDestroyed()) panelWin.destroy();
  panelWin = null;
  if (!mainWin) { createMainWindow(); return; } // its ready-to-show shows + refreshes
  if (mainWin.isMinimized()) mainWin.restore(); // show() alone leaves it in the Dock
  // TRAY/notification path only — see enterMini for why renderer-initiated
  // transitions must NOT be echoed back.
  if (!fromRenderer) mainWin.webContents.send("openlive:minimized", false);
  mainWin.show();
  mainWin.focus();
  app.focus({ steal: true }); // tray clicks don't activate the app on macOS
  refreshTray();
}

// ── menu-bar (tray) presence + notifications ─────────────────────────────────
let tray = null;

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")).resize({ height: 18 });
    tray = new Tray(img);
    tray.setToolTip("OpenLive");
    refreshTray();
  } catch (e) { console.error("[main] tray:", e); } // no tray beats no app
}

/** Rebuild the tray menu against the CURRENT state. It used to be built once at
 *  boot and then quietly lie — "Mini mode" looked identical whether you were in it
 *  or not, so the one control that tells you where you are told you nothing. Mini
 *  is a checkbox because it's a mode you're in or out of, not an action. */
function refreshTray() {
  if (!tray) return;
  const mini = !!(panelWin && !panelWin.isDestroyed());
  tray.setContextMenu(Menu.buildFromTemplate([
    // Always enabled: `isVisible()` stays true for a window that's merely BEHIND
    // another app, so gating on it would grey out the one control that brings
    // OpenLive forward — the commonest reason to reach for the tray at all.
    { label: "Open OpenLive", click: restoreMainWindow },
    { label: "Mini mode", type: "checkbox", checked: mini, click: () => (mini ? restoreMainWindow() : enterMini()) },
    { type: "separator" },
    { label: "Quit OpenLive", role: "quit" },
  ]));
}

function wireNotifyIpc() {
  // Renderer asks for an OS notification ("agent finished", "permission needed").
  // Only shown when the user ISN'T looking at the app — focused-and-visible means
  // they already see it. Clicking brings OpenLive forward (also out of mini mode).
  ipcMain.on("openlive:notify", (_e, p) => {
    const title = String(p?.title ?? "").slice(0, 80);
    if (!title || !Notification.isSupported()) return;
    if (mainWin && mainWin.isVisible() && mainWin.isFocused()) return;
    const n = new Notification({ title, body: String(p?.body ?? "").slice(0, 180), silent: true });
    n.on("click", restoreMainWindow);
    n.show();
  });
}

function wireMiniIpc() {
  // Change the hotkey (Settings → General). Re-registers live if the panel is up;
  // an invalid/taken accelerator falls back to the previous one and reports it.
  ipcMain.handle("openlive:set-mini-hotkey", (_e, acc) => {
    const prev = miniHotkey;
    miniHotkey = String(acc || "Alt+Space");
    if (panelWin && !panelWin.isDestroyed()) {
      if (!registerMiniHotkey()) { miniHotkey = prev; registerMiniHotkey(); return { ok: false, hotkey: prev }; }
    }
    return { ok: true, hotkey: miniHotkey };
  });
  ipcMain.on("openlive:mini", () => enterMini(true));
  ipcMain.on("openlive:unmini", () => restoreMainWindow(true));
  // The panel fits its content: its renderer measures the stacked previews + pill
  // and asks for a height. Grow UPWARD — the bottom edge stays put.
  ipcMain.on("openlive:mini-size", (_e, h) => {
    if (!panelWin || panelWin.isDestroyed()) return;
    const area = miniDisplay().workArea;
    const height = Math.max(44, Math.min(area.height - 96, Math.round(h) || PILL_H));
    const b = panelWin.getBounds();
    if (height === b.height) return;
    const bottom = b.y + b.height;
    const y = Math.max(area.y + 8, bottom - height);
    panelWin.setBounds({ x: b.x, y, width: PILL_W, height }, true); // animate the grow (mac)
  });
  // State/command relay between the main renderer (voice pipeline) and the panel.
  ipcMain.on("openlive:panel-state", (_e, s) => { if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send("openlive:panel-state", s); });
  ipcMain.on("openlive:panel-cmd", (_e, c) => { if (mainWin) mainWin.webContents.send("openlive:panel-cmd", c); });
}

// ── custom window controls (frameless window → no native traffic lights) ─────
function wireWindowIpc() {
  // Launch-at-login (Settings → General). Invoke with a boolean to set; with
  // undefined to just read the current state.
  ipcMain.handle("openlive:login-item", (_e, v) => {
    // Rebuild the menu: the same switch lives in Settings → General AND the app
    // menu, and the menu's checkbox is captured when it's built — flipping it here
    // left the two disagreeing until the next launch.
    if (typeof v === "boolean") { app.setLoginItemSettings({ openAtLogin: v }); buildMenu(); }
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.on("openlive:win-close", () => { if (mainWin) mainWin.close(); });
  ipcMain.on("openlive:win-min", () => { if (mainWin) mainWin.minimize(); });
  ipcMain.on("openlive:win-zoom", () => {
    if (!mainWin) return;
    if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize();
  });
}

// ── power events → renderer (pause the mic/VAD cleanly instead of waking up
// with a stuck pipeline after the laptop slept mid-call) ──────────────────────
function wirePowerEvents() {
  const send = (state) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("openlive:power", state); };
  powerMonitor.on("suspend", () => send("suspend"));
  powerMonitor.on("lock-screen", () => send("suspend"));
  powerMonitor.on("resume", () => send("resume"));
  powerMonitor.on("unlock-screen", () => send("resume"));
}

// ── OS bridge for agent tools (clipboard / open a URL) ───────────────────────
// The agent's reveal/open paths are model-driven — scope them to the bound
// workspace (reported by the renderer on every bind) plus the app's own data.
let workspaceDir = "";
function pathAllowed(p) {
  let real;
  try { real = fs.realpathSync(path.resolve(String(p ?? ""))); } catch { return false; }
  const roots = [workspaceDir, path.join(app.getPath("userData"), "data")].filter(Boolean);
  return roots.some((root) => {
    try { const r = fs.realpathSync(root); return real === r || real.startsWith(r + path.sep); } catch { return false; }
  });
}

function wireBridgeIpc() {
  ipcMain.on("openlive:workspace", (_e, dir) => { workspaceDir = String(dir ?? ""); });
  ipcMain.handle("openlive:bridge", async (_e, { op, arg }) => {
    try {
      if (op === "clipboard_read") { const t = clipboard.readText(); return t ? `The clipboard contains: ${t}` : "The clipboard is empty."; }
      if (op === "clipboard_write") { clipboard.writeText(String(arg ?? "")); return "Copied it to the clipboard."; }
      if (op === "pick_folder") {
        const opts = { title: "Choose a project folder", properties: ["openDirectory", "createDirectory"] };
        const r = await (mainWin ? dialog.showOpenDialog(mainWin, opts) : dialog.showOpenDialog(opts));
        return r.canceled ? "" : (r.filePaths[0] ?? "");
      }
      if (op === "open_url") {
        let u = String(arg ?? "").trim();
        if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
        try { new URL(u); } catch { return `"${arg}" isn't a valid URL.`; }
        await shell.openExternal(u);
        return `Opened ${u} in the browser.`;
      }
      // Tool-card file locations: reveal in Finder/Explorer, or open with the
      // OS default app. Paths come from the agent's (model-driven) tool calls —
      // refuse anything outside the bound workspace / app data dir.
      if (op === "reveal_path" || op === "open_path") {
        if (!pathAllowed(arg)) return "That file is outside the current workspace, so I won't open it.";
        if (op === "reveal_path") { shell.showItemInFolder(String(arg)); return "Revealed."; }
        const err = await shell.openPath(String(arg)); return err || "Opened.";
      }
      return "Unknown action.";
    } catch (e) { return `Couldn't do that: ${e?.message ?? e}`; }
  });
}

// ── application menu (About shows version, Cmd+, opens Settings) ──────────────
function buildMenu() {
  const isMac = process.platform === "darwin";
  const openSettings = () => mainWin && mainWin.webContents.send("openlive:open-settings");
  const template = [
    ...(isMac ? [{ role: "appMenu", submenu: [
      { role: "about", label: "About OpenLive" },
      { label: "Check for Updates…", click: checkForUpdatesNow },
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
      ...(isMac ? [] : [{ label: "Check for Updates…", click: checkForUpdatesNow },
                        { label: "Settings", accelerator: "CmdOrCtrl+,", click: openSettings },
                        { type: "separator" }, { role: "about", label: "About OpenLive" }]),
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({ applicationName: "OpenLive", applicationVersion: app.getVersion(), copyright: "© OpenLive" });
}

// ── auto-update (packaged prod only; needs the published latest*.yml) ─────────
// Flow: on launch + every 6h the app checks the GitHub release feed (owner/repo in
// electron-builder.yml). A newer version auto-downloads, then prompts to restart;
// "Later" still installs on the next quit. NOTE: macOS auto-update requires the
// app to be SIGNED — set the Apple secrets in the release workflow, or updates
// silently no-op on Mac even though the release is published fine.
let updater = null;         // the electron-updater singleton, once initialised
let manualCheck = false;    // a menu-driven check reports "up to date" out loud

function initAutoUpdate() {
  if (DEV || !app.isPackaged) return;
  try { ({ autoUpdater: updater } = require("electron-updater")); } catch { return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true; // if they pick "Later", install on next quit
  updater.on("checking-for-update", () => console.log("[updater] checking…"));
  updater.on("update-available", (i) => console.log("[updater] update available:", i?.version));
  updater.on("update-not-available", () => {
    console.log("[updater] up to date");
    if (manualCheck) { manualCheck = false; if (mainWin) dialog.showMessageBox(mainWin, { type: "info", message: "You're up to date", detail: `OpenLive ${app.getVersion()} is the latest version.` }); }
  });
  updater.on("download-progress", (p) => console.log(`[updater] downloading ${Math.round(p?.percent || 0)}%`));
  updater.on("update-downloaded", async ({ version }) => {
    const { response } = await dialog.showMessageBox(mainWin, {
      type: "info", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1,
      message: `OpenLive ${version} is ready`, detail: "Restart to finish updating.",
    });
    if (response === 0) { app.isQuitting = true; await killChildren(); updater.quitAndInstall(); }
  });
  updater.on("error", (e) => {
    console.error("[updater]", e?.message || e);
    if (manualCheck) { manualCheck = false; if (mainWin) dialog.showMessageBox(mainWin, { type: "warning", message: "Couldn't check for updates", detail: String(e?.message || e) }); }
  });
  updater.checkForUpdates().catch(() => {});
  setInterval(() => updater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000); // every 6h
}

// Menu-driven "Check for Updates…" — reports the result (up to date / downloading).
function checkForUpdatesNow() {
  if (!updater) { if (mainWin) dialog.showMessageBox(mainWin, { type: "info", message: "Updates aren't available in this build", detail: "Auto-update runs only in the installed (packaged) app." }); return; }
  manualCheck = true;
  updater.checkForUpdates().catch((e) => console.error("[updater] manual check:", e?.message || e));
}

async function boot() {
  buildMenu();
  createTray();
  wirePermissions();
  wireMiniIpc();
  wireNotifyIpc();
  wireWindowIpc();
  wireBridgeIpc();
  wirePowerEvents();
  createSplash();
  if (!(await startServers())) { app.quit(); return; } // ensurePortsFree already explained why
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

// Tear the server children (and their whole trees) down cleanly on quit: SIGTERM the
// groups, give them up to 2s to exit gracefully, then SIGKILL any survivor. Without
// this a quit could strand the web/agent processes still holding 47823/47824 (the
// leak that made the NEXT launch fail). Idempotent so the updater/quit paths can both
// call it and re-entrant before-quit doesn't double-run.
let cleanedUp = false;
async function killChildren() {
  if (cleanedUp) return;
  cleanedUp = true;
  const procs = children.splice(0);
  for (const c of procs) killTree(c.pid, "SIGTERM");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && procs.some((c) => c.pid && alive(c.pid))) await new Promise((r) => setTimeout(r, 100));
  for (const c of procs) if (c.pid && alive(c.pid)) killTree(c.pid, "SIGKILL");
  try { fs.rmSync(pidFile(), { force: true }); } catch { /* */ }
}

app.on("before-quit", (e) => {
  app.isQuitting = true;
  if (cleanedUp || DEV || children.length === 0) return; // nothing of ours to reap
  e.preventDefault();               // hold the quit until the trees are gone…
  killChildren().finally(() => app.quit()); // …then let it through (cleanedUp now short-circuits)
});
app.on("will-quit", () => globalShortcut.unregisterAll());
