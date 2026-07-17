import { readFileSync, readdirSync, statSync, existsSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { AGENT_LIST, type AgentDef } from "@openlive/shared";

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
 *  can be hundreds of MB — see the Codex growth issue). One bounded read: the
 *  cwd/title always live in the first lines, so 1 MB is plenty; a line truncated
 *  at the boundary just fails the caller's JSON.parse and is skipped. */
const HEAD_BYTES = 1024 * 1024;
function headLines(path: string, max: number): string[] {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.toString("utf8", 0, Math.max(0, n)).split("\n").filter((l) => l.trim()).slice(0, max);
    } finally { closeSync(fd); }
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
    const id = basename(path, ".jsonl");
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
    return { id: id || basename(path), cwd, title: title || "Codex session", updatedAt: iso(mtimeMs) };
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

// ── OpenCode: sqlite at <data>/opencode/opencode.db (session table) ───────────
// <data> = $XDG_DATA_HOME or ~/.local/share — the same path on Windows too
// (verified against opencode's docs). Read-only via node:sqlite (Node ≥22.13 —
// already this repo's floor). Sub-sessions (parent_id set) are agent-internal;
// only top-level sessions are the user's.
function opencodeSessions(): ExternalSession[] {
  const dataDir = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const db = join(dataDir, "opencode", "opencode.db");
  if (!existsSync(db)) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const rows = conn
        .prepare("SELECT id, directory, title, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?")
        .all(RECENT) as { id: string; directory: string; title: string; time_updated: number }[];
      return rows
        .filter((r) => r.directory)
        .map((r) => ({ id: r.id, cwd: r.directory, title: clip(r.title || "OpenCode session"), updatedAt: iso(r.time_updated) }));
    } finally { conn.close(); }
  } catch { return []; } // locked db / schema change / old Node → just no sessions
}

// ── Hermes: sqlite at ~/.hermes/state.db (its canonical SessionDB) ────────────
// Schema verified against hermes-agent 0.18.2 source (hermes_state.py): table
// `sessions`, PK `id`, columns cwd/title/started_at/ended_at (REAL unix seconds),
// parent_session_id for internal sub-sessions, archived flag. Reads stay fully
// guarded — a future schema change = no sessions, not a crash.
function hermesSessions(): ExternalSession[] {
  const db = join(homedir(), ".hermes", "state.db");
  if (!existsSync(db)) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const rows = conn
        .prepare(`SELECT id, cwd, title, COALESCE(ended_at, started_at) AS ts FROM sessions
                  WHERE parent_session_id IS NULL AND archived = 0
                  ORDER BY ts DESC LIMIT ?`)
        .all(RECENT) as { id: string; cwd: string | null; title: string | null; ts: number }[];
      return rows.map((r) => ({
        id: String(r.id),
        cwd: r.cwd ?? "",
        title: clip(r.title || "Hermes session"),
        updatedAt: iso(r.ts * 1000), // REAL unix seconds → ms
      })).filter((s) => s.cwd);
    } finally { conn.close(); }
  } catch { return []; }
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

// Discovery dispatch, keyed on each agent's registry `sessionParser` — a future
// agent added to the shared registry with one of these formats needs zero code here.
const PARSERS: Record<AgentDef["sessionParser"], () => ExternalSession[]> = {
  "claude-jsonl": claudeSessions,
  "codex-rollout": codexSessions,
  "cursor-meta": cursorSessions,
  "opencode-sqlite": opencodeSessions,
  "hermes-sqlite": hermesSessions,
};

/** External sessions per agent, discovered from disk. */
export function readExternalAgentSessions(): ExternalAgentSessions[] {
  return AGENT_LIST
    .map((a) => ({ agentId: a.id, sessions: PARSERS[a.sessionParser]() }))
    .filter((a) => a.sessions.length > 0);
}

// Permanently delete a coding agent's OWN on-disk session file/dir (History →
// external session → Delete). Destructive and irreversible — it removes the session
// from the agent itself, not just OpenLive. The id comes from our own history feed;
// still, refuse anything with path separators as defense-in-depth.
export function deleteExternalSession(agentId: string, id: string): boolean {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  const rm = (p: string) => { try { rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } };

  if (agentId === "cursor") {
    const dir = join(homedir(), ".cursor", "acp-sessions", id);
    return existsSync(dir) && rm(dir);
  }
  if (agentId === "claude-code") {
    const root = join(homedir(), ".claude", "projects");
    for (const proj of safeReaddir(root)) {
      const f = join(root, proj, `${id}.jsonl`);
      if (existsSync(f)) return rm(f);
    }
    return false;
  }
  if (agentId === "codex") {
    const root = join(homedir(), ".codex", "sessions");
    let target: string | null = null;
    const walk = (dir: string, depth: number) => {
      for (const e of safeReaddir(dir)) {
        if (target) return;
        const p = join(dir, e);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory() && depth < 4) walk(p, depth + 1);
        else if (e.startsWith("rollout-") && e.endsWith(".jsonl")) {
          if (e.includes(id)) { target = p; return; } // id embedded in the filename
          for (const line of headLines(p, 5)) {         // else match session_meta.id
            let o: any; try { o = JSON.parse(line); } catch { continue; }
            if (o.type === "session_meta" && o.payload?.id === id) { target = p; return; }
          }
        }
      }
    };
    walk(root, 0);
    return target ? rm(target) : false;
  }
  // opencode/hermes: sessions live inside THEIR sqlite databases — never write into
  // a third-party live db from here. History hides the delete affordance for these.
  return false;
}
