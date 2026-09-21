import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { IdleTimer } from "./idle";
import { appendEntry, readSession, sessionFileName, tailEntries, writeHeader } from "./jsonl";
import { isOwnerLive, selfProcessStartId } from "./lease";
import { ensureDir, flowDir, sessionAssetsDir, sessionsDir } from "./paths";
import { SESSION_FORMAT_VERSION, type SessionEntry, type SessionHeader, type SessionState } from "./types";

export interface OpenSessionOptions {
  title?: string;
  /** Rolling window. 0 disables it. */
  idleMs?: number;
  /** Fired after the session has archived itself on idle expiry; the caller opens
   *  the next one on the next trigger. Must not throw. */
  onIdle?: (session: FlowSession) => void;
  meta?: Record<string, unknown>;
}

/** One session file plus its assets directory. Appends are serialised per file by
 *  jsonl.ts, so concurrent callers in this process cannot interleave a line. */
export class FlowSession {
  private tipId: string | null = null;
  private seq = 0;
  private idle: IdleTimer | null = null;
  private closed = false;

  private constructor(readonly id: string, readonly path: string, readonly header: SessionHeader) {}

  static async open(opts: OpenSessionOptions = {}): Promise<FlowSession> {
    const id = randomUUID();
    const createdAt = new Date();
    const path = join(ensureDir(sessionsDir()), sessionFileName(id, createdAt));
    const header: SessionHeader = {
      ...opts.meta,
      v: SESSION_FORMAT_VERSION,
      kind: "header",
      id,
      createdAt: createdAt.toISOString(),
      ...(opts.title ? { title: opts.title } : {}),
    };
    await writeHeader(path, header);
    const session = new FlowSession(id, path, header);
    session.startIdle(opts);
    await session.setState("active");
    return session;
  }

  /** Reopen an existing file and continue from `tipId`, or from the last entry.
   *  A tip in the middle of the log branches: the new entries parent onto it and
   *  the old ones stay where they are. */
  static async resume(path: string, tipId?: string, opts: OpenSessionOptions = {}): Promise<FlowSession> {
    const { header, entries } = readSession(path);
    const id = header?.id ?? basename(path, ".jsonl");
    const session = new FlowSession(id, path, header ?? { v: SESSION_FORMAT_VERSION, kind: "header", id, createdAt: "" });
    session.tipId = tipId ?? lastContentEntry(entries)?.id ?? null;
    session.seq = entries.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
    session.startIdle(opts);
    await session.setState("active");
    return session;
  }

  get tip(): string | null { return this.tipId; }

  get assetsDir(): string { return sessionAssetsDir(this.id); }

  /** Append one entry under the current tip (or under `parentId` to branch). */
  async append(type: SessionEntry["type"], data: Record<string, unknown> = {}, parentId?: string): Promise<SessionEntry> {
    const entry = await this.write(type, data, parentId ?? this.tipId);
    this.tipId = entry.id;
    return entry;
  }

  private async write(type: SessionEntry["type"], data: Record<string, unknown>, parentId: string | null): Promise<SessionEntry> {
    const entry: SessionEntry = {
      ...data,
      id: randomUUID(),
      parentId,
      seq: this.seq++,
      timestamp: new Date().toISOString(),
      type,
    };
    await appendEntry(this.path, entry);
    this.idle?.reset();
    return entry;
  }

  async archive(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.idle?.stop();
    this.idle = null;
    await this.setState("archived");
  }

  /** Store an asset next to the session and return the path that goes in the log.
   *  Assets never enter the JSONL, only this relative path. */
  writeAsset(name: string, data: Buffer | string): string {
    const safe = basename(name).replace(/[/\\]/g, "_");
    const file = join(ensureDir(this.assetsDir), safe);
    writeFileSync(file, data, { mode: 0o600 });
    return relative(flowDir(), file).split(sep).join("/");
  }

  readAsset(relPath: string): Buffer { return readFileSync(resolveAsset(relPath)); }

  /** State is about the session, not about the conversation, so it hangs off the
   *  current tip without becoming one: resuming from a tip must land the next
   *  real entry on that tip. */
  private setState(state: SessionState): Promise<SessionEntry> {
    return this.write("session_state", { state, pid: process.pid, processStartId: selfProcessStartId() }, this.tipId);
  }

  private startIdle(opts: OpenSessionOptions): void {
    if (!opts.idleMs) return;
    this.idle = new IdleTimer(opts.idleMs, () => {
      void this.archive().then(() => opts.onIdle?.(this));
    });
    this.idle.reset();
  }
}

/** Resolve a logged asset path back to disk, refusing anything that climbs out of
 *  the store. */
export function resolveAsset(relPath: string): string {
  const root = flowDir();
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`asset path escapes the flow store: ${relPath}`);
  return abs;
}

/** The session's own view of its state. `active` with a dead owner is a crash:
 *  nothing wrote the closing entry, so the log still claims it is running. */
export function readSessionState(path: string): SessionState {
  const entry = lastStateEntry(path);
  if (!entry) return "archived";
  const state = entry.state as SessionState;
  if (state !== "active") return state;
  const pid = typeof entry.pid === "number" ? entry.pid : 0;
  const processStartId = typeof entry.processStartId === "string" ? entry.processStartId : null;
  return isOwnerLive({ pid, processStartId }) ? "active" : "crash";
}

/** The closing entry is the last line, and the opening one is near the top, so a
 *  bounded tail answers this without reading a long session end to end. */
function lastStateEntry(path: string): SessionEntry | null {
  const fromTail = findState(tailEntries(path));
  if (fromTail) return fromTail;
  try { return findState(readSession(path, 256 * 1024).entries); } catch { return null; }
}

/** The tip a plain (unbranched) session continues from: state markers hang off
 *  the tree rather than extending it. */
const lastContentEntry = (entries: SessionEntry[]): SessionEntry | null => {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.type !== "session_state") return entries[i]!;
  return null;
};

const findState = (entries: SessionEntry[]): SessionEntry | null => {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.type === "session_state") return entries[i]!;
  return null;
};
