import { renameSync } from "node:fs";
import { basename } from "node:path";
import { writeAtomic } from "@openlive/shared/home";
import { PATHS } from "./paths";
import { readText, withFileLock } from "./store";

// <home>/state/ui.json: what the app remembers between launches that is not a
// setting the servers act on: the mode and view it was left in, the voice
// pipeline, per-chat and per-agent picks, which first runs were seen. Groups
// of fields, each group owned by one renderer module, which also validates its
// own fields (apps/web/src/lib/persist.ts lists them). This side only keeps
// the shape: a group is an object, and a write replaces the fields it names,
// so two windows saving different fields never undo each other.

export const UI_STATE_VERSION = 1;
/** A patch bigger than this is refused: the whole file is read into every page. */
export const UI_PATCH_LIMIT = 2 << 20;

export type UiGroups = Record<string, Record<string, unknown>>;
/** Per group, the fields to set; a null field is removed. */
export type UiPatch = Record<string, Record<string, unknown>>;

const GROUP = /^[a-z][A-Za-z0-9]{0,39}$/;
const FIELD_MAX = 200;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The groups in a file's text: anything that is not an object group is
 *  dropped on its own, so one bad group never costs the others. A file from
 *  a newer version is read the same way; its fields still pass each owner's
 *  checks. Unreadable text reads as nothing saved. Pure. */
export function parseUiState(text: string | undefined): { version: number; groups: UiGroups; corrupt: boolean } {
  let raw: unknown;
  try { raw = text === undefined ? {} : JSON.parse(text); } catch { return { version: UI_STATE_VERSION, groups: {}, corrupt: true }; }
  if (!isObj(raw)) return { version: UI_STATE_VERSION, groups: {}, corrupt: true };
  const groups: UiGroups = {};
  for (const [k, v] of Object.entries(raw)) if (GROUP.test(k) && k !== "version" && isObj(v)) groups[k] = v;
  const version = typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version > 0 ? raw.version : UI_STATE_VERSION;
  return { version, groups, corrupt: false };
}

/** A request body as a patch, or why it is not one. Pure. */
export function validUiPatch(body: unknown): UiPatch | string {
  if (!isObj(body)) return "Expected an object of groups.";
  for (const [g, fields] of Object.entries(body)) {
    if (!GROUP.test(g) || g === "version") return `"${g.slice(0, 40)}" is not a group name.`;
    if (!isObj(fields)) return `Group "${g}" is not an object.`;
    for (const f of Object.keys(fields)) if (!f || f.length > FIELD_MAX) return `Group "${g}" has a field name that is empty or too long.`;
  }
  return body as UiPatch;
}

/** `groups` with `patch` laid over it, field by field. Untouched groups and
 *  fields, a newer version's among them, are kept. O(fields in patch). Pure. */
export function mergeUiPatch(groups: UiGroups, patch: UiPatch): UiGroups {
  const out: UiGroups = { ...groups };
  for (const [g, fields] of Object.entries(patch)) {
    const next = { ...out[g] };
    for (const [f, v] of Object.entries(fields)) {
      if (v === null) delete next[f];
      else next[f] = v;
    }
    if (Object.keys(next).length) out[g] = next;
    else delete out[g];
  }
  return out;
}

/** What is saved. Never throws: a missing or broken file reads as nothing saved. */
export function readUiState(): UiGroups {
  return parseUiState(readText(PATHS.ui)).groups;
}

/** Apply a patch under the cross-process lock and write atomically. A file
 *  that will not parse is set aside as ui.json.corrupt, not written over, so
 *  what it held can still be looked at. Resolves to every group now saved. */
export function patchUiState(patch: UiPatch): Promise<UiGroups> {
  return withFileLock(PATHS.ui, () => {
    const text = readText(PATHS.ui);
    const cur = parseUiState(text);
    if (cur.corrupt && text !== undefined) {
      try { renameSync(PATHS.ui, `${PATHS.ui}.corrupt`); } catch (e) { console.error(`[ui-state] could not set ${basename(PATHS.ui)} aside:`, e); }
    }
    const groups = mergeUiPatch(cur.groups, patch);
    writeAtomic(PATHS.ui, `${JSON.stringify({ version: Math.max(cur.version, UI_STATE_VERSION), ...groups }, null, 2)}\n`);
    return groups;
  });
}
