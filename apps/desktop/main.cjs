"use strict";
// OpenLive desktop shell. Runs the web (Next) + agent (ws) servers locally and
// shows the UI in a native window. Everything is on localhost — the voice models
// run in the renderer (Chromium/WebGPU), the LLM call goes out from the agent.
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, nativeTheme, session, shell, dialog, desktopCapturer, ipcMain, screen, clipboard, utilityProcess } = require("electron");
const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const os = require("node:os");
const { powerMonitor, net: electronNet } = require("electron");
const flowInput = require("./flow-input.cjs");
const flowRuntime = require("./flow-runtime.cjs");
const { osHasGlass, glassSupport, effectiveLook } = require("./look.cjs");
const orbPointer = require("./orb-pointer.cjs");
const { isExternalUrl } = require("./external-url.cjs");
const { restoreWindow, windowSnapshot } = require("./window-state.cjs");
const { trayTemplate } = require("./tray-menu.cjs");
const { createTelemetry } = require("./telemetry/index.cjs");
const { writeAtomic } = require("./telemetry/state.cjs");
const { osMajor, updaterErrorKind, crashReason, exitCode, childSource, renderTarget, linuxSession, permissionFacts, flowEndReason, powerSignal } = require("./telemetry-map.cjs");

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
const AGENT_PORT_PREFERRED = 47823;
let AGENT_PORT = DEV ? Number(process.env.AGENT_PORT) || 47833 : AGENT_PORT_PREFERRED;
const WEB_PORT = Number(process.env.WEB_PORT) || (DEV ? 47834 : 47824);
// MUST be "localhost", not "127.0.0.1": Next dev's HMR websocket rejects a
// 127.0.0.1 origin (ERR_INVALID_HTTP_RESPONSE), and with Turbopack a dead HMR
// socket blocks hydration → the UI renders but nothing is clickable.
const WEB_HOST = "localhost";
const WEB_URL = `http://${WEB_HOST}:${WEB_PORT}`;

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

// ── the OpenLive home: ~/.openlive installed, <repo>/data in a dev checkout ───
// One paths module for every process (packages/shared/src/home), shipped
// beside the servers in a packaged build. Chromium's own files stay in userData.
const home = require(app.isPackaged ? path.join(process.resourcesPath, "home", "index.mjs") : path.join(__dirname, "..", "..", "packages", "shared", "src", "home", "index.mjs"));
const HOME = home.resolveHome({ packaged: app.isPackaged });
const PATHS = home.layout(HOME);
// Before anything reads the home: the installed app's files move in from userData,
// once. A dev checkout's data/ is reshaped in place by its servers instead.
if (app.isPackaged) home.migrateHome(HOME, { from: path.join(app.getPath("userData"), "data"), userData: app.getPath("userData") });
home.privateDir(PATHS.state);
const stateFile = (name) => path.join(PATHS.state, name);

const telemetry = createTelemetry({
  stateDir: PATHS.state,
  configPath: path.join(__dirname, "telemetry-config.json"),
  appVersion: app.getVersion(), platform: process.platform, arch: process.arch,
  archTranslated: !!app.runningUnderARM64Translation,
  osMajor: osMajor(process.platform, process.getSystemVersion(), os.release()),
  isPackaged: app.isPackaged, env: process.env, argv: process.argv,
  electronNet,
});
process.on("uncaughtException", () => telemetry.track("main_exception", { process: "main", kind: "uncaught" }));
process.on("unhandledRejection", () => telemetry.track("main_exception", { process: "main", kind: "unhandled_rejection" }));
const trackSetting = (setting, value) => telemetry.track("setting_changed", { setting, value });
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
const pidFile = () => stateFile("server-pids.json");
function recordServerPids() {
  try { fs.writeFileSync(pidFile(), JSON.stringify(children.map((c) => c.pid).filter(Boolean))); } catch { /* best-effort */ }
}
/** True when the last run left pids behind: it did not get to shut down cleanly. */
function reapRecordedPids() {
  let pids = [];
  try { pids = JSON.parse(fs.readFileSync(pidFile(), "utf8")); } catch { return false; }
  for (const pid of pids) if (alive(pid)) { console.error(`[main] reaping stale server pid ${pid}`); killTree(pid, "SIGKILL"); }
  try { fs.rmSync(pidFile(), { force: true }); } catch { /* */ }
  return pids.length > 0;
}

