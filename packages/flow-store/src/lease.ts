import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { ensureDir, flowDir, leasePath } from "./paths";
import type { LeaseOwner } from "./types";

// The pill and the main window are separate renderers, and the agent service is a
// third process, so "who owns the live session" has to survive a hard kill. The
// lease is the owner record itself; proper-lockfile only arbitrates the
// read-modify-write around it. Staleness is a liveness probe, never a timestamp:
// a slow or suspended owner must never be evicted, and a killed one must be
// reclaimed immediately.

const LEASE_VERSION = 1;

// Same tuning as packages/db/src/store.ts: `update` refreshes the held lock so a
// live-but-slow holder is never judged stale, `stale` still self-heals after a kill.
const LOCK = { realpath: false, stale: 15000, update: 2500, retries: { retries: 15, minTimeout: 15, maxTimeout: 250 } } as const;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // alive, owned by someone else
}

/** A stable identifier for one *run* of a pid, so a recycled pid does not read as
 *  the original owner. The OS start time is the only portable source, and reading
 *  it costs a short-lived subprocess, so it is only ever consulted when a record
 *  claims an owner that is still alive. */
export function processStartId(pid: number): string | null {
  try {
    const out = process.platform === "win32"
      ? execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.Ticks`], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] })
      : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    const id = out.trim();
    return id || null;
  } catch { return null; }
}

let selfStartId: string | null | undefined;
export function selfProcessStartId(): string | null {
  if (selfStartId === undefined) selfStartId = processStartId(process.pid);
  return selfStartId;
}

/** True only if the recorded process is still running AND is the same run of it.
 *  An unknown start id cannot disprove ownership, so liveness alone decides. */
export function isOwnerLive(owner: { pid: number; processStartId: string | null }): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  if (!owner.processStartId) return true;
  const now = processStartId(owner.pid);
  return now === null || now === owner.processStartId;
}

export function readLease(path = leasePath()): LeaseOwner | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseOwner>;
    if (typeof o?.token !== "string" || typeof o.pid !== "number") return null;
    return {
      version: typeof o.version === "number" ? o.version : LEASE_VERSION,
      token: o.token,
      pid: o.pid,
      processStartId: typeof o.processStartId === "string" ? o.processStartId : null,
      sessionPath: typeof o.sessionPath === "string" ? o.sessionPath : "",
      createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    };
  } catch { return null; }
}

export interface Lease {
  owner: LeaseOwner;
  release(): Promise<void>;
}

/** Take the lease for `sessionPath`, or return null if a live process holds it.
 *  A stale owner (killed, or a recycled pid) is reclaimed here. */
export async function acquireLease(sessionPath: string, path = leasePath()): Promise<Lease | null> {
  ensureDir(flowDir());
  const release = await lockfile.lock(path, LOCK);
  try {
    const held = readLease(path);
    if (held && isOwnerLive(held)) return null;
    const owner: LeaseOwner = {
      version: LEASE_VERSION,
      token: randomUUID(),
      pid: process.pid,
      processStartId: selfProcessStartId(),
      sessionPath,
      createdAt: new Date().toISOString(),
    };
    writeOwner(path, owner);
    return { owner, release: () => releaseLease(owner, path) };
  } finally {
    await release();
  }
}

/** Idempotent and best-effort: releasing twice, or after another process has
 *  already reclaimed a stale lease, is a no-op rather than an error. */
export async function releaseLease(owner: LeaseOwner, path = leasePath()): Promise<void> {
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, LOCK);
    if (readLease(path)?.token === owner.token) rmSync(path, { force: true });
  } catch { /* nothing left to release */ }
  finally { await release?.().catch(() => {}); }
}

function writeOwner(path: string, owner: LeaseOwner): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner), { mode: 0o600 });
  renameSync(tmp, path); // atomic on the same filesystem
}
