import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, flowDir } from "./paths";
import type { DictateKeep } from "./config";

// Dictate's history: what was said and what was typed, kept on this machine
// for as long as Settings > Dictate says and never sent anywhere. One JSONL
// file, a dictation or a deletion per line, so a write is one append. A read
// folds it and, once dropped lines outnumber kept ones, rewrites it with only
// what is kept, so the file stays under about twice the kept size.

export interface Dictation {
  id: string;
  at: number;
  /** As the speech engine wrote it. */
  raw: string;
  /** After the cleanup rules, the words and a snippet. */
  cleaned: string;
  /** What went in: the polished or commanded text, or `cleaned`. */
  final: string;
  /** The app in front, where the platform names it. */
  app?: string;
  /** Command mode's result rather than a dictation. */
  command?: boolean;
  /** Put on the clipboard because nothing took the typing. */
  copied?: boolean;
}

/** Newest kept, oldest dropped first. With TEXT_MAX, under ~25 MB at worst. */
export const DICTATION_CAP = 1000;
const TEXT_MAX = 4000;
const DAY = 86_400_000;
export const KEEP_MS: Record<DictateKeep, number> = { off: 0, day: DAY, week: 7 * DAY, month: 30 * DAY, forever: Infinity };

export const dictationsPath = (): string => join(flowDir(), "dictations.jsonl");

const cut = (s: unknown) => (typeof s === "string" ? s.slice(0, TEXT_MAX) : "");

/** Kept as given unless `keep` is off. Returns the stored dictation, or null when none is kept. */
export function addDictation(d: Omit<Dictation, "id" | "at">, keep: DictateKeep, at = Date.now()): Dictation | null {
  if (keep === "off") return null;
  const entry: Dictation = {
    id: randomUUID(), at, raw: cut(d.raw), cleaned: cut(d.cleaned), final: cut(d.final),
    ...(d.app && { app: cut(d.app).slice(0, 120) }), ...(d.command && { command: true }), ...(d.copied && { copied: true }),
  };
  ensureDir(flowDir());
  appendFileSync(dictationsPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

export function deleteDictation(id: string): void {
  ensureDir(flowDir());
  appendFileSync(dictationsPath(), `${JSON.stringify({ id, deleted: true })}\n`, { mode: 0o600 });
}

export function clearDictations(): void {
  rmSync(dictationsPath(), { force: true });
}

/** What `keep` still keeps, newest first. O(lines): one pass to fold, one to prune. */
export function readDictations(keep: DictateKeep, now = Date.now()): Dictation[] {
  let raw = "";
  try { raw = readFileSync(dictationsPath(), "utf8"); } catch { return []; }
  const byId = new Map<string, Dictation>();
  let lines = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    lines++;
    try {
      const r = JSON.parse(line) as Partial<Dictation> & { id?: string; deleted?: boolean };
      if (typeof r.id !== "string") continue;
      if (r.deleted) byId.delete(r.id);
      else if (typeof r.at === "number" && typeof r.final === "string") byId.set(r.id, r as Dictation);
    } catch { /* a line torn by a crash: skipped */ }
  }
  const since = now - KEEP_MS[keep];
  const kept = [...byId.values()].filter((d) => d.at >= since).slice(-DICTATION_CAP);
  if (lines > 2 * kept.length) {
    if (!kept.length) clearDictations();
    else {
      const tmp = `${dictationsPath()}.${process.pid}.tmp`;
      writeFileSync(tmp, kept.map((d) => `${JSON.stringify(d)}\n`).join(""), { mode: 0o600 });
      renameSync(tmp, dictationsPath());
    }
  }
  return kept.reverse();
}
