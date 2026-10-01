import { createHash, randomUUID } from "node:crypto";
import { getSetting, updateSetting } from "@openlive/db";
import { cleanNote, noteCost, noteKey, NOTES_BUDGET_CHARS, NOTES_MAX, type MemoryWire } from "@openlive/shared";

// The notes behind the `remember` tool: one JSON array in the `agent_notes`
// setting, oldest first. Every brain's prompt reads it through notesInUse.

export interface Note { id: string; text: string; at?: number }

const KEY = "agent_notes";

/**
 * The stored array, either shape: bare strings (what was saved before notes had
 * ids) or notes. A bare string's id comes from its text, so it is the same on
 * every read until the next write stores it as a note. Nothing is dropped but
 * entries with no text.
 */
export function parseNotes(raw: string | undefined): Note[] {
  let arr: unknown;
  try { arr = JSON.parse(raw ?? "[]"); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const notes: Note[] = [];
  for (const [i, n] of arr.entries()) {
    const o = typeof n === "string" ? { text: n } : (n as Partial<Note> | null) ?? {};
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!text) continue;
    let id = typeof o.id === "string" && o.id ? o.id : `n${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
    if (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    notes.push({ id, text, ...(typeof o.at === "number" && Number.isFinite(o.at) && { at: o.at }) });
  }
  return notes;
}

export const readNotes = (): Note[] => parseNotes(getSetting(KEY));

/** The newest notes that fit the prompt budget, oldest first as they are listed. A note that does not fit ends the run: older ones are never let in past it. O(notes). */
export function budgeted(notes: readonly Note[]): { inUse: Note[]; used: number } {
  let used = 0, from = notes.length;
  while (from > 0 && used + noteCost(notes[from - 1]!.text) <= NOTES_BUDGET_CHARS) used += noteCost(notes[--from]!.text);
  return { inUse: notes.slice(from), used };
}

export const notesInUse = (): Note[] => budgeted(readNotes()).inUse;

export function memoryWire(notes: readonly Note[] = readNotes()): MemoryWire {
  const { inUse, used } = budgeted(notes);
  const live = new Set(inUse.map((n) => n.id));
  return { notes: notes.map((n) => ({ ...n, inUse: live.has(n.id) })).reverse(), used, budget: NOTES_BUDGET_CHARS, max: NOTES_MAX };
}

export type NoteResult<R extends string> = { ok: true; note: Note } | { ok: false; reason: R };

/** Read, change and write the notes under one lock; the stored array always leaves in the current shape. */
async function mutate<R>(fn: (notes: Note[]) => R): Promise<R> {
  let result!: R;
  await updateSetting(KEY, (raw) => {
    const notes = parseNotes(raw);
    result = fn(notes);
    return JSON.stringify(notes);
  });
  return result;
}

export const addNote = (input: string): Promise<NoteResult<"empty" | "duplicate" | "full">> => mutate((notes) => {
  const text = cleanNote(input);
  if (!text) return { ok: false, reason: "empty" };
  const key = noteKey(text);
  if (notes.some((n) => noteKey(n.text) === key)) return { ok: false, reason: "duplicate" };
  if (notes.length >= NOTES_MAX) return { ok: false, reason: "full" };
  const note = { id: randomUUID(), text, at: Date.now() };
  notes.push(note);
  return { ok: true, note };
});

export const editNote = (id: string, input: string): Promise<NoteResult<"empty" | "duplicate" | "missing">> => mutate((notes) => {
  const i = notes.findIndex((n) => n.id === id);
  if (i < 0) return { ok: false, reason: "missing" };
  const text = cleanNote(input);
  if (!text) return { ok: false, reason: "empty" };
  const key = noteKey(text);
  if (notes.some((n, j) => j !== i && noteKey(n.text) === key)) return { ok: false, reason: "duplicate" };
  notes[i] = { ...notes[i]!, text };
  return { ok: true, note: notes[i]! };
});

export const deleteNote = (id: string): Promise<boolean> => mutate((notes) => {
  const i = notes.findIndex((n) => n.id === id);
  if (i >= 0) notes.splice(i, 1);
  return i >= 0;
});

export const clearNotes = (): Promise<void> => mutate((notes) => { notes.length = 0; });
