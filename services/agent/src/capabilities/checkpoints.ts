import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { layout, resolveHome, writeAtomic } from "@openlive/shared/home";
import type { EditWire } from "@openlive/shared";
import { localZone, spokenTime } from "../reminders/time.js";
import { confine, root } from "./files.js";
import type { Tool, ToolResult } from "./types.js";

// Every write_file and edit_file keeps the file as it was, so it can be undone.
// One folder per workspace under cache/checkpoints: blobs/<sha256> holds each
// pre-image once, journal.json lists the edits oldest first. Only edits made
// through OpenLive's own file tools are here; a coding agent's own edits and
// shell commands never pass through them.

const KEEP_EDITS = 200;
const KEEP_BYTES = 200 * 1024 * 1024;
const KEEP_MS = 14 * 86_400_000;

export interface Edit {
  id: string;
  /** Relative to the workspace, forward slashes, as the user wrote the case. */
  path: string;
  at: string;
  tool: EditWire["tool"];
  /** The pre-image's hash, or null when the file did not exist. */
  before: string | null;
  /** The hash it was left with, or null when the edit deleted it. */
  after: string | null;
  /** The pre-image's size. */
  bytes: number;
  added: number;
  removed: number;
  /** The pre-image was larger than the whole budget, so it was not kept. */
  big?: true;
  /** The edit this one undid. */
  undoOf?: string;
}
interface Journal { root: string; edits: Edit[] }

const fail = (why: string): never => { throw new Error(why); };
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Windows and macOS file systems ignore case by default, so their paths compare without it. */
const folds = (platform: NodeJS.Platform) => platform === "win32" || platform === "darwin";

/** How a workspace-relative path compares: forward slashes, and case folded where the OS ignores it. */
export function relKey(rel: string, platform: NodeJS.Platform = process.platform): string {
  const r = platform === "win32" ? rel.replace(/\\/g, "/") : rel;
  return folds(platform) ? r.toLowerCase() : r;
}

export const wsKey = (base: string, platform: NodeJS.Platform = process.platform) =>
  createHash("sha256").update(folds(platform) ? base.toLowerCase() : base).digest("hex").slice(0, 16);

/** Read per call, so a test's OPENLIVE_HOME applies. */
const store = () => layout(resolveHome()).checkpoints;
const journalFile = (dir: string) => path.join(dir, "journal.json");
const blobFile = (dir: string, h: string) => path.join(dir, "blobs", h);

function load(dir: string): Journal {
  try { return JSON.parse(readFileSync(journalFile(dir), "utf8")) as Journal; } catch { return { root: "", edits: [] }; }
}

const readOrNull = (abs: string) => readFile(abs).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));

const lines = (s: string) => (s ? s.replace(/\r?\n$/, "").split(/\r?\n/) : []);
/** Lines added and removed, counted as multisets: O(n + m), and blind to moved lines, which a summary can afford. */
export function lineDelta(a: string, b: string): { added: number; removed: number } {
  const left = new Map<string, number>();
  for (const l of lines(a)) left.set(l, (left.get(l) ?? 0) + 1);
  let added = 0, removed = 0;
  for (const l of lines(b)) { const n = left.get(l) ?? 0; if (n) left.set(l, n - 1); else added++; }
  for (const n of left.values()) removed += n;
  return { added, removed };
}

export function summary(e: Edit): string {
  const d = `+${e.added} -${e.removed} lines`;
  return e.before === null ? `created, ${d}` : e.after === null ? `deleted, ${d}` : d;
}

/**
 * The newest edits that fit: at most KEEP_EDITS, pre-images within KEEP_BYTES
 * (a blob two edits share counts once), none older than KEEP_MS. O(n).
 */
export function prune(edits: Edit[], now: number): Edit[] {
  const kept: Edit[] = [], blobs = new Set<string>();
  let bytes = 0;
  for (let i = edits.length - 1; i >= 0 && kept.length < KEEP_EDITS; i--) {
    const e = edits[i]!;
    if (now - Date.parse(e.at) > KEEP_MS) break;
    if (e.before && !e.big && !blobs.has(e.before)) {
      if (bytes + e.bytes > KEEP_BYTES) break;
      blobs.add(e.before);
      bytes += e.bytes;
    }
    kept.push(e);
  }
  return kept.reverse();
}

