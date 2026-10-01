// Memory settings, the pure half: finding a note in a long list, checking one
// before it is sent, and how full the prompt budget reads. No React, no DOM,
// so it tests on its own.

import { NOTE_MAX_CHARS, noteCost, noteKey, type MemoryWire, type NoteWire } from "@openlive/shared";

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

export interface BudgetSegment { key: string; weight: number; kind: "used" | "free" | "unused" }

/**
 * The budget bar: a segment per note in use, sized by what it costs, then what
 * is left of the budget, then a segment per note past it. Past `max` of a kind
 * the rest share one segment, so hundreds of notes still draw. O(notes).
 */
export function budgetSegments(m: MemoryWire, max = 40): BudgetSegment[] {
  const of = (kind: "used" | "unused", notes: readonly NoteWire[]): BudgetSegment[] => {
    const own = notes.length > max ? max - 1 : notes.length;
    const segs = notes.slice(0, own).map((n) => ({ key: n.id, weight: noteCost(n.text), kind }));
    const rest = notes.slice(own);
    if (rest.length) segs.push({ key: `${kind}-rest`, weight: rest.reduce((w, n) => w + noteCost(n.text), 0), kind });
    return segs;
  };
  const free = Math.max(0, m.budget - m.used);
  return [
    ...of("used", m.notes.filter((n) => n.inUse)),
    ...(free > 0 ? [{ key: "free", weight: free, kind: "free" as const }] : []),
    ...of("unused", m.notes.filter((n) => !n.inUse)),
  ];
}
