import { readFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { writeAtomic } from "@openlive/shared/home";
import { PATHS } from "./paths";

// Tiny JSON-file store. Replaces SQLite for the single-user app: no native
// module, so the desktop build (Electron) stays pure-JS.
// BOTH processes write these files (web writes providers/settings; the agent
// writes settings for binds, memory and connectors), so every read-modify-write
// must go through updateJson(), which holds a cross-process lock for the whole
// cycle. Plain writes are atomic (temp + rename) so a reader in the other
// process never sees a half-written file. Reads are always fresh from disk and
// lock-free — the rename guarantees a consistent snapshot. Fine at this scale —
// a handful of tiny files, low write rate. Files are pretty-printed: several are
// edited by hand. A name is a path under the home (an absolute one stays as is).

const path = (name: string) => resolve(PATHS.home, name);

export function readText(name: string): string | undefined {
  try { return readFileSync(path(name), "utf8"); }
  catch { return undefined; }
}

export function readJson<T>(name: string, fallback: T): T {
  try { return JSON.parse(readText(name) ?? "") as T; }
  catch { return fallback; }
}

export function writeJson(name: string, data: unknown): void {
  writeAtomic(path(name), `${JSON.stringify(data, null, 2)}\n`);
}

/** Cross-process-safe read-modify-write. Holds a lock on `<file>.lock` for the
 *  whole read→fn→write cycle so a concurrent update in the other process can't
 *  be lost. `realpath:false` lets us lock a file that doesn't exist yet.
 *  `update:2500` refreshes the held lock's mtime so a live-but-slow holder is never
 *  judged stale and stolen mid-write; `stale:15000` still self-heals a lock a KILLED
 *  process left behind (it stops refreshing), just with more headroom than the old
 *  5s — which a GC pause or a briefly-suspended process could exceed, letting the
 *  other process steal the lock and clobber this write. */
const chains = new Map<string, Promise<unknown>>(); // per-file in-process queue

export function withFileLock<R>(name: string, fn: () => R | Promise<R>): Promise<R> {
  // Same-process calls queue behind each other (no lock contention storms);
  // the lockfile below only has to arbitrate between the web and agent processes.
  const file = path(name);
  const prev = chains.get(file) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(file, {
      realpath: false,
      stale: 15000,
      update: 2500,
      retries: { retries: 15, minTimeout: 15, maxTimeout: 250 },
    });
    try { return await fn(); }
    finally { await release(); }
  });
  chains.set(file, run);
  return run;
}

export function updateJson<T>(name: string, fallback: T, fn: (cur: T) => T | Promise<T>): Promise<T> {
  return withFileLock(name, async () => {
    const text = readText(name);
    let cur = fallback;
    // A file someone broke by hand is theirs to fix: writing over it would lose what it held.
    if (text !== undefined) {
      try { cur = JSON.parse(text) as T; } catch { throw new Error(`${basename(path(name))} is not valid JSON. Fix it by hand or delete it.`); }
    }
    const next = await fn(cur);
    writeJson(name, next);
    return next;
  });
}
