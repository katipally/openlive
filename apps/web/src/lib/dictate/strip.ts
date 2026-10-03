import type { DictateSnapshot } from "@/lib/flow/types";

// What Dictate's strip under the orb says, decided apart from drawing it.

/** Processing is often over in a few hundred ms: the strip shows it at least
 *  this long so it reads as work, not a flicker. The words are typed meanwhile;
 *  only the strip waits. */
export const PROCESSING_MIN_MS = 500;

/** How much longer the strip keeps showing processing before `next`, which
 *  came `elapsed` ms after processing began. A hold that ends in a note with
 *  nothing typed ("No words heard.") did no work worth showing, so its note
 *  comes at once rather than after the label of work that never happened. */
export function processingHold(next: DictateSnapshot, elapsed: number): number {
  if (next.phase === "processing") return 0;
  if (next.note && next.inserted === 0) return 0;
  return Math.max(0, PROCESSING_MIN_MS - elapsed);
}

/** The strip's words. "Editing" only once there are words to edit with: until
 *  then the hold is still being written down, and it may hold none. */
export function stripWords(d: DictateSnapshot, waiting: string, warming: boolean): string {
  const working = d.phase === "processing";
  const landed = !working && !d.note && d.inserted > 0;
  const label = working && (d.polishing ? "Polishing" : !d.partial ? "Cleaning up" : d.editing && "Editing");
  return d.note || label || (landed ? `${d.inserted} ${d.inserted === 1 ? "word" : "words"}` : d.partial || (!d.ready || warming ? "Getting ready" : d.phase === "idle" && waiting ? waiting : "Listening"));
}
