// Verification error rates over cosine scores: target trials (the enrolled
// user) against impostor trials (anyone else, the agent's voices included).

/** Share of the user's trials blocked at threshold `t`. O(n). */
export const frr = (tar: number[], t: number) => tar.filter((s) => s < t).length / (tar.length || 1);
/** Share of other voices let through at threshold `t`. O(n). */
export const far = (imp: number[], t: number) => imp.filter((s) => s >= t).length / (imp.length || 1);

/** The equal error rate and the threshold it falls at: a sweep over the sorted
 *  scores. O((n + m) log(n + m)). */
export function eer(tar: number[], imp: number[]): { eer: number; threshold: number } {
  const all = [...tar.map((s) => [s, 1] as const), ...imp.map((s) => [s, 0] as const)].sort((a, b) => a[0] - b[0]);
  let below = 0, impBelow = 0, best = { eer: 1, threshold: 0, gap: Infinity };
  for (let i = 0; i <= all.length; i++) {
    // Threshold just above everything counted so far: those are rejected.
    const fr = below / (tar.length || 1), fa = 1 - impBelow / (imp.length || 1);
    if (Math.abs(fr - fa) < best.gap) best = { eer: (fr + fa) / 2, threshold: i < all.length ? all[i]![0] : 1, gap: Math.abs(fr - fa) };
    if (i < all.length) { if (all[i]![1]) below++; else impBelow++; }
  }
  return { eer: best.eer, threshold: best.threshold };
}

/** The highest threshold that blocks at most `rate` of the user's trials. O(n log n). */
export function thresholdAtFrr(tar: number[], rate: number): number {
  const s = [...tar].sort((a, b) => a - b);
  return s[Math.floor(rate * s.length)] ?? 0;
}

/** The p-th quantile (0..1) of `xs`. O(n log n). */
export const quantile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