// Make both ports bindable before we spawn, or explain why we can't. Reap our own
// recorded zombies first; then, for anything still holding a port, kill it if it's
// ours. A foreign app on the agent's port just moves the agent; on the web port it
// gets ONE clear message (respawning can't fix that; issue #6's "web service keeps
// crashing" loop was exactly this case).
let uncleanPrevExit = false;
async function ensurePortsFree() {
  uncleanPrevExit = reapRecordedPids();
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
const serviceLabel = (name) => `${app.getName()} ${name}`;
const OWN_SERVICES = new Set(["agent", "web"].map(serviceLabel));
// Windows lets only the process in front raise a window, and that is this one
// whenever OpenLive's window is. The agent asks before each computer-use helper
// request, naming the helper's pid; the answer lets it go ahead.
function allowForeground(child, { id, pid }) {
  if (process.platform === "win32" && Number.isInteger(pid) && pid > 0) {
    try { flowInput.load().allowSetForegroundWindow(pid); }
    catch (e) { console.error("[computer] allow foreground:", e); }
  }
  child.postMessage({ openlive: "allow-foreground", id });
}
// A timer or reminder the agent fired. Shown even while OpenLive is in front:
// unlike "finished", it is news the user cannot already see. Each is held until
// clicked or closed, since a collected Notification drops its click on macOS.
const reminderNotes = new Set();
function showReminder({ title, body }) {
  if (!Notification.isSupported() || (title !== "Reminder" && title !== "Timer")) return;
  const n = new Notification({ title, body: String(body ?? "").slice(0, 240) });
  const done = () => reminderNotes.delete(n);
  n.on("click", () => { done(); void restoreMainWindow(); });
  n.on("close", done);
  reminderNotes.add(n);
  n.show();
}
function spawnServer(name, scriptRel, env) {
  const script = path.join(process.resourcesPath, scriptRel);
  const child = utilityProcess.fork(script, [], {
    env: { ...process.env, ...env },
    stdio: "inherit",
    serviceName: serviceLabel(name),
  });
  const spawnedAt = Date.now();
  child.once("spawn", recordServerPids);
  // Only the agent reports this way; web-side results reach main from the renderer.
  if (name === "agent") child.on("message", (msg) => {
    if (msg?.openlive === "allow-foreground") return allowForeground(child, msg);
    if (msg?.openlive === "notify") return showReminder(msg);
    telemetry.handleAgentMessage(msg);
  });
  child.on("exit", (code) => {
    const i = children.indexOf(child); if (i >= 0) children.splice(i, 1);
    recordServerPids();
    if (app.isQuitting || !code) return;
    console.error(`[${name}] exited with ${code}`);
    const crashed = (outcome, respawn_n) => telemetry.track("service_crashed", {
      service: name, exit_code: exitCode(code), respawn_n, outcome, uptime_s: (Date.now() - spawnedAt) / 1000,
    });
    // A dead server whose port is now held by a FOREIGN app can't be fixed by
    // respawning — say so once instead of the 5×-crash loop.
    const port = name === "agent" ? AGENT_PORT : WEB_PORT;
    const h = portHolder(port);
    if (h && !h.ours) {
      crashed("port_taken_by_other");
      dialog.showErrorBox("OpenLive can't start", `Port ${port} is being used by another program${h.name ? ` (${h.name})` : ""}. Close it and relaunch OpenLive.`);
      return;
    }
    const r = (restarts[name] ||= { count: 0, first: Date.now() });
    if (Date.now() - r.first > 60000) { r.count = 0; r.first = Date.now(); } // reset the window
    if (++r.count > 5) {
      crashed("gave_up", r.count);
      dialog.showErrorBox("OpenLive stopped", `The ${name} service keeps crashing. Relaunch the app; if it keeps happening, check that nothing else is using ports ${AGENT_PORT} and ${WEB_PORT}, and please attach any console output to a GitHub issue.`);
      return;
    }
    crashed("respawning", r.count);
    setTimeout(() => { if (!app.isQuitting) spawnServer(name, scriptRel, env); }, 500);
  });
  children.push(child);
  return child;
}

async function startServers() {
  if (DEV) return true; // dev servers come from `pnpm dev`
  if (!(await ensurePortsFree())) return false;
  // The agent binds loopback only (services/agent/src/server.ts defaults AGENT_HOST
  // to 127.0.0.1), so it is never reachable off this machine. That closes the LAN
  // exposure by itself; the renderer connects over localhost.
  spawnServer("agent", "agent/agent.mjs", {
    AGENT_PORT: String(AGENT_PORT),
    AGENT_HOST: "127.0.0.1",
    OPENLIVE_HOME: HOME,
    WEB_PUBLIC_URL: WEB_URL,
    OPENLIVE_AGENT_SECRET: AGENT_TOKEN,
    // The computer-use helper the agent drives; its own app, so its grants are its own.
    ...(process.platform === "darwin" && { OPENLIVE_CU_HELPER: path.join(process.resourcesPath, "OpenLive Computer Use.app", "Contents", "MacOS", "openlive-cu") }),
    ...(process.platform === "win32" && { OPENLIVE_CU_HELPER: path.join(process.resourcesPath, "openlive-cu.exe") }),
    ...(process.platform === "linux" && { OPENLIVE_CU_HELPER: path.join(process.resourcesPath, "openlive-cu") }),
    // Where OpenLive is installed: the helper never picks a window from there as
    // the default target, so "look at the app" in Chat is not OpenLive itself.
    OPENLIVE_CU_OWN_ROOT: process.platform === "darwin" ? path.resolve(process.execPath, "..", "..", "..") : path.dirname(process.execPath),
  });
  // Web (Next standalone) serves the UI + the /api settings routes (JSON store).
  // AGENT_PORT: the /api/voice proxy forwards to the agent on localhost.
  spawnServer("web", "web/server.js", {
    PORT: String(WEB_PORT),
    HOSTNAME: WEB_HOST,
    NODE_ENV: "production",
    OPENLIVE_HOME: HOME,
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

// ── window bounds: remember size, position, maximized and fullscreen ─────────
const windowStateFile = () => stateFile("window-state.json");
const MAIN_MIN = { width: 940, height: 640 };
function loadWindowState() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(windowStateFile(), "utf8")); } catch { /* no saved state */ }
  return restoreWindow(saved, { displays: screen.getAllDisplays(), primary: screen.getPrimaryDisplay(), min: MAIN_MIN });
}
function saveWindowState() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try { writeAtomic(fs, windowStateFile(), JSON.stringify(windowSnapshot(mainWin))); } catch { /* best-effort */ }
}

// ── one-time things (first ⌘Q notice, the login-item default) ────────────────
const onceFile = () => stateFile("once.json");
/** True the first time it's asked about `name`, false on every call after. */
function firstTime(name) {
  let done = {};
  try { done = JSON.parse(fs.readFileSync(onceFile(), "utf8")); } catch { /* first run */ }
  if (done[name]) return false;
  done[name] = true;
  try { fs.writeFileSync(onceFile(), JSON.stringify(done)); } catch { /* best-effort */ }
  return true;
}

// ── appearance: the theme and the look, known here before any page loads ─────
// The renderer owns the choices (Settings, the palette) and reports them; this
// process keeps them so the splash and the window's first frame already match,
// and owns the OS material, which only it can switch.
const LOOK_MS = 400;          // --dur-look in globals.css: the page's cross-fade
const VIBRANCY = "under-window";
const CLEAR = "#00000000";
const PAGE_BG = { dark: "#0b0b0c", light: "#efede8" }; // --background in .dark / :root
const THEMES = new Set(["system", "light", "dark"]);
const appearanceFile = () => stateFile("appearance.json");
let appearance = {};          // { theme, look, probe: { version, slow } }
let look = "flat";            // what the main window wears right now
let lookTimer = null;
let winTransparencyOff = false;

