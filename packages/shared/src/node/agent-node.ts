// Node-only agent helpers (credential probing, PATH widening, terminal launch).
// Imported via "@openlive/shared/node" by the agent service and Next API routes —
// NEVER by browser code (the root "@openlive/shared" entry stays node-free).

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { CredProbe } from "../agent-registry";

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** The user's login-shell PATH — where version managers (nvm/fnm/volta/asdf)
 *  put the agent binaries. A GUI launch (Finder/dock) never sources the shell,
 *  so the process inherits a skeletal PATH and those binaries are invisible.
 *  Login + interactive, because nvm is a function defined in ~/.zshrc.
 *  Cached: one spawn per process, and a failure caches as "gave up". */
let loginPath: string[] | undefined;
function loginShellPath(): string[] {
  if (loginPath) return loginPath;
  loginPath = [];
  if (process.platform === "win32") return loginPath;
  try {
    const shell = process.env.SHELL || "/bin/sh";
    // The marker survives whatever banners an interactive rc file prints.
    // turbopackIgnore: the shell is the user's, never a file of ours to trace.
    const out = execFileSync(/*turbopackIgnore: true*/ shell, ["-lic", 'printf "__OL__%s" "$PATH"'], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    });
    loginPath = (out.split("__OL__").pop() ?? "").trim().split(delimiter).filter(Boolean);
  } catch { /* no shell, or rc file hung — fall back to the static dirs below */ }
  return loginPath;
}

/** GUI-spawned processes get a skeletal PATH (especially on macOS) — the user's
 *  agent binaries (homebrew/npm/local/version-managed node) live outside it.
 *  Prefer the real login-shell PATH, then append the usual bins as a fallback,
 *  so `npx`/`claude`/`agent`/`uvx` resolve regardless of how OpenLive launched. */
export function widenedPath(): string {
  const home = homedir();
  const extra = process.platform === "win32"
    ? [
        join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
        join(home, ".local", "bin"),
        join(home, "bin"),
        // hermes' Windows installer persists this to User PATH, which processes
        // already running (like OpenLive) don't see until restart.
        join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "hermes", "hermes-agent", "venv", "Scripts"),
      ]
    : ["/usr/local/bin", "/opt/homebrew/bin", `${home}/.local/bin`, `${home}/bin`, `${home}/.npm-global/bin`, `${home}/.opencode/bin`];
  const seen = new Set<string>();
  return [...(process.env.PATH ?? "").split(delimiter), ...loginShellPath(), ...extra]
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(delimiter);
}

export type CredState = "ready" | "login_required" | "unknown";

/** Evaluate a registry credential probe — read-only, best-effort, never throws.
 *  "unknown" means the probe itself couldn't decide (render as just Installed). */
export async function evalCredProbe(probe: CredProbe): Promise<CredState> {
  try {
    switch (probe.kind) {
      case "file":
        return existsSync(expandHome(probe.path)) ? "ready" : "login_required";
      case "json": {
        const path = expandHome(probe.path);
        if (!existsSync(path)) return "login_required";
        const obj = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        if (typeof obj !== "object" || obj === null) return "login_required";
        const rule = probe.rule;
        if (rule === "nonEmptyObject") return Object.keys(obj).length ? "ready" : "login_required";
        if ("hasKey" in rule) {
          const v = obj[rule.hasKey];
          const empty = v == null || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
          return empty ? "login_required" : "ready";
        }
        const under = obj[rule.anyNonEmptyArrayUnder];
        if (typeof under !== "object" || under === null) return "login_required";
        return Object.values(under).some((v) => Array.isArray(v) && v.length > 0) ? "ready" : "login_required";
      }
      case "fileMatch": {
        const path = expandHome(probe.path);
        if (!existsSync(path)) return "login_required";
        return new RegExp(probe.pattern, "m").test(readFileSync(path, "utf8")) ? "ready" : "login_required";
      }
      case "keychain": {
        if (process.platform !== "darwin") return "unknown";
        // Exit code only — never reads the secret (no -w).
        try {
          await promisify(execFile)("security", ["find-generic-password", "-s", probe.service], { timeout: 3000 });
          return "ready";
        } catch { return "login_required"; }
      }
      case "anyOf": {
        const states = await Promise.all(probe.probes.map(evalCredProbe));
        if (states.includes("ready")) return "ready";
        return states.includes("login_required") ? "login_required" : "unknown";
      }
    }
  } catch { return "unknown"; }
}

/** Read JSON at a "~"-relative path, or null. For probe extras like showing the
 *  signed-in account (e.g. cursor's authInfo.email) — read-only, never throws. */
export function readJsonHome(path: string): Record<string, unknown> | null {
  try {
    const p = expandHome(path);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch { return null; }
}

/** Is `bin` on the widened PATH? Sync (terminalCommand is), and cheap: a few
 *  existsSync probes, no spawn. */
function onPath(bin: string): boolean {
  return widenedPath().split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));
}

/** Linux has no single terminal. Each entry is the emulator's binary and the flag
 *  that means "the rest is the command to run"; kitty and foot take it bare. Order
 *  is preference: the Debian alternatives alias first, then the desktop defaults. */
const LINUX_TERMINALS: [string, string[]][] = [
  ["x-terminal-emulator", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["ptyxis", ["--"]],
  ["xfce4-terminal", ["-x"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["foot", []],
  ["xterm", ["-e"]],
];

/** Launch a CLI command in the user's real terminal — login/logout and setup
 *  wizards need a TTY and a browser, so this must be a VISIBLE window, never a
 *  headless shell. darwin → Terminal.app; win32 → a new PowerShell window;
 *  linux → the first emulator on PATH. */
export function terminalCommand(cmd: string): { cmd: string; args: string[] } {
  if (process.platform === "darwin") {
    return { cmd: "osascript", args: ["-e", 'tell application "Terminal" to activate', "-e", `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`] };
  }
  if (process.platform === "win32") {
    // `start` opens a NEW window; PowerShell `-NoExit` keeps it open so the user sees
    // the result. PowerShell (not cmd) because the commands use modern quoting and
    // POSIX-ish syntax (single-quoted specs, pipelines) that cmd.exe can't parse —
    // the simple `<cli> login` commands run fine in it too.
    return { cmd: "cmd", args: ["/c", "start", "", "powershell", "-NoExit", "-Command", cmd] };
  }
  // `exec bash` holds the window open after the command, like PowerShell -NoExit.
  // With no emulator installed the alias still spawns ENOENT, which the caller turns
  // into "couldn't open a terminal — run this yourself" with the command spelled out.
  const [term, flags] = LINUX_TERMINALS.find(([bin]) => onPath(bin)) ?? LINUX_TERMINALS[0]!;
  return { cmd: term, args: [...flags, "bash", "-lc", `${cmd}; exec bash`] };
}
