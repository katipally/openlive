import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSession, readHead, sessionIdFromFileName } from "./jsonl";
import { sessionAssetsDir, sessionsDir } from "./paths";
import { readSessionState } from "./session";
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
  };
}

export function listSessions(limit = LIST_LIMIT): FlowSessionSummary[] {
  const out: FlowSessionSummary[] = [];
  for (const { id, name } of sessionFiles()) {
    if (out.length >= limit) break;
    const summary = summarize(id, name);
    if (summary) out.push(summary);
  }
  return out;
}

/** Substring match over the title and the bounded head of each scanned session.
 *  Bounded by `scan` files, so a huge archive costs the same as a small one. */
export function searchSessions(query: string, limit = LIST_LIMIT, scan = SEARCH_SCAN): FlowSessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return listSessions(limit);
  const out: FlowSessionSummary[] = [];
  let scanned = 0;
  for (const { id, name } of sessionFiles()) {
    if (out.length >= limit || scanned >= scan) break;
    scanned++;
    const path = join(sessionsDir(), name);
    if (!safeHead(path, SEARCH_HEAD_BYTES).text.toLowerCase().includes(needle)) continue;
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
  return { header, entries, truncated, assets: listAssets(id) };
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