/** Writes the pruned journal and deletes the blobs it no longer names. O(edits + blobs). */
function keep(dir: string, root: string, edits: Edit[]): void {
  if (!edits.length) { rmSync(dir, { recursive: true, force: true }); return; }
  writeAtomic(journalFile(dir), JSON.stringify({ root, edits } satisfies Journal));
  const named = new Set(edits.map((e) => e.before));
  let blobs: string[] = [];
  try { blobs = readdirSync(path.join(dir, "blobs")); } catch { /* none yet */ }
  for (const b of blobs) if (!named.has(b)) rmSync(blobFile(dir, b), { force: true });
}

// One edit at a time per workspace: the journal is read, changed and written whole.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  queues.set(key, run.catch(() => {}));
  return run;
}

/** Keeps the pre-image, writes `next` (null deletes), then journals it. Call inside `serial`. */
async function save(base: string, abs: string, next: Buffer | null, tool: Edit["tool"], undoOf?: string): Promise<Edit> {
  const dir = path.join(store(), wsKey(base));
  const prev = await readOrNull(abs);
  const before = prev && hash(prev);
  const big = !!prev && prev.length > KEEP_BYTES;
  // Before the write: a pre-image that cannot be kept stops the edit, so nothing changes unrecorded.
  if (prev && before && !big && !existsSync(blobFile(dir, before))) writeAtomic(blobFile(dir, before), prev);
  if (next === null) await rm(abs, { force: true });
  else { await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, next); }
  const edit: Edit = {
    id: randomBytes(4).toString("hex"),
    path: path.relative(base, abs).split(path.sep).join("/"),
    at: new Date().toISOString(),
    tool,
    before,
    after: next && hash(next),
    bytes: prev?.length ?? 0,
    ...lineDelta(prev?.toString("utf8") ?? "", next?.toString("utf8") ?? ""),
    ...(big && { big: true as const }),
    ...(undoOf && { undoOf }),
  };
  keep(dir, base, prune([...load(dir).edits, edit], Date.now()));
  return edit;
}

/** write_file and edit_file's one way to change a file. `base` is the workspace's real path. */
export const checkpointed = (base: string, abs: string, next: string, tool: "write_file" | "edit_file") =>
  serial(wsKey(base), () => save(base, abs, Buffer.from(next, "utf8"), tool));

/** A workspace's edits, oldest first, as retention leaves them. */
export const editsIn = (base: string): Edit[] => prune(load(path.join(store(), wsKey(base))).edits, Date.now());

/** By id, else the newest to `rel`, else the newest of all. */
export function pick(edits: Edit[], sel: { id?: string; rel?: string }, platform: NodeJS.Platform = process.platform): Edit {
  if (sel.id?.trim()) return edits.find((e) => e.id === sel.id!.trim()) ?? fail(`No edit has id ${sel.id}. list_edits shows the recent ones.`);
  if (sel.rel) {
    const k = relKey(sel.rel, platform);
    return edits.findLast((e) => relKey(e.path, platform) === k) ?? fail(`No edit to ${sel.rel} was made through OpenLive's file tools.`);
  }
  return edits.at(-1) ?? fail("No edits were made through OpenLive's file tools in this workspace yet.");
}

/** Refuses an undo that would throw away a later change, unless forced. */
async function undoable(base: string, e: Edit, force: boolean): Promise<string> {
  const abs = confine(base, e.path) ?? fail("That path is outside the workspace folder, which is not allowed.");
  if (e.big) fail(`${e.path} was too large to keep a copy of before that edit, so it cannot be undone.`);
  const now = await readOrNull(abs);
  if (!force && (now && hash(now)) !== e.after) fail(`${e.path} changed after that edit, so undoing it now would lose the newer changes.`);
  return abs;
}

/** Restores `e`'s pre-image. Itself an edit, so undoing the undo redoes it. */
export const undo = (base: string, e: Edit, force = false) => serial(wsKey(base), async () => {
  const abs = await undoable(base, e, force);
  const dir = path.join(store(), wsKey(base));
  const prev = e.before === null ? null
    : await readFile(blobFile(dir, e.before)).catch(() => fail(`The copy of ${e.path} from before that edit was cleared, so it cannot be undone.`));
  return save(base, abs, prev, "undo_edit", e.id);
});

