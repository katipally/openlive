// Node-only agent helpers (credential probing, PATH widening, terminal launch).
// Imported via "@openlive/shared/node" by the agent service and Next API routes —
// NEVER by browser code (the root "@openlive/shared" entry stays node-free).

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { CredProbe } from "../agent-registry";

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** GUI-spawned processes get a skeletal PATH (especially on macOS) — the user's
 *  agent binaries (homebrew/npm/local) live outside it. Append the usual bins so
 *  `npx`/`agent`/`uvx` resolve regardless of how OpenLive was launched. */
export function widenedPath(): string {
  const home = homedir();
  const extra = process.platform === "win32"
    ? [join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"), join(home, ".local", "bin"), join(home, "bin")]
    : ["/usr/local/bin", "/opt/homebrew/bin", `${home}/.local/bin`, `${home}/bin`, `${home}/.npm-global/bin`, `${home}/.opencode/bin`];
  const cur = (process.env.PATH ?? "").split(delimiter);
  return [...cur, ...extra.filter((p) => !cur.includes(p))].join(delimiter);
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

/** Launch a CLI command in the user's real terminal (login/logout flows need a
 *  TTY + browser). darwin → Terminal.app; win32 → a new cmd window; else best-effort. */
export function terminalCommand(cmd: string): { cmd: string; args: string[] } {
  if (process.platform === "darwin") {
    return { cmd: "osascript", args: ["-e", 'tell application "Terminal" to activate', "-e", `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`] };
  }
  if (process.platform === "win32") {
    // `start` opens a NEW window; `cmd /k` keeps it open so the user sees the result.
    return { cmd: "cmd", args: ["/c", "start", "", "cmd", "/k", cmd] };
  }
  return { cmd: "bash", args: ["-lc", cmd] };
}
