// The bake-off's text-side scores: word error rate against what was meant to
// be said, and which AudioSet classes stand for each paralinguistic tag.
import { toSpeech } from "../../../apps/web/src/lib/live/voiceText";

/** Lowercase words, numbers spelled out as the app speaks them (P7), so "72"
 *  from the recognizer and "seventy two" in the text are the same words. */
export const words = (text: string): string[] =>
  toSpeech(text, "en").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/'(?!\p{L})|(?<!\p{L})'/gu, "").split(/\s+/).filter(Boolean);

/** Word-level Levenshtein distance over the reference's length. O(n x m) time, O(m) space. */
export function wer(ref: string, hyp: string): number {
  const r = words(ref), h = words(hyp);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[h.length]! / r.length;
}

/** The AudioSet (CED) classes whose probability says a tag was performed. */
export const TAG_CLASSES: Record<string, string[]> = {
  laugh: ["Laughter", "Giggle", "Chuckle, chortle", "Belly laugh", "Snicker"],
  chuckle: ["Laughter", "Giggle", "Chuckle, chortle", "Snicker"],
  sigh: ["Sigh", "Breathing"],
  gasp: ["Gasp", "Breathing"],
  cough: ["Cough", "Throat clearing"],
};

/** The best probability among `tag`'s classes in a tagger's output. O(events). */
export const tagProb = (tag: string, events: { name: string; prob: number }[]) =>
  Math.max(0, ...events.filter((e) => TAG_CLASSES[tag]?.includes(e.name)).map((e) => e.prob));
