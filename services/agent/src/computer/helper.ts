import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../log.js";

// The computer-use helper, one per server, shared by every session.
//
// The server owns it, not Electron main: the server already owns the tool
// registry and the MCP server every brain reaches, so the helper's tools are
// native tools for an API brain and MCP tools for a coding agent with no hop
// through the renderer. TCC does not care who spawns it: the helper is its own
// signed app and disclaims responsibility at launch (crates/helper/src/disclaim.rs),
// so grants attach to "OpenLive Computer Use" whoever its parent is.
//
// Launch, token, socket and reaping follow Orca's macOS provider client (MIT,
// Copyright (c) 2026 Lovecast Inc.; see THIRD_PARTY_NOTICES).

/** Must equal the helper's PROTOCOL_VERSION. */
export const PROTOCOL = 1;
/** Platforms whose helper backend is real. Linux (5c) joins here. */
const SUPPORTED = new Set<NodeJS.Platform>(["darwin", "win32"]);
const CONNECT_TIMEOUT_MS = 10_000;
/** A tree walk of a busy window plus a capture fits well inside this; a hung helper does not. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** A helper that exits on terminate gets this long before it is killed. */
const KILL_GRACE_MS = 2_000;
/** This many crashes inside the window and the helper is left alone for a while. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 60_000;

export class HelperError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** How to start the helper. `args` and `env` exist for a dev build and for tests. */
export interface Launch {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** What a session reaches: one request, answered or refused with a readable error. */
export interface ComputerPort {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

// ── wire types, mirroring crates/core/src/protocol.rs ───────────────────────

export interface Handshake { protocol: number; version: string; platform: string; ready: boolean; reason?: string; pid: number }
export interface Grant { id: "accessibility" | "screenRecording"; granted: boolean; settingsUrl?: string }
export interface AppInfo { name: string; bundleId?: string; pid: number; active: boolean }
export interface WindowInfo { id: number; appName: string; bundleId?: string; pid: number; title?: string; x: number; y: number; width: number; height: number; onScreen: boolean }
export interface Snapshot {
  app: AppInfo;
  window: WindowInfo;
  treeText: string;
  elementCount: number;
  focusedElement?: number;
  truncated: boolean;
  screenshot?: { data: string; mime: string; width: number; height: number };
  screenshotError?: string;
}
export interface ActionReport { path: "accessibility" | "synthetic" | "clipboard"; actionName: string; verified: boolean; detail?: string }
export interface ActionResult { action: ActionReport; state?: Snapshot; stateError?: string }

/**
 * Where the helper is, or null where there is none to run. Packaged, Electron
 * main names it in OPENLIVE_CU_HELPER, and OPENLIVE_CU_OWN_ROOT (OpenLive's
 * install) rides along in the inherited env; set but empty, there is none,
 * which is how tests and anyone who wants ol-input's tools turn it off.
 * Otherwise it is the dev build in native/openlive-cu/dist, run without
 * disclaiming (see disclaim.rs), with the repo as OpenLive's own root: the dev
 * Electron runs from its node_modules, so its windows are never the default target.
 */
export function locateHelper(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Launch | null {
  if (!SUPPORTED.has(platform)) return null;
  const named = env.OPENLIVE_CU_HELPER;
  if (named !== undefined) return named && existsSync(named) ? { command: named } : null;
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const dist = join(repo, "native", "openlive-cu", "dist");
  const command = platform === "darwin"
    ? join(dist, "OpenLive Computer Use.app", "Contents", "MacOS", "openlive-cu")
    : join(dist, platform === "win32" ? "openlive-cu.exe" : "openlive-cu");
  if (!existsSync(command)) return null;
  return { command, env: { OPENLIVE_CU_DISCLAIM: env.OPENLIVE_CU_DISCLAIM ?? "0", OPENLIVE_CU_OWN_ROOT: env.OPENLIVE_CU_OWN_ROOT ?? repo } };
}

interface Running {
  child: ChildProcess;
  socket: net.Socket;
  token: string;
  dir: string;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Children still alive when the server exits. Killed synchronously on the way out. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

export class ComputerHelper implements ComputerPort {
  private running: Running | null = null;
  private starting: Promise<Running> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private crashes: number[] = [];
  /** Set when the helper said its backend is not ready on this platform. */
  private unsupported: string | null = null;

  constructor(private opts: { locate: () => Launch | null; requestTimeoutMs?: number; connectTimeoutMs?: number }) {}

  /** Whether a session should be offered the helper's tools. Never starts it. */
  available(): boolean {
    return !this.unsupported && !this.resting() && this.opts.locate() !== null;
  }

  /** Too many crashes lately: leave it alone until the window passes. */
  private resting(): boolean {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    return this.crashes.length >= CRASH_LIMIT;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.unsupported) throw new HelperError("unsupported_platform", this.unsupported);
    if (this.resting()) throw new HelperError("helper_unavailable", "The computer-use helper keeps stopping, so it is resting for a minute. Try again shortly.");
    const run = await this.ensure();
    return this.send<T>(run, method, params);
  }

  /** Stop the helper and forget it. The next call starts a fresh one. */
  shutdown(): void {
    const run = this.running;
    this.running = null;
    this.starting = null;
    if (!run) return;
    if (!run.socket.destroyed) {
      run.socket.write(`${JSON.stringify({ id: 0, token: run.token, method: "terminate" })}\n`);
      run.socket.end();
    }
    this.fail(new HelperError("helper_stopped", "The computer-use helper was stopped."));
    reap(run.child);
    rmSync(run.dir, { recursive: true, force: true });
  }

  private ensure(): Promise<Running> {
    if (this.running && !this.running.socket.destroyed) return Promise.resolve(this.running);
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<Running> {
    const launch = this.opts.locate();
    if (!launch) throw new HelperError("helper_missing", "The computer-use helper is not installed on this machine.");
    const dir = mkdtempSync(join(tmpdir(), "openlive-cu-"));
    const token = randomBytes(24).toString("base64url");
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const path = process.platform === "win32" ? `\\\\.\\pipe\\openlive-cu-${randomUUID()}` : join(dir, "cu.sock");
    const child = spawn(launch.command, [...(launch.args ?? []), "--socket", path, "--token-file", tokenFile], {
      env: { ...process.env, ...launch.env },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    adopt(child);
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });

    try {
      const socket = await connect(path, child, this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, () => stderr);
      const run: Running = { child, socket, token, dir };
      this.listen(run);
      this.running = run;
      const hello = await this.send<Handshake>(run, "handshake", {});
      if (hello.protocol !== PROTOCOL) throw new HelperError("helper_incompatible", `The computer-use helper speaks protocol ${hello.protocol}; this server needs ${PROTOCOL}. Rebuild it with pnpm native:build.`);
      if (!hello.ready) {
        this.unsupported = hello.reason ?? "Computer use is not supported on this platform yet.";
        throw new HelperError("unsupported_platform", this.unsupported);
      }
      return run;
    } catch (e) {
      if (this.running?.child === child) this.running = null;
      reap(child);
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  /** Read NDJSON replies, and treat the end of the socket or of the process as a crash. */
  private listen(run: Running): void {
    let buf = "";
    run.socket.setEncoding("utf8");
    run.socket.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let reply: { id: number; ok: boolean; result?: unknown; error?: { code: string; message: string } };
        try { reply = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(reply.id);
        if (!p) continue;
        this.pending.delete(reply.id);
        clearTimeout(p.timer);
        if (reply.ok) p.resolve(reply.result);
        else p.reject(new HelperError(reply.error?.code ?? "internal", reply.error?.message ?? "The helper failed without saying why."));
      }
    });
    const gone = () => {
      // A late event from a helper already replaced must not touch its successor.
      if (this.running !== run) return;
      this.running = null;
      this.crashes.push(Date.now());
      log.warn("computer", "the computer-use helper stopped; the next call starts it again");
      this.fail(new HelperError("helper_stopped", "The computer-use helper stopped in the middle of that. It restarts on the next call."));
      reap(run.child);
      rmSync(run.dir, { recursive: true, force: true });
    };
    run.socket.on("close", gone);
    run.socket.on("error", gone);
    run.child.once("exit", gone);
  }

  private send<T>(run: Running, method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError("action_timeout", `The computer-use helper did not answer ${method} in time. It has been restarted; check the screen before trying again.`));
        // A helper that does not answer is wedged; the next call gets a fresh one.
        if (this.running === run) {
          this.crashes.push(Date.now());
          this.shutdown();
        }
      }, this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      run.socket.write(`${JSON.stringify({ id, token: run.token, method, params })}\n`);
    });
  }

