import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./paths";

// Tiny JSON-file store. Replaces SQLite for the single-user app: no native
// module, so the desktop build (Electron) and the container both stay pure-JS.
// Each "table" is its own file with a SINGLE writer process (web writes
// providers/settings; the agent writes conversations), so there's no cross-
// process write-write race. Writes are atomic (temp + rename) so a reader in the
// other process never sees a half-written file. Reads are always fresh from disk
// so one process picks up the other's writes (e.g. the agent reads a key the web
// just saved). Fine at this scale — a handful of tiny files, low write rate.

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
