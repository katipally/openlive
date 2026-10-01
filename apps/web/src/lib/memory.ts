// Memory settings, the pure half: finding a note in a long list, checking one
// before it is sent, and how full the prompt budget reads. No React, no DOM,
// so it tests on its own.

import { NOTE_MAX_CHARS, noteKey, type MemoryWire, type NoteWire } from "@openlive/shared";

/** Notes whose text holds the query, case-insensitive. O(notes). */
export function filterNotes(notes: readonly NoteWire[], query: string): NoteWire[] {
  const q = query.trim().toLowerCase();
  return q ? notes.filter((n) => n.text.toLowerCase().includes(q)) : [...notes];
}

/** What stops a note, checked as it is typed: too long once spacing is tidied, or the same as another. Nothing while it is empty. `selfId` is the note being edited. O(notes). */
export function noteProblem(text: string, notes: readonly NoteWire[], selfId?: string): string {
  const tidy = text.replace(/\s+/g, " ").trim();
  if (!tidy) return "";
  if (tidy.length > NOTE_MAX_CHARS) return `Keep it to ${NOTE_MAX_CHARS} characters; this is ${tidy.length}.`;
  const key = noteKey(tidy);
  return notes.some((n) => n.id !== selfId && noteKey(n.text) === key) ? "That is already remembered." : "";
}

/** `ok` under 80% of the budget, `near` from there, `full` once an older note has been left out. */
export function budgetMeter(m: MemoryWire): { pct: number; tone: "ok" | "near" | "full"; unused: number } {
  const pct = m.budget > 0 ? Math.min(100, Math.round((100 * m.used) / m.budget)) : 0;
  const unused = m.notes.reduce((n, x) => n + (x.inUse ? 0 : 1), 0);
  return { pct, unused, tone: unused > 0 ? "full" : m.used >= 0.8 * m.budget ? "near" : "ok" };
}
