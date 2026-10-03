import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSession, readHead, sessionIdFromFileName } from "./jsonl";
import { sessionAssetsDir, sessionsDir } from "./paths";
import { readSessionState } from "./session";
import { readFlowConfig } from "./config";
import { KEEP_MS } from "./shared";
import type { SessionEntry, SessionHeader, SessionState } from "./types";

// History has to stay fast with tens of thousands of sessions, so nothing here
// ever reads a whole directory's worth of content. Filenames are
// `<sortable stamp>_<id>.jsonl`, which means recency is a name sort: no stat per
// file, and only the listed page is opened, head-first and byte-bounded.
//
// Listing F sessions for a page of N: O(F) to read the directory names, O(F log F)
// to sort them, then O(N) bounded reads. Search is the same shape with a bigger
// head and its own cap, so its cost is bounded by the cap, not by the archive.

const LIST_LIMIT = 60;
const SEARCH_SCAN = 200;
const LIST_HEAD_BYTES = 32 * 1024;
const SEARCH_HEAD_BYTES = 256 * 1024;

export interface FlowSessionSummary {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  state: SessionState;
  assetsDir: string;
  /** How many pictures this session kept. Counted from the directory rather
   *  than from the log, so it is exact even for a session too long to read. */
  assets: number;
}

export interface LoadedFlowSession {
  header: SessionHeader | null;
  entries: SessionEntry[];
  /** Entries only ever hold paths; the bytes live here. */
  assets: { name: string; path: string; bytes: number }[];
  truncated: boolean;
}

/** Session filenames, newest first. */
function sessionFiles(): { id: string; name: string }[] {
  let names: string[];
  try { names = readdirSync(sessionsDir()); } catch { return []; } // no store yet
  const files: { id: string; name: string }[] = [];
  for (const name of names) {
    const id = sessionIdFromFileName(name);
    if (id) files.push({ id, name });
  }
  return files.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

function summarize(id: string, name: string): FlowSessionSummary | null {
  const path = join(sessionsDir(), name);
  let updatedAt: string;
  try { updatedAt = new Date(statSync(path).mtimeMs).toISOString(); } catch { return null; }
  const { text, complete } = safeHead(path, LIST_HEAD_BYTES);
  const { header, entries } = parseSession(text, complete);
  return {
    id,
    path,
    createdAt: header?.createdAt ?? "",
    updatedAt,
    title: titleOf(header, entries),
    state: readSessionState(path),
    assetsDir: sessionAssetsDir(id),
    assets: countAssets(id),
  };
}

/** `offset` skips that many of the newest, so a page costs its own reads only. */
export function listSessions(limit = LIST_LIMIT, offset = 0): FlowSessionSummary[] {
  const out: FlowSessionSummary[] = [];
  for (const { id, name } of sessionFiles().slice(offset)) {
    if (out.length >= limit) break;
    const summary = summarize(id, name);
    if (summary) out.push(summary);
  }
  return out;
}

/** Substring match over the title and the bounded head of each scanned session.
 *  Bounded by `scan` files, so a huge archive costs the same as a small one. */
export function searchSessions(query: string, limit = LIST_LIMIT, scan = SEARCH_SCAN, offset = 0): FlowSessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return listSessions(limit, offset);
  const out: FlowSessionSummary[] = [];
  let scanned = 0;
  let skipped = 0;
  for (const { id, name } of sessionFiles()) {
    if (out.length >= limit || scanned >= scan) break;
    scanned++;
    const path = join(sessionsDir(), name);
    if (!safeHead(path, SEARCH_HEAD_BYTES).text.toLowerCase().includes(needle)) continue;
    if (skipped++ < offset) continue;
    const summary = summarize(id, name);
    if (summary) out.push(summary);
  }
  return out;
}

export function loadSession(id: string): LoadedFlowSession | null {
  const hit = sessionFiles().find((f) => f.id === id);
  if (!hit) return null;
  const path = join(sessionsDir(), hit.name);
  const { text, complete } = safeHead(path, Number.MAX_SAFE_INTEGER);
  const { header, entries, truncated } = parseSession(text, complete);
  // Cuts resolve in two passes over the log, O(n): a reply the user talked over
  // reads as what they heard, and one cut before a word of it was heard is gone.
  const cuts = new Map<unknown, string>();
  for (const e of entries) if (e.type === "cut") cuts.set(e.target, typeof e.text === "string" ? e.text : "");
  const heard: SessionEntry[] = [];
  for (const e of entries) {
    const cut = cuts.get(e.id);
    if (e.type === "cut") continue;
    if (cut === undefined) heard.push(e);
    else if (cut.trim()) heard.push({ ...e, text: cut });
  }
  return { header, entries: heard, truncated, assets: listAssets(id) };
}

