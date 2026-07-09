"use strict";
// OpenLive desktop shell. Runs the web (Next) + agent (ws) servers locally and
// shows the UI in a native window. Everything is on localhost — the voice models
// run in the renderer (Chromium/WebGPU), the LLM call goes out from the agent.
const { app, BrowserWindow, session, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const DEV = process.env.ELECTRON_DEV === "1";
const AGENT_PORT = 47823;      // uncommon, baked into the web build's CSP/WS url
const WEB_PORT = DEV ? 3000 : 47824;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const DARK_BG = "#0b0b0c";

let mainWin = null;
let splashWin = null;
const children = [];

// ── single instance ─────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on("second-instance", () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

// ── media (mic/camera) permissions — Electron blocks getUserMedia otherwise ──
function wirePermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media" || permission === "clipboard-read" || permission === "clipboard-sanitized-write");
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === "media");
}

// ── server processes (prod only; in dev they're started by `pnpm dev`) ───────
function spawnServer(name, scriptRel, env) {
  const script = path.join(process.resourcesPath, scriptRel);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  child.on("exit", (code) => { if (code && !app.isQuitting) console.error(`[${name}] exited with ${code}`); });
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
    HOSTNAME: "127.0.0.1",
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
async function waitForWeb(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping(WEB_URL)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ── windows ──────────────────────────────────────────────────────────────────
function createSplash() {
  splashWin = new BrowserWindow({
    width: 420, height: 300, frame: false, resizable: false, movable: true,
    backgroundColor: DARK_BG, show: true, center: true, hasShadow: true,
    webPreferences: { contextIsolation: true },
  });
  splashWin.loadFile(path.join(__dirname, "splash.html"));
  splashWin.on("closed", () => { splashWin = null; });
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1180, height: 800, minWidth: 940, minHeight: 640,
    backgroundColor: DARK_BG, show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links (docs, etc.) in the real browser, not the app window.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });

  mainWin.loadURL(WEB_URL);
  mainWin.once("ready-to-show", () => {
    mainWin.show();
    if (splashWin) splashWin.close();
    if (DEV) mainWin.webContents.openDevTools({ mode: "detach" });
  });
  mainWin.on("closed", () => { mainWin = null; });
}

async function boot() {
  wirePermissions();
  createSplash();
  startServers();
  const ok = await waitForWeb();
  if (!ok) {
    dialog.showErrorBox("OpenLive couldn't start", `The app server didn't come up on ${WEB_URL}. Try relaunching.`);
    app.quit();
    return;
  }
  createMainWindow();
}

app.whenReady().then(boot);

app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { app.isQuitting = true; for (const c of children) { try { c.kill(); } catch { /* */ } } });
