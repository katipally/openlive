import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Discover each coding agent's OWN prior sessions from its on-disk storage (the
// same ones its `/resume` would show), so History can surface them alongside
// OpenLive's. Read-only + best-effort: a format change or unreadable file is
// skipped, never fatal. ACP `session/list` is still an unratified RFD (no agents
// implement it), so disk is the reliable path in July 2026.
//
// ponytail: parses agent-specific on-disk formats — brittle by nature. Capped at
// RECENT files, first LINES only for the title. If an agent changes its layout,
// that agent's sessions just stop appearing (the rest keep working).

export interface ExternalSession { id: string; title: string; updatedAt: string; cwd: string }
export interface ExternalAgentSessions { agentId: string; sessions: ExternalSession[] }

const RECENT = 60;              // most-recent sessions per agent (by file mtime)
const TITLE_SCAN_LINES = 80;    // lines to scan for a human title (past preambles)
const clip = (s: string, n = 64) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const iso = (ms: number) => new Date(ms).toISOString();

// Skip the machine-generated preambles injected as the "first" user message — XML
// context blocks, slash-command echoes, and OpenLive's own voice preamble/seed —
// so the title reads as the user's actual first words.
const isBoilerplate = (t: string) => !t || /^\s*(<[a-z-]+|\[(you're being used|context —|image #)|base directory for this skill|# files mentioned|caveat:)/i.test(t);

/** Read the first N lines of a file without loading the whole thing (session logs
 *  can be hundreds of MB — see the Codex growth issue). */
function headLines(path: string, max: number): string[] {
  try {
    const buf = readFileSync(path, "utf8");
    const out: string[] = [];
    let i = 0;
    while (out.length < max && i < buf.length) {
      const nl = buf.indexOf("\n", i);
      const line = nl === -1 ? buf.slice(i) : buf.slice(i, nl);
      if (line.trim()) out.push(line);
      if (nl === -1) break;
      i = nl + 1;
    }
    return out;
  } catch { return []; }
}

const recentFiles = (paths: { path: string; mtimeMs: number }[]) =>
  paths.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RECENT);

// ── Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl ──────────
function claudeSessions(): ExternalSession[] {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const files: { path: string; mtimeMs: number }[] = [];
  for (const proj of safeReaddir(root)) {
    const dir = join(root, proj);
    for (const f of safeReaddir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      try { files.push({ path: join(dir, f), mtimeMs: statSync(join(dir, f)).mtimeMs }); } catch { /* skip */ }
    }
  }
  return recentFiles(files).map(({ path, mtimeMs }) => {
    const id = path.split("/").pop()!.replace(/\.jsonl$/, "");
    let cwd = "", title = "";
    for (const line of headLines(path, TITLE_SCAN_LINES)) {
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
      if (!title && o.type === "user" && o.message?.role === "user") {
        const c = o.message.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((b: any) => b?.type === "text")?.text ?? "" : "";
        if (!isBoilerplate(text)) title = clip(text);
      }
      if (cwd && title) break;
    }
    return { id, cwd, title: title || "Claude Code session", updatedAt: iso(mtimeMs) };
  }).filter((s) => s.cwd);
}

// ── Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ──────────────────────
function codexSessions(): ExternalSession[] {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return [];
  const files: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of safeReaddir(dir)) {
      const p = join(dir, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.startsWith("rollout-") && e.endsWith(".jsonl")) files.push({ path: p, mtimeMs: st.mtimeMs });
    }
  };
  walk(root, 0);
  return recentFiles(files).map(({ path, mtimeMs }) => {
    let id = "", cwd = "", title = "";
    for (const line of headLines(path, TITLE_SCAN_LINES)) {
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      const p = o.payload;
      if (o.type === "session_meta" && p) { id = p.id ?? id; cwd = p.cwd ?? cwd; }
      if (!title && p?.type === "message" && p.role === "user") {
        const text = Array.isArray(p.content) ? p.content.find((b: any) => b?.type === "input_text")?.text ?? "" : "";
        if (!isBoilerplate(text)) title = clip(text);
      }
      if (id && cwd && title) break;
    }
    return { id: id || path.split("/").pop()!, cwd, title: title || "Codex session", updatedAt: iso(mtimeMs) };
  }).filter((s) => s.cwd);
}

// ── Cursor: ~/.cursor/acp-sessions/<sessionId>/meta.json ({ cwd }) ───────────
function cursorSessions(): ExternalSession[] {
  const root = join(homedir(), ".cursor", "acp-sessions");
  if (!existsSync(root)) return [];
  const out: ExternalSession[] = [];
  for (const id of safeReaddir(root)) {
    const meta = join(root, id, "meta.json");
    try {
      const m = JSON.parse(readFileSync(meta, "utf8"));
      if (typeof m.cwd !== "string" || !m.cwd) continue;
      out.push({ id, cwd: m.cwd, title: "Cursor session", updatedAt: iso(statSync(meta).mtimeMs) });
    } catch { /* skip */ }
  }
  return recentFiles(out.map((s) => ({ ...s, path: "", mtimeMs: new Date(s.updatedAt).getTime() })) as any).map((x: any) => ({ id: x.id, cwd: x.cwd, title: x.title, updatedAt: x.updatedAt }));
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** External sessions per agent, discovered from disk. */
export function readExternalAgentSessions(): ExternalAgentSessions[] {
  return [
    { agentId: "claude-code", sessions: claudeSessions() },
    { agentId: "codex", sessions: codexSessions() },
    { agentId: "cursor", sessions: cursorSessions() },
  ].filter((a) => a.sessions.length > 0);
}
