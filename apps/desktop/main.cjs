"use strict";
// OpenLive desktop shell. Runs the web (Next) + agent (ws) servers locally and
// shows the UI in a native window. Everything is on localhost — the voice models
// run in the renderer (Chromium/WebGPU), the LLM call goes out from the agent.
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, session, shell, dialog, desktopCapturer, ipcMain, screen, clipboard, utilityProcess } = require("electron");
const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const os = require("node:os");
const { powerMonitor } = require("electron");
const flowInput = require("./flow-input.cjs");
const flowRuntime = require("./flow-runtime.cjs");

// Crash early, loud, and visible instead of dying silently.
// The app keeps running after one, so the heads-up is a silent notification,
// once per launch: never a modal that could stack up or hold quit hostage.
let crashNoticeShown = false;
process.on("uncaughtException", (e) => {
  console.error("[main] uncaught:", e);
  if (crashNoticeShown) return;
  crashNoticeShown = true;
  void app.whenReady().then(() => {
    if (!Notification.isSupported()) return;
    new Notification({ title: "OpenLive hit an unexpected error", body: "It is still running. If something stops working, quit and reopen OpenLive.", silent: true }).show();
  }).catch(() => {});
});
process.on("unhandledRejection", (e) => { console.error("[main] unhandled rejection:", e); });

// The on-device voice models (Whisper STT, Kokoro TTS) run on WebGPU. If it's
// unavailable the app falls back to CPU/WASM, which is several times slower and
// makes the conversation feel laggy. Expose WebGPU + don't let a blocklisted GPU
// silently drop us to software. Must be set before app is ready.
app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("enable-features", "WebGPU");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

const DEV = process.env.ELECTRON_DEV === "1";
// Dev ports match `pnpm desktop:dev`, apart from the installed app's. In prod the
// agent prefers 47823 but moves to any free port (ensurePortsFree); the renderer is
// told which at launch. The web port never moves: its origin keys localStorage and
// the cached model weights.
let AGENT_PORT = DEV ? Number(process.env.AGENT_PORT) || 47833 : 47823;
const WEB_PORT = Number(process.env.WEB_PORT) || (DEV ? 47834 : 47824);
// MUST be "localhost", not "127.0.0.1": Next dev's HMR websocket rejects a
// 127.0.0.1 origin (ERR_INVALID_HTTP_RESPONSE), and with Turbopack a dead HMR
// socket blocks hydration → the UI renders but nothing is clickable.
const WEB_HOST = "localhost";
const WEB_URL = `http://${WEB_HOST}:${WEB_PORT}`;
const DARK_BG = "#0b0b0c";

// Per-launch auth token for the local agent. Loopback binding keeps remote
// attackers out, but any LOCAL process could otherwise open the agent's socket
// and drive the agent. The token rides to the agent + web servers as
// OPENLIVE_AGENT_SECRET (both already honor it) and to the renderer via argv.
// Dev keeps the open no-secret path (servers come from `pnpm dev`).
const AGENT_TOKEN = DEV ? "" : crypto.randomBytes(24).toString("base64url");
// Per-launch proof, for the settings route, that a person confirmed an Ollama
// address off this computer in a native dialog. Only the web server's env and
// this process hold it; unlike AGENT_TOKEN it never reaches a renderer. Dev has
// none, so there only this computer's own addresses save.
const SETTINGS_TOKEN = DEV ? "" : crypto.randomBytes(24).toString("base64url");

let mainWin = null;
let splashWin = null;
const children = [];

// ── single instance ─────────────────────────────────────────────────────────
// Dev runs under its own profile so it can coexist with an installed OpenLive.
// Sharing the app id + user-data dir means they fight over this lock, and dev
// would silently quit (exit 0) whenever the installed app is open.
if (DEV) app.setPath("userData", `${app.getPath("userData")}-dev`);
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
// Before the servers are up there is no page to show; boot opens the window itself.
let serversUp = false;
app.on("second-instance", () => { if (serversUp) restoreMainWindow(); });

// ── media (mic/camera) permissions — Electron blocks getUserMedia otherwise ──
function wirePermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media" || permission === "clipboard-read" || permission === "clipboard-sanitized-write");
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === "media");

  // Screen share: without a handler, getDisplayMedia() fails in Electron. The native
  // system picker (useSystemPicker) cancels the request on recent macOS, so share the
  // primary screen directly — reliable, no picker prompt.
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ["screen", "window"] })
      .then((sources) => {
        const screenSrc = sources.find((s) => s.id.startsWith("screen:")) || sources[0];
        callback(screenSrc ? { video: screenSrc } : {});
      })
      .catch(() => callback({}));
  });
}

