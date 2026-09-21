import { appendFileSync, closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { SESSION_FORMAT_VERSION, type SessionEntry, type SessionHeader } from "./types";

// Append-only JSONL. One `appendFileSync` per line, so a reader in another
// process either sees a whole line or a torn tail it discards; there is no
// half-written file to guard against and no rewrite to lose. Assets never enter
// these files: an entry carries a relative path into the sibling assets dir.

const READ_CHUNK = 1024 * 1024;

/** Sortable, filename-safe timestamp: lexicographic order is chronological order,
 *  which is what lets history sort by filename instead of statting every file. */
export const fileStamp = (at: Date): string => at.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");

export const sessionFileName = (id: string, createdAt: Date): string => `${fileStamp(createdAt)}_${id}.jsonl`;

/** `<stamp>_<id>.jsonl` → id, or null for anything else in the directory. */
export function sessionIdFromFileName(name: string): string | null {
  const m = /^\d{8}T\d{9}Z_(.+)\.jsonl$/.exec(name);
  return m?.[1] ?? null;
}

// Two callers in one process must not interleave their appends, and a caller must
// be able to await its own write. One promise chain per file does both; the entry
// is dropped once it settles so the map cannot grow with the session count.
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(path: string, fn: () => T): Promise<T> {
  const prev = chains.get(path) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  chains.set(path, run);
  const done = () => { if (chains.get(path) === run) chains.delete(path); };
  run.then(done, done);
  return run;
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

export function writeHeader(path: string, header: SessionHeader): Promise<void> {
  return serialize(path, () => { writeFileSync(path, line(header), { mode: 0o600, flag: "wx" }); });
}

export function appendEntry(path: string, entry: SessionEntry): Promise<void> {
  return serialize(path, () => { appendFileSync(path, line(entry), { mode: 0o600 }); });
}

/** Read at most `maxBytes` from the front of a file. `complete` is false when the
 *  file was longer, which tells the parser its last line is cut mid-record. */
export function readHead(path: string, maxBytes = READ_CHUNK): { text: string; complete: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    const n = readSync(fd, buf, 0, want, 0);
    return { text: buf.toString("utf8", 0, n), complete: size <= maxBytes };
  } finally { closeSync(fd); }
}

/** Read at most `maxBytes` from the END of a file. The first line of the window is
 *  dropped when the window starts mid-file, since it is cut on the left. */
export function tailEntries(path: string, maxBytes = 64 * 1024): SessionEntry[] {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const from = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString("utf8", 0, n).split("\n");
    lines.pop(); // torn tail, or the empty string after the final newline
    if (from > 0) lines.shift();
    return lines.map(asEntry).filter((e): e is SessionEntry => e !== null);
  } finally { closeSync(fd); }
}

export interface ParsedSession {
  header: SessionHeader | null;
  entries: SessionEntry[];
  /** True when a trailing record was dropped: a crash mid-append, or a bounded read. */
  truncated: boolean;
}

/** Torn-line guard: a final record with no terminating newline never landed whole,
 *  so it is discarded. Crash safety for the price of one `pop()`. */
export function parseSession(text: string, complete = true): ParsedSession {
  const lines = text.split("\n");
  const tail = lines.pop();
  const truncated = !complete || tail !== "";
  const header = lines.length ? asHeader(lines[0]!) : null;
  const entries: SessionEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const entry = asEntry(lines[i]!);
    if (entry) entries.push(entry);
  }
  return { header, entries, truncated };
}

export function readSession(path: string, maxBytes?: number): ParsedSession {
  const { text, complete } = readHead(path, maxBytes);
  return parseSession(text, complete);
}

function parse(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const o: unknown = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch { return null; }
}

function asHeader(raw: string): SessionHeader | null {
  const o = parse(raw);
  if (!o || o.kind !== "header" || typeof o.id !== "string") return null;
  return { ...o, v: typeof o.v === "number" ? o.v : SESSION_FORMAT_VERSION, kind: "header", id: o.id, createdAt: typeof o.createdAt === "string" ? o.createdAt : "" };
}

function asEntry(raw: string): SessionEntry | null {
  const o = parse(raw);
  if (!o || typeof o.id !== "string" || typeof o.type !== "string") return null;
  return {
    ...o,
    id: o.id,
    parentId: typeof o.parentId === "string" ? o.parentId : null,
    seq: typeof o.seq === "number" ? o.seq : 0,
    timestamp: typeof o.timestamp === "string" ? o.timestamp : "",
    type: o.type as SessionEntry["type"],
  };
}

/** Root-to-tip path through the parent chain, for resuming from a chosen tip.
 *  O(n) to index the entries, then O(depth) to walk. */
export function entryChain(entries: SessionEntry[], tipId: string): SessionEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const chain: SessionEntry[] = [];
  const seen = new Set<string>();
  for (let id: string | null = tipId; id && !seen.has(id); id = chain[chain.length - 1]!.parentId) {
    const entry = byId.get(id);
    if (!entry) break;
    seen.add(id);
    chain.push(entry);
  }
  return chain.reverse();
}
