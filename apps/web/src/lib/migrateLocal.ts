import { adopt, savedGroup, type Fields, type Saved } from "./persist";
import { FLOW_ONBOARDED_KEY } from "./flow/onboarding";
import { CAPABILITY_TABS } from "./settingsSearch";

// Before ui.json, the renderer kept its state in the browser's localStorage,
// outside the OpenLive folder: missed by backups and the home's own migration,
// and gone whenever Chromium's profile was. Once per key, its value moves into
// the file (only where the file has nothing for it), then the key is removed.
// Left on purpose: "openlive-models-ready-v1" and its pre-rebrand
// "takt-live-models-ready-v1" say what is in this browser's model cache, which
// lives and dies with the same profile, and "openlive-debug", a developer's
// switch set by hand in DevTools.

const json = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return undefined; } };
const isObj = (v: unknown): v is Fields => !!v && typeof v === "object" && !Array.isArray(v);
const MODES = ["chat", "flow", "dictate"];

type Read = (raw: string, key: string) => [group: string, field: string, value: unknown] | null;

/** Exact keys. A read returns where the value goes, or null for a value not worth keeping. */
const EXACT: Record<string, Read> = {
  "openlive-mode": (v) => (MODES.includes(v) ? ["ui", "mode", v] : null),
  "openlive-capabilities-tab": (v) => ((CAPABILITY_TABS as readonly string[]).includes(v) ? ["ui", "capabilitiesTab", v] : null),
  "ol-sessions-filter": (v) => (v === "openlive" || v === "all" ? ["ui", "sessionsFilter", v] : null),
  "ol-transcript-open": (v) => ["ui", "transcriptOpen", v !== "0"],
  "ol-transcript-w": (v) => { const n = Number(v); return n >= 280 && n <= 640 ? ["ui", "transcriptWidth", n] : null; },
  "openlive-pipeline-v1": (v) => { const p = json(v); return isObj(p) ? ["voice", "pipeline", p] : null; },
  "openlive-voice-input": (v) => (v === "toggle" || v === "hold" ? ["voice", "inputMode", v] : null),
  "openlive-ptt-enabled": (v) => ["voice", "pttEnabled", v === "1"],
  "openlive-recent-folders": (v) => {
    const p = json(v);
    return Array.isArray(p) ? ["sessions", "recentFolders", p.filter((x) => typeof x === "string").slice(0, 8)] : null;
  },
  "openlive-welcomed": (v) => ["onboarding", "welcomed", v === "1"],
  [FLOW_ONBOARDED_KEY]: (v) => (v ? ["onboarding", "flowOnboarded", v.slice(0, 32)] : null),
};

/** Keys with an id after the prefix. Matched after EXACT, so "openlive-mode" never reads as an agent's mode. */
const PREFIXED: [prefix: string, read: (raw: string, id: string) => [group: string, field: string, sub: string, value: unknown] | null][] = [
  ["openlive-bind:", (v, id) => (v ? ["sessions", `chat:${id}`, "bind", v] : null)],
  ["openlive-cwd:", (v, id) => (v ? ["sessions", `chat:${id}`, "cwd", v] : null)],
  ["openlive-resume:", (v, id) => (v ? ["sessions", `chat:${id}`, "resume", v] : null)],
  ["openlive-meta:", (v, id) => { const m = json(v); return isObj(m) ? ["sessions", `agent:${id}`, "meta", m] : null; }],
  ["openlive-model:", (v, id) => (v ? ["sessions", `agent:${id}`, "model", v] : null)],
  ["openlive-mode:", (v, id) => (v ? ["sessions", `agent:${id}`, "mode", v] : null)],
  // agent:option, split at the first colon: agent ids have none.
  ["openlive-opt:", (v, rest) => {
    const at = rest.indexOf(":");
    return v && at > 0 ? ["sessions", `agent:${rest.slice(0, at)}`, "opts", { [rest.slice(at + 1)]: v }] : null;
  }],
];
const DISCLOSURE = "openlive:disclosure";
const TOUR = "openlive-tour-";

/**
 * What the old keys hold that the file does not, and every key that is OpenLive's
 * to remove (one holding garbage too). Pure; O(keys + size of their values).
 */
export function fromLocalStorage(keys: string[], get: (key: string) => string | null, saved: (group: string) => Fields): { patch: Saved; remove: string[] } {
  const patch: Saved = {};
  const remove: string[] = [];
  const put = (group: string, field: string, value: unknown) => {
    if (saved(group)[field] !== undefined) return;
    (patch[group] ??= {})[field] = value;
  };
  /** Into an object field, one sub-field at a time, each only when the file lacks it. */
  const putIn = (group: string, field: string, sub: string, value: unknown) => {
    const have = saved(group)[field];
    const old = isObj(have) ? have : {};
    const into = ((patch[group] ??= {})[field] ??= { ...old }) as Fields;
    if (sub === "opts") into.opts = { ...(value as Fields), ...(into.opts as Fields | undefined) };
    else if (old[sub] === undefined) into[sub] = value;
  };
  const tours: string[] = [];
  for (const key of keys) {
    const raw = get(key);
    if (raw === null) continue;
    const exact = EXACT[key];
    if (exact) {
      remove.push(key);
      const hit = exact(raw, key);
      if (hit) put(...hit);
    } else if (key === DISCLOSURE) {
      remove.push(key);
      const open = json(raw);
      if (isObj(open)) for (const [k, v] of Object.entries(open)) if (typeof v === "boolean" && !k.startsWith("hist:ws:")) put("disclosure", k, v);
    } else if (key.startsWith(TOUR)) {
      remove.push(key);
      if (raw) tours.push(key.slice(TOUR.length));
    } else {
      const pre = PREFIXED.find(([p]) => key.startsWith(p));
      if (!pre) continue;
      remove.push(key);
      const id = key.slice(pre[0].length);
      const hit = id && pre[1](raw, id);
      if (hit) putIn(...hit);
    }
  }
  if (tours.length) put("onboarding", "tours", [...new Set(tours)].sort());
  // An entry the file already had in full adds nothing.
  for (const [g, fields] of Object.entries(patch)) {
    for (const [f, v] of Object.entries(fields)) if (JSON.stringify(v) === JSON.stringify(saved(g)[f])) delete fields[f];
    if (!Object.keys(fields).length) delete patch[g];
  }
  return { patch, remove };
}

/** Move whatever the old keys hold into the file, then drop the keys. Safe to
 *  run again: a key goes only once the file has its value, and a key whose
 *  value the file already has just goes. */
export async function migrateLocalStorage(): Promise<void> {
  let keys: string[];
  try { keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => k !== null); }
  catch { return; } // storage blocked: nothing could have been kept there
  const { patch, remove } = fromLocalStorage(keys, (k) => { try { return localStorage.getItem(k); } catch { return null; } }, savedGroup);
  if (!remove.length || !(await adopt(patch))) return;
  for (const k of remove) { try { localStorage.removeItem(k); } catch { /* gone with the profile anyway */ } }
}