/** Every workspace's edits, newest first, for Settings. Prunes each journal on the way. O(W·E log). */
export async function recentEdits(limit = 20): Promise<EditWire[]> {
  let dirs: string[] = [];
  try { dirs = readdirSync(store()); } catch { return []; }
  const all = await Promise.all(dirs.map((d) => serial(d, async () => {
    const dir = path.join(store(), d), j = load(dir), edits = prune(j.edits, Date.now());
    if (edits.length !== j.edits.length) keep(dir, j.root, edits);
    return edits.map((e): EditWire => ({ id: e.id, root: j.root, path: e.path, at: e.at, tool: e.tool, summary: summary(e) }));
  })));
  return all.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** The edit with this id in any workspace, undone. Null when no workspace has it. */
export async function undoById(id: string, force = false): Promise<Edit | null> {
  let dirs: string[] = [];
  try { dirs = readdirSync(store()); } catch { return null; }
  for (const d of dirs) {
    const j = load(path.join(store(), d));
    const e = j.edits.find((x) => x.id === id);
    if (e) return undo(j.root, e, force);
  }
  return null;
}

// ── the tools ───────────────────────────────────────────────────────────────

const text = <D>(t: string, details: D): ToolResult<D> => ({ content: [{ type: "text", text: t }], details });
const hasWorkspace = (s: { workspace?: () => string }) => !!s.workspace;
const baseOf = (ws: string) => confine(ws, "") ?? fail("The workspace folder could not be read.");
const when = (at: string) => spokenTime(Date.parse(at), Date.now(), localZone());
const line = (e: Edit) => `- ${e.id}: ${e.path}, ${when(e.at)}, ${e.tool === "undo_edit" ? `undo of ${e.undoOf}, ` : ""}${summary(e)}`;
const SCOPE = "Only edits made through OpenLive's write_file and edit_file are kept, not a coding agent's own edits or shell commands.";

const listEdits: Tool<{ limit?: number }, { edits: Edit[] }> = {
  name: "list_edits",
  group: "find",
  readOnly: true,
  description: `List recent file edits in the workspace that undo_edit can undo, newest first, with each one's id, file, time and how many lines it changed. ${SCOPE}`,
  parameters: { type: "object", properties: { limit: { type: "number", description: "How many, newest first. Defaults to 10, at most 50." } }, additionalProperties: false },
  available: hasWorkspace,
  async execute(args, ctx) {
    const n = Math.min(50, Math.max(1, Math.floor(Number(args?.limit) || 10)));
    const edits = editsIn(baseOf(root(ctx))).slice(-n).reverse();
    return text(edits.length ? edits.map(line).join("\n") : "No edits were made through OpenLive's file tools in this workspace yet.", { edits });
  },
};

/** What precheck found, so the question names the file. Keyed by the call's own args object. */
const targets = new WeakMap<object, Edit>();

const undoEdit: Tool<{ id?: string; path?: string; force?: boolean }, { edit: Edit }> = {
  name: "undo_edit",
  group: "find",
  description: "Undo a file edit made with write_file or edit_file: put the file back as it was, or remove it if the edit created it. Give an id from list_edits, a path for that file's latest edit, or neither for the latest of all. Refuses when the file changed since, unless force is true; force only after the user agrees to lose those changes. Undoing an undo redoes it.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The edit's id, from list_edits." },
      path: { type: "string", description: "Or a path inside the workspace: undoes that file's latest edit." },
      force: { type: "boolean", description: "Undo even though the file changed after the edit, losing that change." },
    },
    additionalProperties: false,
  },
  available: hasWorkspace,
  confirm: (a) => {
    const e = targets.get(a);
    return e ? `undo the ${when(e.at)} change to ${e.path}` : `undo an edit to ${String(a.path ?? "a file").trim()} in your workspace`;
  },
  async precheck(args, ctx) {
    const base = baseOf(root(ctx));
    const e = pickFor(base, args);
    await undoable(base, e, !!args.force);
    targets.set(args, e);
  },
  async execute(args, ctx) {
    const base = baseOf(root(ctx));
    const e = targets.get(args) ?? pickFor(base, args);
    const done = await undo(base, e, !!args.force);
    return text(`Undid the ${when(e.at)} change to ${e.path}${e.before === null ? ", so it is gone again" : ""}. To redo it, undo edit ${done.id}.`, { edit: done });
  },
};

function pickFor(base: string, a: { id?: string; path?: string }): Edit {
  const given = a.path?.trim();
  const abs = given ? confine(base, given) ?? fail("That path is outside the workspace folder, which is not allowed.") : "";
  return pick(editsIn(base), { id: a.id, rel: given && path.relative(base, abs).split(path.sep).join("/") });
}

export const EDIT_TOOLS: Tool[] = [listEdits, undoEdit];