/** The file a session id names, or "" when nothing on disk answers to it. */
export function sessionPath(id: string): string {
  const hit = sessionFiles().find((f) => f.id === id);
  return hit ? join(sessionsDir(), hit.name) : "";
}

/** Remove a session and everything captured for it. False when there was no
 *  such session; a partial removal still reports true, because the transcript
 *  going is what the person asked for. */
export function deleteSession(id: string): boolean {
  const hit = sessionFiles().find((f) => f.id === id);
  if (!hit) return false;
  rmSync(join(sessionsDir(), hit.name), { force: true });
  rmSync(sessionAssetsDir(id), { recursive: true, force: true });
  return true;
}

/** Deletes every session last written before `before` (ms), with its pictures,
 *  except one still running. Returns how many went. A name sorts by when the
 *  session began, so the walk starts at the oldest and stops at the first that
 *  began after `before`: only those older are statted. O(F) names, O(old) stats. */
export function pruneSessions(before: number): number {
  let gone = 0;
  for (const { id, name } of sessionFiles().reverse()) {
    const path = join(sessionsDir(), name);
    if (stampMs(name) >= before) break;
    let at: number;
    try { at = statSync(path).mtimeMs; } catch { continue; }
    if (at >= before || readSessionState(path) === "active") continue;
    rmSync(path, { force: true });
    rmSync(sessionAssetsDir(id), { recursive: true, force: true });
    gone++;
  }
  return gone;
}

/** Prunes to what Settings > Flow says to keep. Run on every first page read
 *  and as a session opens, so the store stays bounded without a timer. */
export function keepSessions(now = Date.now()): number {
  const keep = readFlowConfig().history;
  return keep === "forever" ? 0 : pruneSessions(now - KEEP_MS[keep]);
}

/** How many sessions are kept: one readdir, nothing opened. */
export const countSessions = (): number => sessionFiles().length;

/** `20250101T120000123Z_<id>.jsonl` → when it began, in ms. */
const stampMs = (name: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(name);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!) : 0;
};

/**
 * Give a session its own title, or clear it with "" so it falls back to the first
 * thing said. The header is line 1 of an append-only file, so this rewrites the
 * file through a temp and an atomic rename. A live session is refused: its owner
 * may append between the read and the rename, and that line would be lost.
 * O(file size), paid once per rename.
 */
export function renameSession(id: string, title: string): boolean {
  const path = sessionPath(id);
  if (!path || readSessionState(path) === "active") return false;
  const text = readFileSync(path, "utf8");
  const cut = text.indexOf("\n");
  const header = parseSession(cut < 0 ? "" : text.slice(0, cut + 1)).header;
  if (!header) return false;
  const next: SessionHeader = { ...header, title: title.trim() };
  if (!next.title) delete next.title;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next)}${text.slice(cut)}`, { mode: 0o600 });
  renameSync(tmp, path); // atomic on the same filesystem
  return true;
}

/** One readdir, no stat per file: a listing only needs to know how many. */
export function countAssets(sessionId: string): number {
  try { return readdirSync(sessionAssetsDir(sessionId)).length; } catch { return 0; }
}

export function listAssets(sessionId: string): { name: string; path: string; bytes: number }[] {
  const dir = sessionAssetsDir(sessionId);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: { name: string; path: string; bytes: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try { out.push({ name, path, bytes: statSync(path).size }); } catch { /* vanished mid-listing */ }
  }
  return out;
}

const safeHead = (path: string, bytes: number) => {
  try { return readHead(path, bytes); } catch { return { text: "", complete: true }; }
};

const clip = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function titleOf(header: SessionHeader | null, entries: SessionEntry[]): string {
  if (typeof header?.title === "string" && header.title.trim()) return clip(header.title);
  for (const e of entries) {
    if (e.type !== "message" || e.role !== "user") continue;
    const text = typeof e.text === "string" ? e.text : typeof e.content === "string" ? e.content : "";
    if (text.trim()) return clip(text);
  }
  return "Flow session";
}