  private fail(error: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
      this.pending.delete(id);
    }
  }
}

/** Connect once the helper is listening, or fail as soon as it exits. */
function connect(path: string, child: ChildProcess, timeoutMs: number, stderr: () => string): Promise<net.Socket> {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    let done = false;
    const finish = (e: Error | null, s?: net.Socket) => {
      if (done) return;
      done = true;
      child.off("exit", onExit);
      if (e) reject(e);
      else resolvePromise(s!);
    };
    const onExit = (code: number | null) => finish(new HelperError("helper_failed", `The computer-use helper exited before it was ready (code ${code}). ${stderr().trim()}`.trim()));
    child.once("exit", onExit);
    child.once("error", (e) => finish(new HelperError("helper_failed", `The computer-use helper could not start: ${e.message}`)));
    const attempt = () => {
      if (done) return;
      const s = net.createConnection(path);
      s.once("connect", () => { s.removeAllListeners("error"); finish(null, s); });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) finish(new HelperError("helper_failed", "The computer-use helper did not open its socket in time."));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function adopt(child: ChildProcess): void {
  live.add(child);
  child.once("exit", () => live.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // The server is going away: nothing async runs after this, so no grace period.
  process.once("exit", () => { for (const c of live) c.kill("SIGKILL"); });
}

/** SIGTERM, then SIGKILL if it is still there after the grace period. Signals the
 *  handle, never a raw pid, so a recycled pid is never hit. */
function reap(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, KILL_GRACE_MS);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

/** The server's one helper. */
export const computer = new ComputerHelper({ locate: () => locateHelper() });