function loadAppearance() {
  try { appearance = JSON.parse(fs.readFileSync(appearanceFile(), "utf8")) || {}; } catch { appearance = {}; }
  // Native surfaces (the material's tint, the title bar) follow the app's theme, not the OS's.
  nativeTheme.themeSource = THEMES.has(appearance.theme) ? appearance.theme : "system";
  readWinTransparency();
  look = effectiveLook(appearance.look, glassSupportNow());
}
function saveAppearance() {
  try { fs.writeFileSync(appearanceFile(), JSON.stringify(appearance)); } catch { /* best-effort */ }
}

// Windows' "Transparency effects" switch, read directly as well: Chromium's
// reduced-transparency signal is not documented to follow it there.
function readWinTransparency() {
  if (process.platform !== "win32" || !osHasGlass("win32", os.release())) return;
  const out = sh('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v EnableTransparency');
  winTransparencyOff = /EnableTransparency\s+REG_DWORD\s+0x0\b/i.test(out);
}

function glassSupportNow() {
  return glassSupport({
    platform: process.platform,
    release: os.release(),
    gpuCompositing: app.getGPUFeatureStatus().gpu_compositing,
    reducedTransparency: nativeTheme.prefersReducedTransparency || winTransparencyOff,
    // The renderer's frame-time probe, trusted for the version that measured it.
    slow: appearance.probe?.version === app.getVersion() && !!appearance.probe.slow,
  });
}

const pageBg = () => (nativeTheme.shouldUseDarkColors ? PAGE_BG.dark : PAGE_BG.light);
const isMainWc = (wc) => !!mainWin && !mainWin.isDestroyed() && wc === mainWin.webContents;
/** Whether an IPC message came from `win`'s page. */
const sentBy = (e, win) => !!win && !win.isDestroyed() && e.sender === win.webContents;

/** What a page needs to draw itself. Only the main window wears the look: the
 *  owner is never shown and the orb keeps its own. `probe` asks the renderer to
 *  time glass once per app version. */
function appearanceFor(wc) {
  const main = isMainWc(wc);
  return {
    saved: appearance.look ?? null,
    look: main ? look : "flat",
    support: glassSupportNow(),
    probe: main && look === "glass" && appearance.probe?.version !== app.getVersion(),
  };
}

/** Constructor options for a window's first frame in the look. Never
 *  `transparent: true`: that loses resizing and maximize on Windows and costs
 *  the voice models GPU time on macOS. The OS material draws behind a clear
 *  background instead, and can be switched on a live window. */
function materialOptions(l) {
  const glass = l === "glass";
  return {
    backgroundColor: glass ? CLEAR : pageBg(),
    // The material would otherwise go grey whenever another app has focus.
    visualEffectState: "active",
    ...(glass && process.platform === "darwin" ? { vibrancy: VIBRANCY } : {}),
    ...(glass && process.platform === "win32" ? { backgroundMaterial: "acrylic" } : {}),
  };
}

function setMaterial(win, l) {
  if (!win || win.isDestroyed()) return;
  const glass = l === "glass";
  if (process.platform === "darwin") win.setVibrancy(glass ? VIBRANCY : null);
  if (process.platform === "win32" && osHasGlass("win32", os.release())) win.setBackgroundMaterial(glass ? "acrylic" : "none");
  win.setBackgroundColor(glass ? CLEAR : pageBg());
}

function sendAppearance() {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("openlive:appearance-changed", appearanceFor(mainWin.webContents));
}

/** Re-decide the look (a choice, a probe, or the OS changed) and switch it
 *  without a hard cut: glass goes on under the still-opaque page before the
 *  page fades to show it; flat fades the page opaque first and only then takes
 *  the glass away. */
function refreshLook() {
  const next = effectiveLook(appearance.look, glassSupportNow());
  if (next === look) { sendAppearance(); return; }
  look = next;
  clearTimeout(lookTimer);
  if (look === "glass") { setMaterial(mainWin, look); sendAppearance(); return; }
  sendAppearance();
  lookTimer = setTimeout(() => setMaterial(mainWin, look), LOOK_MS);
}

function wireAppearance() {
  ipcMain.on("openlive:appearance", (e) => { e.returnValue = appearanceFor(e.sender); });
  ipcMain.handle("openlive:appearance-set", (e, patch) => {
    let changed = false;
    if (THEMES.has(patch?.theme) && patch.theme !== appearance.theme) {
      // The page reports its theme on every mount, so the first report is a sync, not a choice.
      if (appearance.theme) trackSetting("theme", patch.theme);
      appearance.theme = patch.theme;
      nativeTheme.themeSource = patch.theme;
      changed = true;
    }
    if ((patch?.look === "glass" || patch?.look === "flat") && patch.look !== appearance.look) {
      trackSetting("look", patch.look);
      appearance.look = patch.look;
      changed = true;
    }
    if (typeof patch?.slow === "boolean" && isMainWc(e.sender)) {
      appearance.probe = { version: app.getVersion(), slow: patch.slow };
      changed = true;
    }
    if (changed) { saveAppearance(); refreshLook(); }
    return appearanceFor(e.sender);
  });
  // The OS theme, reduce transparency (both OSes watch it) and GPU state can all
  // change under a running app.
  nativeTheme.on("updated", () => {
    readWinTransparency();
    if (look === "flat" && mainWin && !mainWin.isDestroyed()) mainWin.setBackgroundColor(pageBg());
    refreshLook();
  });
  app.on("gpu-info-update", refreshLook);
}

