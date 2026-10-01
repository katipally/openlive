// What the agent's /memory routes send and take, and the limits both sides check.
// A note is one fact the `remember` tool, or the user in Settings, kept for every brain.

/** One note's length. The tool's own cap, so a note is a fact and not a paragraph. */
export const NOTE_MAX_CHARS = 240;
/** How many notes are kept. At 240 characters each that is a settings file of about 70 KB, read on every prompt build. */
export const NOTES_MAX = 300;
/**
 * How much of the prompt the notes may take, in characters. The live prompt is
 * about 3,700 characters (900 tokens) before any tool lines, so 2,000 characters
 * (500 tokens) adds at most half again: about 33 notes of the usual 60 characters,
 * or 8 of the longest. It matches the cap on the user's own instructions. The
 * old worst case, 50 notes of 240, was 12,000 characters, three times the prompt.
 */
export const NOTES_BUDGET_CHARS = 2000;

/** A note as the prompt lists it: "- text" and a line break. */
export const noteCost = (text: string): number => text.length + 3;

/** What goes in the store: one line of single spaces, at most NOTE_MAX_CHARS. */
export const cleanNote = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX_CHARS);

/** What two notes are compared by: capitals and spacing do not make a new fact. */
export const noteKey = (text: string): string => cleanNote(text).toLowerCase();

export interface NoteWire {
  id: string;
  text: string;
  /** When it was saved, in ms. Notes saved before this was kept have none. */
  at?: number;
  /** False when it is stored but past the prompt budget, so no brain is told it. */
  inUse: boolean;
}

/** Newest first, the order the budget is spent in. */
export interface MemoryWire {
  notes: NoteWire[];
  /** Characters the notes in use take. */
  used: number;
  budget: number;
  max: number;
}