// ── process-tree kill + port helpers (cross-platform) ────────────────────────
const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8" }); } catch { return ""; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Kill a process AND every descendant. POSIX: a process-group leader goes with its
// whole group (a negative pid signals it); anything else falls back to the pid
// alone. Windows has no groups → taskkill /T walks the tree.
function killTree(pid, sig = "SIGTERM") {
  if (!pid) return;
  if (process.platform === "win32") { sh(`taskkill ${sig === "SIGKILL" ? "/F " : ""}/T /PID ${pid}`); return; }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
}

// PIDs listening on `port`. lsof is always there on macOS but is NOT installed on
// minimal Linux images — and sh() can't tell "no such binary" from "nothing found",
// so a missing lsof would silently read as "port is free" and skip the cleanup this
// whole path exists for. ss (iproute2) is the modern default there, so fall back to it on Linux.
function posixListenerPids(port) {
  const viaLsof = sh(`lsof -ti tcp:${port} -sTCP:LISTEN`).split("\n").filter(Boolean).map(Number);
  if (viaLsof.length || process.platform !== "linux") return viaLsof;
  const pids = [];
  for (const line of sh("ss -ltnpH").split("\n")) {
    // state | recv-q | send-q | local:port | peer | users:(("name",pid=N,fd=M))
    if (!line.trim().split(/\s+/)[3]?.endsWith(`:${port}`)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
  }
  return pids;
}

// Who (if anyone) is LISTENING on `port`, and is it one of ours? "Ours" = a process
// whose executable path names our binary (prod servers are utility processes: the
// same exe on Windows/Linux, "<Name> Helper" inside our bundle on macOS), so a
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
  for (const pid of posixListenerPids(port)) {
    if (!pid || pid === process.pid) continue;
    const comm = sh(`ps -p ${pid} -o comm=`).trim();
    return { pid, name: path.basename(comm), ours: comm.toLowerCase().includes(mine) };
  }
  return null;
}