// ── windows ──────────────────────────────────────────────────────────────────
function createSplash() {
  splashWin = new BrowserWindow({
    width: 420, height: 300, frame: false, resizable: false, movable: true,
    ...materialOptions(look), show: true, center: true, hasShadow: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  splashWin.loadFile(path.join(__dirname, "splash.html"), {
    query: { v: app.getVersion(), theme: nativeTheme.shouldUseDarkColors ? "dark" : "light", look },
  });
  splashWin.on("closed", () => { splashWin = null; });
}

function createMainWindow() {
  const saved = loadWindowState();
  mainWin = new BrowserWindow({
    width: saved?.width || 1180, height: saved?.height || 800, minWidth: MAIN_MIN.width, minHeight: MAIN_MIN.height,
    ...(saved && saved.x != null ? { x: saved.x, y: saved.y } : {}),
    show: false,
    // Never `transparent: true`: transparent windows take a slower macOS compositing
    // path that competes with the on-device WebGPU voice models (adds turn latency),
    // render as a black wall on some GPUs, and lose maximize on Windows. Glass is the
    // OS material behind a clear background instead (materialOptions).
    // macOS: titleBarStyle "hidden" keeps the NATIVE traffic lights (positioned to match
    // the old custom dots) AND real OS fullscreen — a fully frameless window degrades the
    // green button to a maximize. Win/Linux stay frameless with our own controls.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 14 } }
      : { frame: false }),
    roundedCorners: true,
    ...materialOptions(look),
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
  for (const ev of ["resize", "move", "close", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) mainWin.on(ev, saveWindowState);
  // A backstop for OS settings that change without telling nativeTheme.
  mainWin.on("focus", refreshLook);
  mainWin.on("focus", () => telemetry.markActiveDay("main_window"));

  // Open external http(s) links (docs, etc.) in the real browser; DENY every other
  // popup (file:, data:, etc.) rather than letting it open an in-app window.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Keep the main frame pinned to our own UI: an in-page navigation to anywhere
  // other than the local app is blocked (http(s) is handed to the real browser).
  mainWin.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(WEB_URL)) return;
    e.preventDefault();
    if (isExternalUrl(url)) shell.openExternal(url);
  });

  mainWin.loadURL(WEB_URL);
  mainWin.once("ready-to-show", () => {
    // Before show, so it opens in that state rather than animating into it.
    if (saved?.maximized) mainWin.maximize();
    if (saved?.fullscreen) mainWin.setFullScreen(true);
    mainWin.show();
    if (splashWin) splashWin.close();
    refreshTray();
    // DevTools available via View menu / Cmd+Opt+I — not auto-opened (it covered the UI).
  });
  mainWin.on("session-end", onSessionEnd);
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
    if (callState) telemetry.closeCall("window_closed");
    callState = null;
    syncCallOrb();
    refreshTray();
    syncDock();
    // No tray (some Linux desktops have none): nothing would be left to quit from.
    if (!tray && process.platform !== "darwin") quitApp("no_tray");
  });
  for (const ev of ["show", "hide"]) mainWin.on(ev, () => { refreshTray(); syncDock(); });
  for (const ev of ["show", "hide", "minimize", "restore"]) mainWin.on(ev, syncCallOrb);
  // With backgroundThrottling off the page never reads as hidden, so it is told,
  // and polls that only feed the screen sleep until it is back.
  const tellShown = () => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("openlive:window-shown", mainWin.isVisible() && !mainWin.isMinimized()); };
  for (const ev of ["show", "hide", "minimize", "restore"]) mainWin.on(ev, tellShown);
}

/** The floating orb window: chromeless, transparent, always on top, on every
 *  Space, and never taking focus from the app underneath. Nothing in it takes
 *  typing, so no platform needs it focusable. */
