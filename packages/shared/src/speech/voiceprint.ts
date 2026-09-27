// Speaker verification math, shared by the agent (enrollment and the gate),
// the web (speaker labels) and tools/voiceprint (the eval its numbers come from).
// Embeddings are compared by cosine similarity; a print is the mean of unit
// embeddings, kept per microphone so a new mic adds a print instead of pulling
// the old one toward it.

/** O(d). 0 for a zero vector. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i]! * b[i]!; aa += a[i]! * a[i]!; bb += b[i]! * b[i]!; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** Whether `e` points anywhere: a zero, NaN or infinite embedding says nothing
 *  about the voice, and cosine() would score it 0. O(d). */
export function informative(e: ArrayLike<number>): boolean {
  let n = 0;
  for (let i = 0; i < e.length; i++) n += e[i]! * e[i]!;
  return n > 0 && Number.isFinite(n);
}

/** `mean`: the running mean of `n` unit embeddings from `seconds` of speech
 *  heard on `mic`; `at`: when it last took one (ms since epoch). */
export interface Print { mic: string; mean: number[]; n: number; seconds: number; at: number }

/** `e` folded into `p`'s mean as one more unit vector. O(d). */
export function fold(p: Pick<Print, "mean" | "n">, e: ArrayLike<number>): number[] {
  let norm = 0;
  for (let i = 0; i < e.length; i++) norm += e[i]! * e[i]!;
  norm = Math.sqrt(norm) || 1;
  return p.mean.length ? p.mean.map((m, i) => m + (e[i]! / norm - m) / (p.n + 1)) : Array.from(e, (x) => x / norm);
}

/** The best match among `prints` (0 when there are none), negative when even
 *  that points away: the under-a-second threshold sits below 0. O(prints x d). */
export const bestScore = (prints: Print[], e: ArrayLike<number>) => prints.length ? Math.max(...prints.map((p) => cosine(p.mean, e))) : 0;

/** Groups the voices that are not the enrolled user, in the order first heard:
 *  a segment joins the closest group over `threshold`, else starts the next one.
 *  O(groups x d) per segment. */
export class OtherVoices {
  private groups: Array<Pick<Print, "mean" | "n">> = [];
  constructor(private threshold: number) {}
  /** 1-based: "other 1", "other 2", ... */
  label(e: ArrayLike<number>): number {
    let best = -1, score = this.threshold;
    this.groups.forEach((g, i) => { const s = cosine(g.mean, e); if (s >= score) { score = s; best = i; } });
    if (best < 0) { this.groups.push({ mean: fold({ mean: [], n: 0 }, e), n: 1 }); return this.groups.length; }
    const g = this.groups[best]!;
    g.mean = fold(g, e);
    g.n++;
    return best + 1;
  }
}
