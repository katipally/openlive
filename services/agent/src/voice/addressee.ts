import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "@openlive/db";
import { isSideTalk, sideScore, FEATURES, type Feats, type Head, type Scene } from "@openlive/shared/speech/addressee";
import { HEAD } from "@openlive/shared/speech/addressee-head";
import { engineInstalled, NATIVE_FAMILIES } from "./native-models.js";
import { embed } from "./native.js";

// The side talk check (apps/web voiceEngine.ts asks it about each finished
// sentence): the sentence's embedding, scored by the head tools/addressee
// fitted (@openlive/shared/speech/addressee), or by the user's own head once
// `pnpm addressee:train` wrote one that passed its eval. Nothing it hears is
// stored unless the page asks for the judgment log (Settings, off by default):
// then each judgment is kept in DATA_DIR only, for that training, and never sent anywhere.

export const ADDRESSEE_MODEL = NATIVE_FAMILIES.find((f) => f.kind === "addressee")!.variants[0]!;

export const LOG_FILE = resolve(DATA_DIR, "addressee-log.jsonl");
export const HEAD_FILE = resolve(DATA_DIR, "addressee-head.json");
// Entries kept, oldest evicted first: about 1 KB each, a few MB in all.
export const LOG_CAP = 5000;

/** One judged sentence. `label`: the user's correction ("to": Send it, "side":
 *  Not for you); `mode`: whether the verdict could drop it. */
export interface LogEntry {
  id: string; at: number; text: string; reply: string; speaker?: string; mode: "shadow" | "ignore";
  score: number; side: boolean; head: "personal" | "shipped"; feats?: Feats; label?: "to" | "side";
}
export interface PersonalHead extends Head { model: string; eval: { pass: boolean } }

// The log is an append-only file, a judgment or a label per line, folded on
// first use into `log` (insertion order is age). Once the file holds twice the
// cap in lines it is rewritten with only the kept entries, so an append stays
// O(1) amortized and the file under 2 x LOG_CAP lines.
let log: Map<string, LogEntry> | null = null;
let lines = 0;

/** The log as kept, oldest first, labels applied. O(lines) the first time. */
export function readLog(): Map<string, LogEntry> {
  if (log) return log;
  log = new Map();
  lines = 0;
  let raw = "";
  try { raw = readFileSync(LOG_FILE, "utf8"); } catch { return log; }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    lines++;
    try {
      const r = JSON.parse(line) as Partial<LogEntry> & { id: string };
      if (typeof r.text === "string") keep(r as LogEntry);
      else { const e = log.get(r.id); if (e && (r.label === "to" || r.label === "side")) e.label = r.label; }
    } catch { /* a line torn by a crash: skipped */ }
  }
  return log;
}

function keep(e: LogEntry) {
  log!.set(e.id, e);
  if (log!.size > LOG_CAP) log!.delete(log!.keys().next().value!);
}

function append(r: object) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LOG_FILE, `${JSON.stringify(r)}\n`);
  if (++lines <= 2 * LOG_CAP) return;
  writeFileSync(`${LOG_FILE}.tmp`, [...log!.values()].map((e) => `${JSON.stringify(e)}\n`).join(""));
  renameSync(`${LOG_FILE}.tmp`, LOG_FILE);
  lines = log!.size;
}

/** Marks the judgment `id` said to the app ("to") or not ("side"). False when it is not kept. */
export function labelJudgment(id: string, label: "to" | "side"): boolean {
  const e = readLog().get(id);
  if (!e) return false;
  e.label = label;
  append({ id, label });
  return true;
}

/** Deletes the log and the head trained on it: nothing of what was heard is left. */
export function deleteLog() {
  rmSync(LOG_FILE, { force: true });
  rmSync(HEAD_FILE, { force: true });
  log = new Map();
  lines = 0;
}

// The user's head, read again only when its file changes (a training run while the agent is up).
let personal: { mtime: number; head: PersonalHead | null } = { mtime: -1, head: null };
/** The user's head when it is for this model, passed its eval and has the
 *  right shape; else null, and the shipped head judges. */
export function personalHead(): PersonalHead | null {
  let mtime = 0;
  try { mtime = statSync(HEAD_FILE).mtimeMs; } catch { return null; }
  if (mtime === personal.mtime) return personal.head;
  let h: PersonalHead | null = null;
  try { h = JSON.parse(readFileSync(HEAD_FILE, "utf8")) as PersonalHead; } catch { /* unreadable: the shipped head */ }
  const ok = h?.model === ADDRESSEE_MODEL.id && h.eval?.pass === true && h.w?.length === HEAD.w.length && Number.isFinite(h.threshold)
    && (!h.feats || (h.feats.w.length === FEATURES.length && h.feats.sd.every((s) => s > 0)));
  personal = { mtime, head: ok ? h : null };
  return personal.head;
}

/** For Settings: the model, which head judges, and the log's size. O(log) to count labels. */
export function addresseeStatus() {
  let labelled = 0;
  for (const e of readLog().values()) if (e.label) labelled++;
  return { engine: ADDRESSEE_MODEL.id, installed: engineInstalled(ADDRESSEE_MODEL), head: personalHead() ? "personal" : "shipped", log: { count: readLog().size, labelled, cap: LOG_CAP } };
}

/** Whether `text` is side talk, and the head's log-odds that it is. With `keepAs`,
 *  the judgment is logged under that id. */
export async function judge(text: string, scene: Scene, feats?: Feats, keepAs?: { id: string; mode: LogEntry["mode"] }) {
  const head = personalHead() ?? HEAD;
  const score = sideScore(await embed(ADDRESSEE_MODEL, text), head, feats);
  const side = isSideTalk(text, score, scene, head.threshold);
  if (keepAs && !readLog().has(keepAs.id)) {
    const e: LogEntry = { id: keepAs.id, at: Date.now(), text: text.slice(0, 1000), reply: scene.reply.slice(-300), speaker: scene.speaker?.slice(0, 40), mode: keepAs.mode, score, side, head: head === HEAD ? "shipped" : "personal", feats };
    keep(e);
    append(e);
  }
  return { side, score };
}