function makePanelWindow(route, bounds) {
  const win = new BrowserWindow({
    ...bounds,
    show: false, frame: false, resizable: false, skipTaskbar: true,
    // Transparent so the renderer can draw a real rounded, floating orb (border +
    // shadow + gaps around it) instead of an opaque rectangle. hasShadow off — the
    // OS shadow would trace the rectangular window; the orb casts its own via CSS.
    transparent: true, backgroundColor: "#00000000", hasShadow: false,
    // Clicks land on its buttons without pulling focus from the app the user
    // is typing into: a non-activating "panel" on macOS, a no-activate window
    // on Windows, and one the window manager never focuses on Linux.
    focusable: false,
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "floating", 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Electron's panel still activates OpenLive on a click, bringing the main
  // window to the front over the app the person was in; the addon stops that.
  if (process.platform === "darwin") {
    try { flowInput.load().preventActivation(win.getNativeWindowHandle()); }
    catch (e) { console.error("[main] panel activation:", e); }
  }
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
// Why the open Flow ends, as the dismiss that starts the exit says. Later dismisses
// of the same exit (the renderer answering Flow being switched off) are ignored.
let flowEndedBy = "other";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const ORB_POINTER = orbPointer.pointerMode(process.platform, process.env);
let pointerTimer = null;
let lastPointer;

/** Clicks through the empty air, or onto the orb. Wayland cannot hand back the
 *  moves that decide which, so there the window takes clicks while it is up. */
function setClickThrough(win, through) {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(through && ORB_POINTER !== "solid", { forward: true });
}

/** X11 forwards no moves to a click-through window, so while the orb is shown
 *  its cursor is polled and handed to the renderer's hit test as a move, only
 *  when it changes. One cursor query per tick, nothing while hidden. */
function watchPointer(win) {
  if (ORB_POINTER !== "poll") return;
  const stop = () => { clearInterval(pointerTimer); pointerTimer = null; lastPointer = undefined; };
  win.on("show", () => {
    stop();
    pointerTimer = setInterval(() => {
      if (win.isDestroyed()) { stop(); return; }
      const p = orbPointer.pointInWindow(screen.getCursorScreenPoint(), win.getBounds());
      if (orbPointer.samePoint(p, lastPointer)) return;
      lastPointer = p;
      win.webContents.send("openlive:flow-pointer", p);
    }, orbPointer.POLL_MS);
  });
  win.on("hide", stop);
  win.on("closed", stop);
}

function createOwnerWindow() {
  if (ownerWin && !ownerWin.isDestroyed()) return ownerWin;
  ownerWin = new BrowserWindow({
    width: 480, height: 320, show: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, additionalArguments: agentArgs() },
  });
  ownerWin.loadURL(`${WEB_URL}/flow-owner`);
  ownerWin.on("session-end", onSessionEnd);
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
  setClickThrough(flowWin, true);
  watchPointer(flowWin);
  // Showing the window resets it to click-through, so the renderer has to be
  // told: it tracks whether the pointer is on the orb, and a stale "yes" from
  // before it was hidden would stop it ever asking for the clicks back.
  flowWin.on("show", () => {
    if (flowWin && !flowWin.isDestroyed()) flowWin.webContents.send("openlive:flow-shown");
  });
  flowWin.on("closed", () => { flowWin = null; });
  return flowWin;
}

function summonFlow(_e, mode) {
  const win = createFlowWindow();
  // A summon of an open Flow (a resumed session, a new turn) is the same open.
  // Dictate shows the same orb but is not a Flow session, so it is not counted as one.
  if (!flowCounted && mode !== "dictate") {
    flowCounted = true;
    telemetry.openFlow();
    telemetry.markActiveDay("flow");
    telemetry.reportOnboardingStep("first_flow_summon");
  }
  flowEndedBy = "other";
  flowSummoned = true;
  refreshTray();
  // The window may be up showing a call; Flow's own orb takes over from it.
  win.webContents.send("openlive:call-orb", null);
  // A gesture that closed Flow mid-hover would otherwise leave it clickable.
  setClickThrough(win, true);
  // `showInactive` on an already-visible window emits no "show", and a summon
  // of an open Flow is an ordinary thing (a resumed session, a new turn).
  // A summon mid-exit cancels the hide; that "shown" brings the orb back.
  clearTimeout(flowHiding);
  flowHiding = null;
  if (win.isVisible()) { win.webContents.send("openlive:flow-shown"); lastPointer = undefined; }
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
function dismissFlow(reason) {
  if (!flowWin || flowWin.isDestroyed() || !flowSummoned || flowHiding) return;
  flowEndedBy = reason;
  if (!flowWin.isVisible()) { flowSummoned = false; closeFlowCount(); syncCallOrb(); refreshTray(); return; }
  setClickThrough(flowWin, true);
  flowWin.webContents.send("openlive:flow-hiding");
  flowHiding = setTimeout(finishDismissFlow, FLOW_EXIT_MS);
}

function finishDismissFlow() {
  clearTimeout(flowHiding);
  flowHiding = null;
  flowSummoned = false;
  closeFlowCount();
  if (flowWin && !flowWin.isDestroyed()) flowWin.hide();
  syncCallOrb();
  refreshTray();
}

/** A display was added, removed or rearranged while the orb was up: re-dock it
 *  over whichever work area it now sits nearest. */
function reclampFlow() {
  if (!flowWin || flowWin.isDestroyed() || !flowWin.isVisible()) return;
  flowWin.setBounds(flowBounds(screen.getDisplayMatching(flowWin.getBounds())));
}

// The orb's full-screen control. Flow is ambient, so the window it opens may
// not exist yet, and it opens on Flow, which is what the person was in.
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

/** The tray's "Start Flow": the gesture itself, fired from here, so the
 *  owner renderer opens Flow exactly as a double tap would. The addon's trigger
 *  is a toggle, so an open Flow is not sent it: the owner starts the fresh
 *  session there instead, and leaves a turn that is still running alone. */
const FLOW_BINDING = "flow"; // useFlowOwner's BINDING_ID
function startFlowFromTray() {
  const tell = (wasOpen) => {
    if (ownerWin && !ownerWin.isDestroyed()) ownerWin.webContents.send("openlive:flow-new-session", wasOpen);
  };
  if (flowSummoned) return tell(true);
  try {
    flowInput.load().triggerExternal(FLOW_BINDING, true);
    // The trigger reaches the owner as an effect from the addon's thread, later than this send.
    tell(false);
  } catch (e) { console.error("[main] tray flow:", e); }
}

function wireFlowIpc() {
  flowRuntime.install(telemetry);
  ipcMain.on("openlive:flow-summon", summonFlow);
  ipcMain.on("openlive:flow-dismiss", (_e, reason) => dismissFlow(flowEndReason(reason)));
  // The renderer owns the hit test: the orb and its controls take clicks, the
  // empty air around them does not.
  ipcMain.on("openlive:flow-interactive", (_e, on) => setClickThrough(flowWin, !on));
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

/** Flow's off switch, from Settings > Flow. One state, told to everyone who
 *  draws it, so the tray and the windows can never disagree. */
function setFlowArmed(next) {
  const was = flowInput.isArmed();
  const armed = flowInput.setArmed(next);
  if (armed !== was) trackSetting("flow_armed", armed ? "on" : "off");
  if (!armed) dismissFlow("disarmed");
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
let callEndedBy = "other"; // what main knows of why it ends; the renderer's own reason outranks it
let flowSummoned = false;
let flowCounted = false; // summoned as Flow, not only for Dictate: a Flow session telemetry has opened

function closeFlowCount() {
  if (flowCounted) telemetry.closeFlow(flowEndedBy);
  flowCounted = false;
}

const callOrbWanted = () => !!callState && !!mainWin && !mainWin.isDestroyed()
  && (mainWin.isMinimized() || !mainWin.isVisible());

function syncCallOrb() {
  if (!flowWin || flowWin.isDestroyed() || flowSummoned || flowHiding) return;
  const want = callOrbWanted();
  flowWin.webContents.send("openlive:call-orb", want ? callState : null);
  if (!want) { if (flowWin.isVisible()) flowWin.hide(); return; }
  if (flowWin.isVisible()) return;
  setClickThrough(flowWin, true);
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
  telemetry.markActiveDay("tray");
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
const TRAY_READINESS_POLL_MS = 3000;
/** What the menu says depends on. Readiness comes from the same test the Flow window uses. */
const trayState = () => ({ readiness: flowInput.readiness(), open: flowSummoned, binding: flowInput.binding(FLOW_BINDING), platform: process.platform });
let trayShows = "";
let reportedReadiness = null;
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
  if (!tray) { quitApp("app_menu"); return; } // nowhere to live on
  if (mainWin) mainWin.close();
  if (firstTime("closedToMenuBar") && Notification.isSupported()) {
    const n = new Notification({ title: `OpenLive is still running in the ${TRAY_PLACE}`, body: `Flow stays ready. Quit from the ${TRAY_PLACE} icon.`, silent: true });
    n.on("click", () => restoreMainWindow());
    n.show();
  }
}

/** `via` says which path asked, for app_quit: tray_menu, app_menu, no_tray or boot_failed. */
function quitApp(via) {
  telemetry.onQuit(via);
  app.isQuitting = true;
  app.quit();
}

/** The readiness the poll just saw, with the grants behind it. Telemetry sends only a change. */
function reportReadiness(to) {
  let grants = {};
  try { grants = permissionFacts(flowInput.load().permissionStatus()); } catch { /* the addon said nothing */ }
  telemetry.reportReadiness({ to, ...grants, linux_session: linuxSession(process.platform, ORB_POINTER) });
}

function createTray() {
  try {
    // macOS tints a Template image to suit a light or dark menu bar; elsewhere
    // templates mean nothing, so the tray gets the colour mark. Both load their @2x.
    const img = nativeImage.createFromPath(path.join(__dirname, "build", process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
    tray = new Tray(img);
    tray.setToolTip("OpenLive");
    refreshTray();
    // A grant, or a key listener dying, is never announced, so the state is
    // re-read and the menu rebuilt only when it would say something different.
    setInterval(() => {
      refreshTray();
      const readiness = flowInput.readiness();
      if (readiness !== reportedReadiness) { reportedReadiness = readiness; reportReadiness(readiness); }
    }, TRAY_READINESS_POLL_MS).unref();
  } catch (e) { console.error("[main] tray:", e); } // no tray beats no app
}

/** A tray menu click: counted, then run. */
const fromTray = (action, run) => () => {
  telemetry.track("tray_action", { action });
  run();
};

/** Rebuild the tray menu against the CURRENT state: a menu built once at boot
 *  would quietly lie about modes you are in or out of. Only when it would say
 *  something different, so an open menu is not swapped out from under the pointer. */
function refreshTray() {
  if (!tray) return;
  const state = trayState();
  const shows = JSON.stringify(state);
  if (shows === trayShows) return;
  trayShows = shows;
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(state, {
    open: fromTray("open", restoreMainWindow),
    startFlow: fromTray("new_flow", startFlowFromTray),
    allowAccess: fromTray("allow_accessibility", () => void flowInput.request("accessibility", "other").catch((e) => console.error("[main] tray access:", e))),
    settings: fromTray("settings", openSettings),
    quit: fromTray("quit", () => quitApp("tray_menu")),
  })));
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
  ipcMain.on("openlive:panel-state", (e, s) => {
    if (sentBy(e, ownerWin) && flowWin && !flowWin.isDestroyed()) flowWin.webContents.send("openlive:panel-state", s);
  });
  ipcMain.on("openlive:panel-cmd", (e, c) => {
    if (sentBy(e, flowWin) && ownerWin && !ownerWin.isDestroyed()) ownerWin.webContents.send("openlive:panel-cmd", c);
  });
  // The main window's call, for the orb: null once it ends.
  ipcMain.on("openlive:call-state", (e, s) => {
    if (!sentBy(e, mainWin)) return;
    const was = callState;
    callState = s ? { muted: !!s.muted, startedAt: Number(s.startedAt) || Date.now() } : null;
    if (!was && callState) {
      callEndedBy = "other";
      telemetry.openCall();
      telemetry.markActiveDay("call");
      telemetry.reportOnboardingStep("first_call");
    } else if (was && !callState) telemetry.closeCall(callEndedBy);
    syncCallOrb();
  });
  // The orb's call controls. Open is the window's business, the rest the call's.
  ipcMain.on("openlive:call-cmd", (e, c) => {
    if (!sentBy(e, flowWin)) return;
    if (c?.t === "expand") restoreMainWindow();
    else if ((c?.t === "mute" || c?.t === "end") && mainWin && !mainWin.isDestroyed()) {
      if (c.t === "end") callEndedBy = "orb_end";
      mainWin.webContents.send("openlive:panel-cmd", c);
    }
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
    if (typeof v === "boolean") { loginItem(v); buildMenu(); trackSetting("login_item", v ? "on" : "off"); }
    return loginItem();
  });
  // Settings → General: whether a screen lock ends Flow and calls. Invoke with a
  // boolean to set; with undefined to just read.
  ipcMain.handle("openlive:end-on-lock", (_e, v) => {
    if (typeof v === "boolean") setEndOnLock(v);
    return endOnLock;
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
    let outcome = "error";
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
      if (response !== 1) { outcome = "cancelled"; return { cancelled: true }; }
      const res = await fetch(`${WEB_URL}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-openlive-confirmed": SETTINGS_TOKEN },
        body: JSON.stringify({ ollamaBaseUrl: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) outcome = "accepted";
      return res.ok ? { settings: body } : { error: body.error || "Couldn't save the address." };
    } catch {
      return { error: "Couldn't save the address." };
    } finally {
      confirmingOllama = false;
      telemetry.track("remote_ollama_prompt", { outcome, scheme: u.protocol === "https:" ? "https" : "http" });
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

// ── screen lock: does it end Flow and calls the way sleep does? ──────────────
// On by default; a person who keeps working across a lock (a long call, a running
// task) can turn it off. Sleep is never up to them. Electron emits lock-screen and
// unlock-screen on macOS and Windows only, so on Linux this has no effect.
const preferencesFile = () => stateFile("preferences.json");
let endOnLock = true;

function loadPreferences() {
  try { endOnLock = JSON.parse(fs.readFileSync(preferencesFile(), "utf8")).endOnLock !== false; } catch { /* first run: the default */ }
}
function setEndOnLock(on) {
  if (on === endOnLock) return;
  endOnLock = on;
  try { writeAtomic(fs, preferencesFile(), JSON.stringify({ endOnLock })); } catch { /* best-effort */ }
  trackSetting("end_on_lock", on ? "on" : "off");
}

// ── power events → renderer (pause the mic/VAD cleanly instead of waking up
// with a stuck pipeline after the laptop slept mid-call) ──────────────────────
function wirePowerEvents() {
  const send = (event) => {
    const state = powerSignal(event, endOnLock);
    if (state) for (const win of [mainWin, ownerWin]) if (win && !win.isDestroyed()) win.webContents.send("openlive:power", state);
  };
  for (const event of ["suspend", "lock-screen", "resume", "unlock-screen"]) powerMonitor.on(event, () => send(event));
  // Logout / restart / shutdown (macOS, Linux) must never be held up by
  // before-quit's close-to-menu-bar. Windows skips before-quit for these anyway.
  powerMonitor.on("shutdown", () => { app.isQuitting = true; telemetry.onQuit("os_shutdown"); });
}

// Windows ends the session on logoff, restart and shutdown without before-quit, and gives
// no time after this: all of it is synchronous. Our servers die with the session, so
// their pids are not stale and the next launch must not read them as a crash.
let sessionEnded = false;
function onSessionEnd() {
  if (sessionEnded) return;
  sessionEnded = true;
  app.isQuitting = true;
  telemetry.onQuit("os_shutdown");
  try { fs.writeFileSync(pidFile(), "[]"); } catch { /* best-effort */ }
}

// ── Settings > About: reset local data ───────────────────────────────────────
// Asked in a native dialog, since page script can call this too (a model-authored
// canvas runs in-origin). Stops both servers, clears this app's browser storage,
// empties the home and starts again. Coding agents keep their own folders
// (~/.claude, ~/.codex and the like), which sit outside the home and are never touched.
function wireResetIpc() {
  ipcMain.handle("openlive:reset-data", async (e) => {
    if (!sentBy(e, mainWin)) return { error: "Only OpenLive's window can reset its data." };
    if (DEV) return { error: `A dev checkout's servers run from pnpm, so OpenLive cannot stop them. Stop them and empty ${HOME} yourself.` };
    const refused = home.wipeRefusal(HOME);
    if (refused) return { error: `Reset refused: ${refused}` };
    const { response } = await dialog.showMessageBox(mainWin, {
      type: "warning", buttons: ["Erase everything", "Cancel"], defaultId: 1, cancelId: 1,
      message: "Erase all of OpenLive's data on this computer?",
      detail: `Everything in ${HOME} goes: chats, Dictate history, memory, settings, skills, saved keys, logs, downloaded voice models and the files in Flow's workspace. It cannot be undone, and OpenLive starts again fresh.\n\nYour coding agents keep their own sessions and logins. If usage data is off, it stays off.`,
    });
    if (response !== 0) return { cancelled: true };
    const { enabled, noticeSeen } = telemetry.getStatus();
    app.isQuitting = true;
    await killChildren();
    const ses = session.defaultSession;
    await ses.clearStorageData({ origin: new URL(WEB_URL).origin }).catch((err) => console.error("[reset] storage:", err));
    await ses.clearCache().catch((err) => console.error("[reset] cache:", err));
    // Nothing awaits from here to the exit, so no timer of this process writes into the emptied home.
    let failed = null;
    try { home.wipeHome(HOME); } catch (err) { failed = err; }
    if (noticeSeen && !enabled) {
      try { home.privateDir(PATHS.state); fs.writeFileSync(stateFile("telemetry-off"), "", { mode: 0o600 }); } catch { /* the notice asks again */ }
    }
    if (failed) dialog.showErrorBox("OpenLive could not erase everything", `${failed.message || failed}\n\nWhat is left is in ${HOME}. OpenLive starts again now.`);
    app.relaunch();
    app.exit(0);
  });
}

// ── telemetry: what pages and Chromium report ────────────────────────────────
// Only the main window and Flow's owner may speak (the orb only draws), and each
// message is checked against the schema in telemetry before it is kept.
function wireTelemetryIpc() {
  const fromApp = (e) => sentBy(e, mainWin) || sentBy(e, ownerWin);
  ipcMain.on("openlive:telemetry", (e, msg) => { if (fromApp(e)) telemetry.handleRendererMessage(msg); });
  ipcMain.handle("openlive:telemetry-get", (e) => (fromApp(e) ? telemetry.getStatus() : null));
  ipcMain.handle("openlive:telemetry-set", (e, enabled, from) => {
    if (fromApp(e) && typeof enabled === "boolean") return telemetry.setEnabled(enabled, from === "notice" ? "notice" : "settings");
  });
  ipcMain.handle("openlive:telemetry-feedback-next", (e) => (fromApp(e) ? telemetry.feedbackNext() : null));
  ipcMain.handle("openlive:telemetry-feedback-allow", (e, allowed) => { if (fromApp(e) && typeof allowed === "boolean") telemetry.setFeedback(allowed); });
}

// A quit tears processes down on purpose, so nothing here counts while one runs. Our own
// servers are left to service_crashed. No crash reporter runs: these events are the whole story.
function wireCrashReports() {
  const wcOf = (win) => (win && !win.isDestroyed() ? win.webContents : null);
  app.on("render-process-gone", (_e, wc, details) => {
    const reason = crashReason(details?.reason);
    if (!reason || app.isQuitting) return;
    const target = renderTarget(wc, { main_window: wcOf(mainWin), flow_owner: wcOf(ownerWin), flow_orb: wcOf(flowWin), splash: wcOf(splashWin) });
    telemetry.track("crash_detected", { source: "renderer", reason, target, exit_code: exitCode(details.exitCode) });
  });
  app.on("child-process-gone", (_e, details) => {
    const reason = crashReason(details?.reason);
    if (!reason || app.isQuitting || OWN_SERVICES.has(details.name) || OWN_SERVICES.has(details.serviceName)) return;
    telemetry.track("crash_detected", { source: childSource(details.type), reason, target: "none", exit_code: exitCode(details.exitCode) });
  });
}

// ── OS bridge for agent tools (clipboard / open a URL) ───────────────────────
// The agent's reveal/open paths are model-driven — scope them to the bound
// workspace (reported by the renderer on every bind) plus the app's own data,
// its scratch files and its skills folder. Never secrets/ or the rest of the home.
let workspaceDir = "";
function pathAllowed(p) {
  let real;
  try { real = fs.realpathSync(path.resolve(String(p ?? ""))); } catch { return false; }
  const roots = [workspaceDir, PATHS.data, PATHS.cache, PATHS.skills].filter(Boolean);
  return roots.some((root) => {
    try { const r = fs.realpathSync(root); return real === r || real.startsWith(r + path.sep); } catch { return false; }
  });
}

function wireBridgeIpc() {
  ipcMain.on("openlive:workspace", (_e, dir) => { workspaceDir = String(dir ?? ""); });
  ipcMain.handle("openlive:bridge", async (_e, { op, arg }) => {
    try {
      if (op === "clipboard_read") { const t = await clipboard.readText(); return t ? `The clipboard contains: ${t}` : "The clipboard is empty."; }
      if (op === "clipboard_write") { await clipboard.writeText(String(arg ?? "")); return "Copied it to the clipboard."; }
      if (op === "pick_folder") {
        const opts = { title: "Choose a project folder", properties: ["openDirectory", "createDirectory"] };
        const r = await (mainWin ? dialog.showOpenDialog(mainWin, opts) : dialog.showOpenDialog(opts));
        return r.canceled ? "" : (r.filePaths[0] ?? "");
      }
      // Settings, About: the whole folder, opened where the person can see it.
      if (op === "open_home") { const err = await shell.openPath(HOME); return err || "Opened."; }
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
    { label: "Quit OpenLive", click: () => quitApp("app_menu") },
  ];
  const template = [
    ...(isMac ? [{ role: "appMenu", submenu: [
      { role: "about", label: "About OpenLive" },
      { label: "Check for Updates…", click: checkForUpdatesNow },
      { type: "separator" },
      { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openSettings() },
      { label: "Open at Login", type: "checkbox", checked: loginItem(),
        click: (mi) => { loginItem(mi.checked); trackSetting("login_item", mi.checked ? "on" : "off"); } },
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
  updater.on("update-available", (i) => {
    console.log("[updater] update available:", i?.version);
    telemetry.track("update_result", { stage: "available", to_version: i?.version, manual: manualCheck });
    manualCheck = false;
  });
  updater.on("update-not-available", () => {
    console.log("[updater] up to date");
    if (!manualCheck) return;
    manualCheck = false;
    telemetry.track("update_result", { stage: "up_to_date", manual: true });
    if (mainWin) dialog.showMessageBox(mainWin, { type: "info", message: "You're up to date", detail: `OpenLive ${app.getVersion()} is the latest version.` });
  });
  updater.on("download-progress", (p) => console.log(`[updater] downloading ${Math.round(p?.percent || 0)}%`));
  updater.on("update-downloaded", async ({ version }) => {
    telemetry.track("update_result", { stage: "downloaded", to_version: version });
    // Menu-bar-only there is no window to hang the ask on, and a parentless
    // dialog from a background app opens behind whatever is in front.
    if (process.platform === "darwin" && !mainWin?.isVisible()) app.focus({ steal: true });
    const { response } = await dialog.showMessageBox(mainWin, {
      type: "info", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1,
      message: `OpenLive ${version} is ready`, detail: "Restart to finish updating.",
    });
    telemetry.track("update_result", { stage: response === 0 ? "restart_now" : "restart_later", to_version: version });
    if (response === 0) {
      telemetry.onQuit("update_restart");
      app.isQuitting = true;
      await killChildren();
      try { updater.quitAndInstall(); } catch (e) { console.error("[updater]", e?.message || e); telemetry.resume(); }
    }
  });
  updater.on("error", (e) => {
    console.error("[updater]", e?.message || e);
    telemetry.resume(); // an install that fails after "Restart now" leaves the app running
    telemetry.track("update_result", { stage: "failed", error_kind: updaterErrorKind(e), manual: manualCheck });
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

/** app_launch, once boot has an answer. boot_ms runs from process start to both servers answering, so only a good boot has one. */
function reportLaunch(launchKind, bootResult, startedAt) {
  telemetry.track("app_launch", {
    launch_kind: launchKind,
    boot_result: bootResult,
    ...(bootResult === "ok" && { boot_ms: Date.now() - startedAt }),
    agent_port_moved: !DEV && AGENT_PORT !== AGENT_PORT_PREFERRED,
    prev_exit_clean: !uncleanPrevExit,
    login_item: loginItem(),
    linux_session: linuxSession(process.platform, ORB_POINTER),
    look,
    glass_blocked_by: glassSupportNow().reason ?? "none",
    theme: THEMES.has(appearance.theme) ? appearance.theme : "system",
  });
}

async function boot() {
  const startedAt = process.getCreationTime() ?? Date.now();
  const openedAtLogin = process.argv.includes(HIDDEN_ARG)
    || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
  const launchKind = openedAtLogin ? "login" : "manual";
  // Before anything creates once.json: what the state folder already holds is how a new install tells from an upgrade.
  telemetry.start({ launchKind });
  // The packaged app takes its dock icon from icon.icns; the dev binary would show Electron's.
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, "build", "icon.png"));
  buildMenu();
  createTray();
  loadAppearance();
  loadPreferences();
  wireAppearance();
  wirePermissions();
  wirePanelIpc();
  wireNotifyIpc();
  wireWindowIpc();
  wireBridgeIpc();
  wirePowerEvents();
  wireTelemetryIpc();
  wireResetIpc();
  wireCrashReports();
  wireFlowIpc();
  // Hook effects drive Flow's cascade, which lives in the owner renderer.
  flowInput.install(() => (ownerWin && !ownerWin.isDestroyed() ? ownerWin.webContents : null), telemetry);
  // Open at login by default, once, for the installed app only (never the dev
  // binary). After that the person's choice in Settings stands.
  if (app.isPackaged && firstTime("loginItemDefault") && !loginItem()) loginItem(true);
  // A login launch comes up as just the tray, with Flow ready.
  const hidden = !!tray && openedAtLogin;
  if (hidden && process.platform === "darwin") app.dock.hide();
  if (!hidden) createSplash();
  const started = await startServers();
  if (uncleanPrevExit) telemetry.track("crash_detected", { source: "main_previous_run", reason: "unclean_exit", target: "none" });
  if (!started) { reportLaunch(launchKind, "ports_blocked", startedAt); quitApp("boot_failed"); return; } // ensurePortsFree already explained why
  const ok = await waitForServers();
  if (!ok) {
    reportLaunch(launchKind, "servers_timeout", startedAt);
    dialog.showErrorBox("OpenLive couldn't start", `The local servers didn't come up. Try relaunching.`);
    quitApp("boot_failed");
    return;
  }
  serversUp = true;
  reportLaunch(launchKind, "ok", startedAt);
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
app.on("window-all-closed", () => { if (!tray) quitApp("no_tray"); });

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
  telemetry.onQuit("other"); // a quit no path above named; a no-op after one that did
  if (cleanedUp || DEV || children.length === 0) return; // nothing of ours to reap
  e.preventDefault();               // hold the quit until the trees are gone…
  killChildren().finally(() => app.quit()); // …then let it through (cleanedUp now short-circuits)
});
