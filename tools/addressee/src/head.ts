// The side talk head: logistic regression on unit sentence embeddings, and the
// numbers it is judged by. Label 1 is side talk.

export interface Head { w: number[]; b: number }

const dot = (h: Head, x: ArrayLike<number>) => { let z = h.b; for (let i = 0; i < h.w.length; i++) z += h.w[i]! * x[i]!; return z; };

/** Full-batch gradient descent with an L2 penalty on the weights; row n counts
 *  `wt[n]` times (1 each by default). O(epochs x n x d). */
export function fit(x: ArrayLike<number>[], y: number[], wt?: number[], lambda = 1e-3, epochs = 1500, rate = 1): Head {
  const d = x[0]!.length, h: Head = { w: new Array<number>(d).fill(0), b: 0 };
  const total = wt ? wt.reduce((a, b) => a + b, 0) : x.length;
  for (let ep = 0; ep < epochs; ep++) {
    const g = new Float64Array(d);
    let gb = 0;
    x.forEach((xi, n) => {
      const err = (1 / (1 + Math.exp(-dot(h, xi))) - y[n]!) * (wt?.[n] ?? 1);
      for (let i = 0; i < d; i++) g[i]! += err * xi[i]!;
      gb += err;
    });
    for (let i = 0; i < d; i++) h.w[i]! -= rate * (g[i]! / total + lambda * h.w[i]!);
    h.b -= (rate * gb) / total;
  }
  return h;
}

/** Each row scored (log-odds) by a head fitted without its fold: `fold[i]`, by
 *  default rows dealt to `k` folds in turn. A row in fold -1 is only ever
 *  trained on, and scored NaN. O(k x fit). */
export function outOfFold(x: ArrayLike<number>[], y: number[], k = 5, fold = x.map((_, i) => i % k), wt?: number[]): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  for (let f = 0; f < k; f++) {
    const keep = fold.map((g) => g !== f);
    const h = fit(x.filter((_, i) => keep[i]), y.filter((_, i) => keep[i]), wt?.filter((_, i) => keep[i]));
    x.forEach((xi, i) => { if (!keep[i]) out[i] = dot(h, xi); });
  }
  return out;
}

/** The threshold that ignores (scores strictly above it) at most `rate` of the
 *  addressed sentences' `scores`. O(n log n). */
export function thresholdAt(scores: number[], rate: number): number {
  const s = [...scores].sort((a, b) => b - a);
  return s[Math.min(s.length - 1, Math.floor(rate * s.length))] ?? 0;
}

/** Side talk judged by `ignored` against the truth: the share of addressed
 *  sentences ignored, of side talk caught, and the precision of an ignore. O(n). */
export function rates(side: boolean[], ignored: boolean[]) {
  let fi = 0, caught = 0, nSide = 0;
  side.forEach((s, i) => { if (s) { nSide++; if (ignored[i]) caught++; } else if (ignored[i]) fi++; });
  const nTo = side.length - nSide;
  return { falseIgnore: fi / (nTo || 1), caught: caught / (nSide || 1), precision: caught / (caught + fi || 1), fi, nTo, hits: caught, nSide };
}

/** The chance a side talk sentence outscores an addressed one. O(n x m). */
export function auc(side: number[], to: number[]): number {
  let c = 0;
  for (const p of side) for (const n of to) c += p > n ? 1 : p === n ? 0.5 : 0;
  return c / (side.length * to.length || 1);
}

export const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN; };