// A port the OS says is free on loopback right now.
function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
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
// ours. A foreign app on the agent's port just moves the agent; on the web port it
// gets ONE clear message (respawning can't fix that; issue #6's "web service keeps
// crashing" loop was exactly this case).
async function ensurePortsFree() {
  reapRecordedPids();
  for (const port of [AGENT_PORT, WEB_PORT]) {
    const h = portHolder(port);
    if (h && h.ours) { console.error(`[main] killing stale ${h.name} (pid ${h.pid}) on port ${port}`); killTree(h.pid, "SIGKILL"); }
    // Poll briefly: a just-SIGKILLed zombie's socket takes a beat to be released by
    // the kernel, and we don't want to mistake our own dying process for a foreign app.
    let free = false;
    const tries = h && !h.ours ? 1 : 15;
    for (let i = 0; i < tries && !(free = await portFree(port)); i++) await new Promise((r) => setTimeout(r, 100));
    if (!free && port === AGENT_PORT) {
      AGENT_PORT = await freeLoopbackPort();
      console.error(`[main] port ${port} is taken; the agent will use ${AGENT_PORT}`);
      continue;
    }
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
// Servers run as utility processes: on macOS a process of the main bundle's binary
// that sets its title (Next's server does) registers as a second foreground app
// with its own Dock tile, while the Helper these run under is LSUIElement. They
// also die with this process.
const restarts = {}; // name → { count, first }
function spawnServer(name, scriptRel, env) {
  const script = path.join(process.resourcesPath, scriptRel);
  const child = utilityProcess.fork(script, [], {
    env: { ...process.env, ...env },
    stdio: "inherit",
    serviceName: `${app.getName()} ${name}`,
  });
  child.once("spawn", recordServerPids);
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
    OPENLIVE_SETTINGS_SECRET: SETTINGS_TOKEN,
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

// How a renderer that opens the live socket finds the agent: its port (picked at
// launch) and the per-launch token.
function agentArgs() {
  return [`--openlive-agent-port=${AGENT_PORT}`, ...(AGENT_TOKEN ? [`--openlive-agent-token=${AGENT_TOKEN}`] : [])];
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
  // Skip fullscreen bounds: persisting them would reopen the window screen-filling
  // instead of at its real size.
  if (!mainWin || mainWin.isFullScreen()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify(mainWin.getBounds())); } catch { /* best-effort */ }
}

// ── one-time things (first ⌘Q notice, the login-item default) ────────────────
const onceFile = () => path.join(app.getPath("userData"), "once.json");
/** True the first time it's asked about `name`, false on every call after. */
function firstTime(name) {
  let done = {};
  try { done = JSON.parse(fs.readFileSync(onceFile(), "utf8")); } catch { /* first run */ }
  if (done[name]) return false;
  done[name] = true;
  try { fs.writeFileSync(onceFile(), JSON.stringify(done)); } catch { /* best-effort */ }
  return true;
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
    // OPAQUE (never transparent): transparent windows take a slower macOS compositing
    // path that competes with the on-device WebGPU voice models (adds turn latency) and
    // render as a black wall on some GPUs.
    // macOS: titleBarStyle "hidden" keeps the NATIVE traffic lights (positioned to match
    // the old custom dots) AND real OS fullscreen — a fully frameless window degrades the
    // green button to a maximize. Win/Linux stay frameless with our own controls.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 14 } }
      : { frame: false }),
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
      // A call keeps running while this window is minimised or hidden, and its
      // renderer runs the whole voice pipeline: throttled timers would wreck
      // turn-taking (hold timers, TTS drain).
      backgroundThrottling: false,
      // Hand the app version to the preload (app.* isn't reachable there). Released
      // builds show the tag version (CI stamps it); unpackaged dev builds get a
      // "-dev" suffix so it's obvious you're not on a release.
      additionalArguments: [
        `--openlive-version=${app.isPackaged ? app.getVersion() : `${app.getVersion()}-dev`}`,
        // Only this window and the Flow owner open the live socket; the orb window
        // is a display-only relay and never needs the token or the port.
        ...agentArgs(),
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
  // Flow is ambient: it belongs to the machine, not to this window. Closing or
  // minimising OpenLive leaves the gesture armed and the orb reachable on every
  // platform; only quitting ends it. The tray is the way back to this window,
  // and Flow's two hidden windows are what keep the app alive to be quit from.
  // The call lives in this window's renderer, so closing the window ends it; the
  // orb must not keep showing a call that is gone.
  mainWin.on("closed", () => {
    mainWin = null;
    callState = null;
    syncCallOrb();
    refreshTray();
    syncDock();
    // No tray (some Linux desktops have none): nothing would be left to quit from.
    if (!tray && process.platform !== "darwin") quitApp();
  });
  for (const ev of ["show", "hide"]) mainWin.on(ev, () => { refreshTray(); syncDock(); });
  for (const ev of ["show", "hide", "minimize", "restore"]) mainWin.on(ev, syncCallOrb);
}

/** The floating orb window: chromeless, transparent, always on top, on every
 *  Space, and never taking focus from the app underneath. */
function makePanelWindow(route, bounds) {
  const win = new BrowserWindow({
    ...bounds,
    show: false, frame: false, resizable: false, skipTaskbar: true,
    // Transparent so the renderer can draw a real rounded, floating orb (border +
    // shadow + gaps around it) instead of an opaque rectangle. hasShadow off — the
    // OS shadow would trace the rectangular window; the orb casts its own via CSS.
    transparent: true, backgroundColor: "#00000000", hasShadow: false,
    // macOS: a "panel"-type window is non-activating — clicks land on its buttons
    // without pulling focus away from whatever app the user is working in.
    ...(process.platform === "darwin" ? { type: "panel", focusable: false } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "floating", 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.loadURL(`${WEB_URL}${route}`);
  return win;
}

// ── Flow: the owner renderer and the summoned orb ────────────────────────────
// Flow works with no visible window, so a hidden renderer owns the voice cascade
// and the Flow socket (backgroundThrottling off, so its timers keep running).
// The orb appears on the display the cursor is on and never steals focus from
// the app the user is typing into.
const FLOW_INSET = 24;   // the motion spec's clamp inside the screen edge
// The orb sits above the dock, not under the cursor: one place it is always in,
// so finding it is remembering, not hunting. The work area already excludes the
// dock, so this is the breathing room above it: enough that the orb reads as
// floating over the desktop rather than sitting on the dock's shoulder, and
// clear of whatever the app underneath keeps along its own bottom edge.
const FLOW_MARGIN = 112;
// One size for the window's whole life, the tallest thing it ever draws: the
// question card (392 wide, scrolling inside past what fits) stacked on the hover
// controls and the orb, plus padding. Resizing a transparent window while the
// page animates inside it is what flickered; the empty air is click-through.
const FLOW_W = 416, FLOW_H = 460;
// The exit plays in the renderer before the window hides; this is the ceiling
// on waiting for it, so a stalled renderer can never keep Flow on screen.
const FLOW_EXIT_MS = 300;
let ownerWin = null;
let flowWin = null;
let flowHiding = null;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function createOwnerWindow() {
  if (ownerWin && !ownerWin.isDestroyed()) return ownerWin;
  ownerWin = new BrowserWindow({
    width: 480, height: 320, show: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, additionalArguments: agentArgs() },
  });
  ownerWin.loadURL(`${WEB_URL}/flow-owner`);
  ownerWin.on("closed", () => { ownerWin = null; });
  return ownerWin;
}

/** Where the orb window goes: centred over the dock, on the display given (the
 *  cursor's, on a summon; its own, on a display change), fully inside that work
 *  area. A small screen gets a smaller window and the card scrolls. */
function flowBounds(display) {
  const area = (display ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
  const w = Math.max(1, Math.min(FLOW_W, area.width - FLOW_INSET * 2));
  const h = Math.max(1, Math.min(FLOW_H, area.height - FLOW_INSET * 2));
  return {
    width: w, height: h,
    x: area.x + Math.round((area.width - w) / 2),
    y: clamp(area.y + area.height - h - FLOW_MARGIN, area.y + FLOW_INSET, area.y + area.height - h),
  };
}

function createFlowWindow() {
  if (flowWin && !flowWin.isDestroyed()) return flowWin;
  // Built hidden, ahead of the first gesture, so opening Flow is an animation
  // and never a page load.
  flowWin = makePanelWindow("/flow", flowBounds());
  // Most of this window is empty air around a small orb, and it sits over the
  // dock where real things live. Clicks pass straight through it; `forward`
  // keeps delivering mouse MOVES to the renderer, which is how it still knows
  // the pointer has reached the orb and asks for the clicks back.
  flowWin.setIgnoreMouseEvents(true, { forward: true });
  // Showing the window resets it to click-through, so the renderer has to be
  // told: it tracks whether the pointer is on the orb, and a stale "yes" from
  // before it was hidden would stop it ever asking for the clicks back.
  flowWin.on("show", () => {
    if (flowWin && !flowWin.isDestroyed()) flowWin.webContents.send("openlive:flow-shown");
  });
  flowWin.on("closed", () => { flowWin = null; });
  return flowWin;
}

function summonFlow() {
  const win = createFlowWindow();
  flowSummoned = true;
  // The window may be up showing a call; Flow's own orb takes over from it.
  win.webContents.send("openlive:call-orb", null);
  // A gesture that closed Flow mid-hover would otherwise leave it clickable.
  win.setIgnoreMouseEvents(true, { forward: true });
  // `showInactive` on an already-visible window emits no "show", and a summon
  // of an open Flow is an ordinary thing (a resumed session, a new turn).
  // A summon mid-exit cancels the hide; that "shown" brings the orb back.
  clearTimeout(flowHiding);
  flowHiding = null;
  if (win.isVisible()) win.webContents.send("openlive:flow-shown");
  win.setBounds(flowBounds());
  // The orb goes over everything: other always-on-top windows, the Dock, and
  // fullscreen apps. "floating" sits below the Dock, and macOS can drop a
  // window's level and space membership across hide/show, so both are set
  // again on every summon rather than trusted from creation.
  win.setAlwaysOnTop(true, "screen-saver", 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.showInactive();
}

/** The renderer plays its exit, then says so; the timeout hides it regardless. */
function dismissFlow() {
  if (!flowWin || flowWin.isDestroyed() || !flowSummoned || flowHiding) return;
  if (!flowWin.isVisible()) { flowSummoned = false; syncCallOrb(); return; }
  flowWin.setIgnoreMouseEvents(true, { forward: true });
  flowWin.webContents.send("openlive:flow-hiding");
  flowHiding = setTimeout(finishDismissFlow, FLOW_EXIT_MS);
}

function finishDismissFlow() {
  clearTimeout(flowHiding);
  flowHiding = null;
  flowSummoned = false;
  if (flowWin && !flowWin.isDestroyed()) flowWin.hide();
  syncCallOrb();
}

/** A display was added, removed or rearranged while the orb was up: re-dock it
 *  over whichever work area it now sits nearest. */
function reclampFlow() {
  if (!flowWin || flowWin.isDestroyed() || !flowWin.isVisible()) return;
  flowWin.setBounds(flowBounds(screen.getDisplayMatching(flowWin.getBounds())));
}

// The orb's full-screen control, and the tray's "Flow settings…". Flow is
// ambient, so the window it opens may not exist yet, and it opens on Flow,
// which is what the person was in.
async function expandFlow(to) {
  await showDock();
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  else {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
  }
  app.focus({ steal: true });
  if (mainWin && !mainWin.isDestroyed()) {
    // A window created just now has no page listening yet; the ask waits for it.
    const wc = mainWin.webContents;
    const show = () => wc.send("openlive:flow-show", /^[a-z]+-settings$/.test(to) ? to : "");
    if (wc.isLoading()) wc.once("did-finish-load", show); else show();
  }
}

/** The tray's "New Flow session": the gesture itself, fired from here, so the
 *  owner renderer opens Flow exactly as a double tap would. The addon's trigger
 *  is a toggle, so an open Flow is not sent it: the owner starts the fresh
 *  session there instead, and leaves a turn that is still running alone. */
const FLOW_BINDING = "flow"; // useFlowOwner's BINDING_ID
function startFlowFromTray() {
  if (flowSummoned) {
    if (ownerWin && !ownerWin.isDestroyed()) ownerWin.webContents.send("openlive:flow-new-session");
    return;
  }
  try { flowInput.load().triggerExternal(FLOW_BINDING, true); }
  catch (e) { console.error("[main] tray flow:", e); }
}

function wireFlowIpc() {
  flowRuntime.install();
  ipcMain.on("openlive:flow-summon", summonFlow);
  ipcMain.on("openlive:flow-dismiss", dismissFlow);
  // The renderer owns the hit test: the orb and its controls take clicks, the
  // empty air around them does not.
  ipcMain.on("openlive:flow-interactive", (_e, on) => {
    if (!flowWin || flowWin.isDestroyed()) return;
    flowWin.setIgnoreMouseEvents(!on, { forward: true });
  });
  // A reply after a summon cancelled the exit finds no pending hide and is dropped.
  ipcMain.on("openlive:flow-hidden", () => { if (flowHiding) finishDismissFlow(); });
  ipcMain.handle("openlive:flow-visible", () => !!flowWin && !flowWin.isDestroyed() && flowWin.isVisible());
  ipcMain.on("openlive:flow-expand", (_e, to) => expandFlow(to));
  for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(ev, reclampFlow);
  // "Continue this session" in the Flow window: only the owner renderer holds the
  // Flow socket, so the ask has to cross windows.
  ipcMain.on("openlive:flow-resume-session", (_e, id) => {
    if (ownerWin && !ownerWin.isDestroyed()) ownerWin.webContents.send("openlive:flow-resume-session", String(id || ""));
  });
  ipcMain.on("openlive:flow-armed", (_e, v) => setFlowArmed(v));
  ipcMain.on("openlive:flow-settings-changed", () => {
    if (ownerWin && !ownerWin.isDestroyed()) ownerWin.webContents.send("openlive:flow-settings-changed");
  });
}

/** The quick disarm, from the tray or from the Flow window. One state, told to
 *  everyone who draws it, so the tray and the window can never disagree. */
function setFlowArmed(next) {
  const armed = flowInput.setArmed(next);
  if (!armed) dismissFlow();
  for (const win of [mainWin, ownerWin, flowWin]) {
    if (win && !win.isDestroyed()) win.webContents.send("openlive:flow-armed", armed);
  }
  refreshTray();
}

// ── a call on the orb ────────────────────────────────────────────────────────
// A live call runs in the main window's renderer. While that window is
// minimised or hidden, the orb window shows the call instead (mute, open, end)
// so it is never out of reach. A summoned Flow takes the window over and the
// call comes back when Flow closes.
let callState = null;     // { muted, startedAt } while a call is live, else null
let flowSummoned = false;

const callOrbWanted = () => !!callState && !!mainWin && !mainWin.isDestroyed()
  && (mainWin.isMinimized() || !mainWin.isVisible());

function syncCallOrb() {
  if (!flowWin || flowWin.isDestroyed() || flowSummoned || flowHiding) return;
  const want = callOrbWanted();
  flowWin.webContents.send("openlive:call-orb", want ? callState : null);
  if (!want) { if (flowWin.isVisible()) flowWin.hide(); return; }
  if (flowWin.isVisible()) return;
  flowWin.setIgnoreMouseEvents(true, { forward: true });
  // Over the dock of the screen the call's window was on, not the cursor's.
  flowWin.setBounds(flowBounds(mainWin ? screen.getDisplayMatching(mainWin.getBounds()) : undefined));
  flowWin.setAlwaysOnTop(true, "screen-saver", 1);
  flowWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  flowWin.showInactive();
}

// NOTE on `!mainWin`: closing the window does NOT quit on macOS (window-all-closed
// only quits elsewhere) — the app stays alive in the tray with mainWin === null.
// Bailing in that state would leave the tray icon a dead stub where only Quit
// works. Recreating the window is the whole point of a tray icon, so it does.

/** Bring the app forward. Shared by the tray menu, the orb's call controls, and
 *  notification clicks. */
async function restoreMainWindow() {
  await showDock();
  if (!mainWin) { // its ready-to-show shows + refreshes
    createMainWindow();
    if (process.platform === "darwin") mainWin.once("ready-to-show", () => app.focus({ steal: true }));
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore(); // show() alone leaves it in the Dock
  mainWin.show();
  mainWin.focus();
  app.focus({ steal: true }); // tray clicks don't activate the app on macOS
  refreshTray();
}

/** Settings… from the tray or the app menu: bring the window up, then open it
 *  there (the preload holds the ask if the page hasn't subscribed yet). */
async function openSettings() {
  await restoreMainWindow();
  const wc = mainWin?.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.once("did-finish-load", () => wc.send("openlive:open-settings"));
  else wc.send("openlive:open-settings");
}

// ── menu-bar (tray) presence + notifications ─────────────────────────────────
let tray = null;
// Worded as the Flow window words it, from the same test.
const TRAY_READINESS = { ready: "Flow: Ready", stopped: "Flow: Key listener stopped", off: "Flow: Off" };
const TRAY_READINESS_POLL_MS = 3000;
let trayReadiness = "off";
const TRAY_PLACE = process.platform === "darwin" ? "menu bar" : "tray";

/** macOS: the Dock icon is there only while the main window is.
 *  Flow's own windows don't count, or every summon would flash the Dock. */
function syncDock() {
  if (process.platform !== "darwin" || !tray || app.isQuitting) return;
  const up = !!(mainWin && (mainWin.isVisible() || mainWin.isMinimized()));
  if (up === app.dock.isVisible()) return;
  if (up) app.dock.show(); else app.dock.hide();
}

/** Before showing a window from menu-bar-only: a window shown while the Dock icon
 *  is hidden can't take focus. Resolves once the icon is back. */
function showDock() {
  return process.platform === "darwin" && !app.dock.isVisible() ? app.dock.show() : Promise.resolve();
}

/** ⌘Q, Ctrl+Q and the Dock's Quit: close the windows, keep Flow running. The
 *  tray's Quit is the one real quit. */
function closeToMenuBar() {
  if (!tray) { quitApp(); return; } // nowhere to live on
  if (mainWin) mainWin.close();
  if (firstTime("closedToMenuBar") && Notification.isSupported()) {
    const n = new Notification({ title: `OpenLive is still running in the ${TRAY_PLACE}`, body: `Flow stays ready. Quit from the ${TRAY_PLACE} icon.`, silent: true });
    n.on("click", () => restoreMainWindow());
    n.show();
  }
}

function quitApp() {
  app.isQuitting = true;
  app.quit();
}

function createTray() {
  try {
    // macOS tints a Template image to suit a light or dark menu bar; elsewhere
    // templates mean nothing, so the tray gets the colour mark. Both load their @2x.
    const img = nativeImage.createFromPath(path.join(__dirname, "build", process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
    tray = new Tray(img);
    tray.setToolTip("OpenLive");
    refreshTray();
    // A grant, or a key listener dying, is never announced, so the label is
    // re-read and the menu rebuilt only when it would say something different.
    setInterval(() => { if (flowInput.readiness() !== trayReadiness) refreshTray(); }, TRAY_READINESS_POLL_MS).unref();
  } catch (e) { console.error("[main] tray:", e); } // no tray beats no app
}

/** Rebuild the tray menu against the CURRENT state: a menu built once at boot
 *  would quietly lie about modes you are in or out of. */
function refreshTray() {
  if (!tray) return;
  const armed = flowInput.isArmed();
  trayReadiness = flowInput.readiness();
  tray.setContextMenu(Menu.buildFromTemplate([
    // Flow runs with no window at all, so the menu bar is the only place its
    // state is visible and the only place to switch it off in one click.
    { label: TRAY_READINESS[trayReadiness], enabled: false },
    { type: "separator" },
    // Always enabled: `isVisible()` stays true for a window that's merely BEHIND
    // another app, so gating on it would grey out the one control that brings
    // OpenLive forward — the commonest reason to reach for the tray at all.
    { label: "Open OpenLive", click: () => restoreMainWindow() },
    // Enabled only when a double tap would work, and says why not otherwise.
    { label: trayReadiness === "ready" ? "New Flow session" : `New Flow session (${TRAY_READINESS[trayReadiness].replace("Flow: ", "")})`,
      enabled: trayReadiness === "ready", click: startFlowFromTray },
    { label: "Flow armed", type: "checkbox", checked: armed, click: () => setFlowArmed(!armed) },
    { type: "separator" },
    { label: "Settings…", click: () => openSettings() },
    { label: "Flow settings…", click: () => expandFlow("flow-settings") },
    { type: "separator" },
    { label: "Quit OpenLive", click: quitApp },
  ]));
}

function wireNotifyIpc() {
  // Renderer asks for an OS notification ("agent finished", "permission needed").
  // Only shown when the user ISN'T looking at the app — focused-and-visible means
  // they already see it. Clicking brings OpenLive forward.
  ipcMain.on("openlive:notify", (_e, p) => {
    const title = String(p?.title ?? "").slice(0, 80);
    if (!title || !Notification.isSupported()) return;
    if (mainWin && mainWin.isVisible() && mainWin.isFocused()) return;
    const n = new Notification({ title, body: String(p?.body ?? "").slice(0, 180), silent: true });
    n.on("click", () => restoreMainWindow());
    n.show();
  });
}

function wirePanelIpc() {
  // Flow's owner renderer publishes to the orb; the orb's commands go back to it.
  const sentBy = (e, win) => !!win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.on("openlive:panel-state", (e, s) => {
    if (sentBy(e, ownerWin) && flowWin && !flowWin.isDestroyed()) flowWin.webContents.send("openlive:panel-state", s);
  });
  ipcMain.on("openlive:panel-cmd", (e, c) => {
    if (sentBy(e, flowWin) && ownerWin && !ownerWin.isDestroyed()) ownerWin.webContents.send("openlive:panel-cmd", c);
  });
  // The main window's call, for the orb: null once it ends.
  ipcMain.on("openlive:call-state", (e, s) => {
    if (!sentBy(e, mainWin)) return;
    callState = s ? { muted: !!s.muted, startedAt: Number(s.startedAt) || Date.now() } : null;
    syncCallOrb();
  });
  // The orb's call controls. Open is the window's business, the rest the call's.
  ipcMain.on("openlive:call-cmd", (e, c) => {
    if (!sentBy(e, flowWin)) return;
    if (c?.t === "expand") restoreMainWindow();
    else if ((c?.t === "mute" || c?.t === "end") && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("openlive:panel-cmd", c);
  });
}

// ── launch at login ──────────────────────────────────────────────────────────
// Electron's setLoginItemSettings is darwin/win32 only (its own typings say so), so
// on Linux the Settings toggle silently did nothing and always read back off. Linux
// autostart is a .desktop file in ~/.config/autostart. Exec must be the AppImage the
// user launched, not the unpacked binary inside it — APPIMAGE holds that path.
// A login launch starts hidden. Windows and Linux say so with HIDDEN_ARG (Windows
// only matches its entry when read back with the same args); macOS takes no args
// and reports it as wasOpenedAtLogin instead.
const AUTOSTART_FILE = path.join(os.homedir(), ".config", "autostart", "openlive.desktop");
const HIDDEN_ARG = "--hidden";
function loginItem(enable) {
  if (process.platform !== "linux") {
    if (typeof enable === "boolean") app.setLoginItemSettings({ openAtLogin: enable, args: [HIDDEN_ARG] });
    return app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin;
  }
  try {
    if (typeof enable === "boolean") {
      if (enable) {
        fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
        const exec = process.env.APPIMAGE || process.execPath;
        fs.writeFileSync(AUTOSTART_FILE,
          `[Desktop Entry]\nType=Application\nName=OpenLive\nExec="${exec}" ${HIDDEN_ARG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
      } else {
        fs.rmSync(AUTOSTART_FILE, { force: true });
      }
    }
    return fs.existsSync(AUTOSTART_FILE);
  } catch { return false; }
}

// ── custom window controls (frameless window → no native traffic lights) ─────
function wireWindowIpc() {
  // Launch-at-login (Settings → General). Invoke with a boolean to set; with
  // undefined to just read the current state.
  ipcMain.handle("openlive:login-item", (_e, v) => {
    // Rebuild the menu: the same switch lives in Settings → General AND the app
    // menu, and the menu's checkbox is captured when it's built — flipping it here
    // left the two disagreeing until the next launch.
    if (typeof v === "boolean") { loginItem(v); buildMenu(); }
    return loginItem();
  });
  // Settings → Models: an Ollama address off this computer. Page script can call
  // this too, so the person answers a native dialog naming the host, and only
  // then does this process write it, with the secret the route asks for. One
  // dialog at a time, so a script cannot stack them.
  let confirmingOllama = false;
  ipcMain.handle("openlive:confirm-ollama-url", async (e, raw) => {
    if (!SETTINGS_TOKEN) return { error: "Only the installed OpenLive app can use an Ollama address off this computer." };
    if (confirmingOllama) return { cancelled: true };
    const value = String(raw ?? "").trim();
    let u = null;
    try { u = new URL(value); } catch {}
    if (u?.protocol !== "http:" && u?.protocol !== "https:") return { error: "Enter an http:// or https:// address, like http://localhost:11434." };
    confirmingOllama = true;
    try {
      const win = BrowserWindow.fromWebContents(e.sender);
      const opts = {
        type: "warning",
        buttons: ["Cancel", "Use This Server"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: `Send Ollama requests to ${u.host}?`,
        detail: `${u.protocol}//${u.host} is not on this computer. Flow and Chat will send it what you say and type, and screen content, including screenshots from tools.`,
      };
      const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
      if (response !== 1) return { cancelled: true };
      const res = await fetch(`${WEB_URL}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-openlive-confirmed": SETTINGS_TOKEN },
        body: JSON.stringify({ ollamaBaseUrl: value }),
      });
      const body = await res.json().catch(() => ({}));
      return res.ok ? { settings: body } : { error: body.error || "Couldn't save the address." };
    } catch {
      return { error: "Couldn't save the address." };
    } finally {
      confirmingOllama = false;
    }
  });
  ipcMain.on("openlive:win-close", () => { if (mainWin) mainWin.close(); });
  ipcMain.on("openlive:win-min", () => { if (mainWin) mainWin.minimize(); });
  ipcMain.on("openlive:win-zoom", () => {
    if (!mainWin) return;
    if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize();
  });
  // Native fullscreen toggle — the macOS green button's default action (the app
  // menu's View ▸ Toggle Full Screen / F11 / ⌃⌘F reach the same thing).
  ipcMain.on("openlive:win-fullscreen", () => {
    if (!mainWin) return;
    mainWin.setFullScreen(!mainWin.isFullScreen());
  });
}

// ── power events → renderer (pause the mic/VAD cleanly instead of waking up
// with a stuck pipeline after the laptop slept mid-call) ──────────────────────
function wirePowerEvents() {
  const send = (state) => {
    for (const win of [mainWin, ownerWin]) if (win && !win.isDestroyed()) win.webContents.send("openlive:power", state);
  };
  powerMonitor.on("suspend", () => send("suspend"));
  powerMonitor.on("lock-screen", () => send("suspend"));
  powerMonitor.on("resume", () => send("resume"));
  powerMonitor.on("unlock-screen", () => send("resume"));
  // Logout / restart / shutdown (macOS, Linux) must never be held up by
  // before-quit's close-to-menu-bar. Windows skips before-quit for these anyway.
  powerMonitor.on("shutdown", () => { app.isQuitting = true; });
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
  // ⌘Q keeps OpenLive (and Flow) in the menu bar; quitting is a deliberate act.
  const closeItems = [
    { label: `Close to ${isMac ? "Menu Bar" : "Tray"}`, accelerator: "CmdOrCtrl+Q", click: closeToMenuBar },
    { label: "Quit OpenLive", click: quitApp },
  ];
  const template = [
    ...(isMac ? [{ role: "appMenu", submenu: [
      { role: "about", label: "About OpenLive" },
      { label: "Check for Updates…", click: checkForUpdatesNow },
      { type: "separator" },
      { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openSettings() },
      { label: "Open at Login", type: "checkbox", checked: loginItem(),
        click: (mi) => loginItem(mi.checked) },
      { type: "separator" },
      { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" }, ...closeItems,
    ] }] : [{ label: "File", submenu: closeItems }]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "OpenLive on GitHub", click: () => shell.openExternal("https://github.com/katipally/openlive") },
      ...(isMac ? [] : [{ label: "Check for Updates…", click: checkForUpdatesNow },
                        { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => openSettings() },
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
    // Menu-bar-only there is no window to hang the ask on, and a parentless
    // dialog from a background app opens behind whatever is in front.
    if (process.platform === "darwin" && !mainWin?.isVisible()) app.focus({ steal: true });
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
  // The packaged app takes its dock icon from icon.icns; the dev binary would show Electron's.
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, "build", "icon.png"));
  buildMenu();
  createTray();
  wirePermissions();
  wirePanelIpc();
  wireNotifyIpc();
  wireWindowIpc();
  wireBridgeIpc();
  wirePowerEvents();
  wireFlowIpc();
  // Hook effects drive Flow's cascade, which lives in the owner renderer.
  flowInput.install(() => (ownerWin && !ownerWin.isDestroyed() ? ownerWin.webContents : null));
  // Open at login by default, once, for the installed app only (never the dev
  // binary). After that the person's choice in Settings stands.
  if (app.isPackaged && firstTime("loginItemDefault") && !loginItem()) loginItem(true);
  // A login launch comes up as just the tray, with Flow ready.
  const hidden = !!tray && (process.argv.includes(HIDDEN_ARG)
    || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin));
  if (hidden && process.platform === "darwin") app.dock.hide();
  if (!hidden) createSplash();
  if (!(await startServers())) { quitApp(); return; } // ensurePortsFree already explained why
  const ok = await waitForServers();
  if (!ok) {
    dialog.showErrorBox("OpenLive couldn't start", `The local servers didn't come up. Try relaunching.`);
    quitApp();
    return;
  }
  serversUp = true;
  if (!hidden && !mainWin) createMainWindow();
  // Flow is armed whenever the app runs, with or without a visible window.
  createOwnerWindow();
  createFlowWindow();
  initAutoUpdate();
}

app.whenReady().then(boot);

// `!mainWin`, not "no windows at all": Flow keeps two hidden ones open.
app.on("activate", () => { if (serversUp && !mainWin) restoreMainWindow(); });
// With a tray, OpenLive lives on in it on every platform; without one, closing
// everything has to quit or the process is left invisible and unquittable.
app.on("window-all-closed", () => { if (!tray) quitApp(); });

// Tear the server children (and their whole trees) down cleanly on quit: SIGTERM the
// servers (the agent takes its own children down as it exits), give them up to 2s to exit gracefully, then SIGKILL any survivor. Without
// this a quit could strand the web/agent processes still holding their ports (the
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
  // macOS routes the Dock's Quit here. Only while the Dock icon shows: with it
  // hidden no user action lands here, so logout and signals always get through.
  if (!app.isQuitting && tray && process.platform === "darwin" && app.dock.isVisible()) {
    e.preventDefault();
    closeToMenuBar();
    return;
  }
  app.isQuitting = true;
  if (cleanedUp || DEV || children.length === 0) return; // nothing of ours to reap
  e.preventDefault();               // hold the quit until the trees are gone…
  killChildren().finally(() => app.quit()); // …then let it through (cleanedUp now short-circuits)
});
