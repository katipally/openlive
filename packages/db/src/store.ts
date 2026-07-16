import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { DATA_DIR } from "./paths";

// Tiny JSON-file store. Replaces SQLite for the single-user app: no native
// module, so the desktop build (Electron) and the container both stay pure-JS.
// BOTH processes write these files (web writes providers/settings; the agent
// writes conversations AND settings for binds/notes), so every read-modify-write
// must go through updateJson(), which holds a cross-process lock for the whole
// cycle. Plain writes are atomic (temp + rename) so a reader in the other
// process never sees a half-written file. Reads are always fresh from disk and
// lock-free — the rename guarantees a consistent snapshot. Fine at this scale —
// a handful of tiny files, low write rate.

const path = (name: string) => resolve(DATA_DIR, name);

export function readJson<T>(name: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path(name), "utf8")) as T; }
  catch { return fallback; }
}

export function writeJson(name: string, data: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${path(name)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path(name)); // atomic on the same filesystem
}

/** Cross-process-safe read-modify-write. Holds a lock on `<file>.lock` for the
 *  whole read→fn→write cycle so a concurrent update in the other process can't
 *  be lost. `realpath:false` lets us lock a file that doesn't exist yet;
 *  `stale:5000` self-heals a lock left behind by a killed process. */
const chains = new Map<string, Promise<unknown>>(); // per-file in-process queue

export async function updateJson<T>(name: string, fallback: T, fn: (cur: T) => T | Promise<T>): Promise<T> {
  // Same-process calls queue behind each other (no lock contention storms);
  // the lockfile below only has to arbitrate between the web and agent processes.
  const prev = chains.get(name) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const release = await lockfile.lock(path(name), {
      realpath: false,
      stale: 5000,
      retries: { retries: 10, minTimeout: 15, maxTimeout: 150 },
    });
    try {
      const next = await fn(readJson(name, fallback));
      writeJson(name, next);
      return next;
    } finally {
      await release();
    }
  });
  chains.set(name, run);
  return run;
}
