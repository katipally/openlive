import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Emit } from "../tools.js";
import { killTree } from "./proc.js";
import { log } from "../log.js";

// Client-hosted ACP terminals (terminal/create … terminal/release): the agent
// runs its shell commands THROUGH OpenLive, so output streams live into the tool
// card, cancel actually kills the command, and exit codes are ours to report.
// Plain child_process — ACP terminals are command execution + output capture,
// not an interactive pty.

const DEFAULT_CAP = 128 * 1024;
const MAX_CAP = 1024 * 1024;
const FLUSH_MS = 80; // batch live output — one WS frame per flush, not per chunk

export interface CreateTermInput {
  command: string;
  args?: string[] | null;
  env?: Array<{ name: string; value: string }> | null;
  cwd?: string | null;
  outputByteLimit?: number | null;
}

interface Term {
  child: ChildProcess;
  buf: string;              // tail-capped output (stdout+stderr interleaved)
  truncated: boolean;
  cap: number;
  exit?: { exitCode: number | null; signal: string | null };
  exited: Promise<{ exitCode: number | null; signal: string | null }>;
  pendingLive: string;      // not-yet-flushed live chunk for the UI
  flusher?: ReturnType<typeof setInterval>;
}

export class TerminalManager {
  private terms = new Map<string, Term>();

  constructor(private opts: { cwd: () => string; emit: () => Emit | null }) {}

  create(p: CreateTermInput): { terminalId: string } {
    const terminalId = `term-${randomUUID()}`;
    const isWin = process.platform === "win32";
    const env = { ...process.env, ...Object.fromEntries((p.env ?? []).map((e) => [e.name, e.value])) };
    const child = spawn(p.command, p.args ?? [], {
      cwd: p.cwd?.trim() || this.opts.cwd(),
      env,
      // Same discipline as the adapter spawn: POSIX gets its own process group
      // (whole-tree kill); Windows needs a shell for .cmd shims.
      detached: !isWin,
      shell: isWin,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cap = Math.min(Math.max(p.outputByteLimit ?? DEFAULT_CAP, 1024), MAX_CAP);
    const term: Term = {
      child, buf: "", truncated: false, cap, pendingLive: "",
      exited: new Promise((resolve) => {
        child.once("error", (e) => { this.append(terminalId, `\n${String(e?.message ?? e)}\n`); resolve({ exitCode: null, signal: null }); });
        child.once("close", (code, signal) => resolve({ exitCode: code, signal: signal ?? null }));
      }),
    };
    this.terms.set(terminalId, term);
    child.stdout?.on("data", (d: Buffer) => this.append(terminalId, d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => this.append(terminalId, d.toString("utf8")));
    // Live streaming to the UI, batched. The flusher lives exactly as long as
    // the process; the final flush + term_exit ride the close handler.
    term.flusher = setInterval(() => this.flush(terminalId), FLUSH_MS);
    term.flusher.unref?.();
    void term.exited.then((exit) => {
      const t = this.terms.get(terminalId);
      if (!t) return;
      t.exit = exit;
      if (t.flusher) { clearInterval(t.flusher); t.flusher = undefined; }
      this.flush(terminalId);
      void this.opts.emit()?.({ type: "term_exit", terminalId, exitCode: exit.exitCode, signal: exit.signal });
    });
    return { terminalId };
  }

  output(terminalId: string): { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } } {
    const t = this.get(terminalId);
    return { output: t.buf, truncated: t.truncated, ...(t.exit ? { exitStatus: t.exit } : {}) };
  }

  async waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
    return this.get(terminalId).exited;
  }

  /** Kill the command but KEEP the terminal valid — the agent may still read
   *  output / exit status afterwards (per spec kill ≠ release). */
  kill(terminalId: string): void {
    killTree(this.get(terminalId).child);
  }

  /** Release = kill + forget. Subsequent calls with this id are errors. */
  release(terminalId: string): void {
    const t = this.get(terminalId);
    if (t.flusher) clearInterval(t.flusher);
    if (t.exit === undefined) killTree(t.child);
    this.terms.delete(terminalId);
  }

  /** Turn abort (barge-in / watchdog): kill every running command, but keep
   *  entries + buffers so late terminal/output reads still answer. */
  killAll(): void {
    for (const [id, t] of this.terms) if (t.exit === undefined) { try { this.kill(id); } catch { /* racing exit */ } }
  }

  /** Session end: kill + drop everything. */
  disposeAll(): void {
    for (const t of this.terms.values()) {
      if (t.flusher) clearInterval(t.flusher);
      if (t.exit === undefined) killTree(t.child);
    }
    this.terms.clear();
  }

  private get(terminalId: string): Term {
    const t = this.terms.get(terminalId);
    if (!t) throw new Error(`unknown terminal: ${terminalId}`);
    return t;
  }

  private append(terminalId: string, chunk: string): void {
    const t = this.terms.get(terminalId);
    if (!t) return;
    t.buf += chunk;
    if (t.buf.length > t.cap) { t.buf = t.buf.slice(-t.cap); t.truncated = true; } // spec: keep the TAIL
    t.pendingLive += chunk;
    // A silent runaway producer can't balloon the pending slice past the cap.
    if (t.pendingLive.length > t.cap) t.pendingLive = t.pendingLive.slice(-t.cap);
  }

  private flush(terminalId: string): void {
    const t = this.terms.get(terminalId);
    if (!t || !t.pendingLive) return;
    const chunk = t.pendingLive;
    t.pendingLive = "";
    const emit = this.opts.emit();
    if (!emit) return; // no active turn — buffer still answers terminal/output
    void Promise.resolve(emit({ type: "term_output", terminalId, chunk, truncated: t.truncated || undefined }))
      .catch((e) => log.debug("terminal", "live flush:", e));
  }
}
