// Pure measures over one eval run's timeline (ms, one clock).

export type Span = [number, number];

/** Nearest-rank percentile, as perf.ts. O(n log n). */
export function pct(values: number[], p: number): number {
  const a = values.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? NaN;
}

/** How long `a` sounds over any of `b`. Both sorted by start and each
 *  non-overlapping within itself: one merge pass, O(|a| + |b|). */
export function overlapMs(a: Span[], b: Span[]): number {
  let ms = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    ms += Math.max(0, Math.min(a[i]![1], b[j]![1]) - Math.max(a[i]![0], b[j]![0]));
    if (a[i]![1] < b[j]![1]) i++; else j++;
  }
  return ms;
}

/** The voiced spans of 16 kHz `pcm` starting at `t0`: 32 ms frames over
 *  `floor` RMS, joined across gaps under `bridgeMs` (a word's own stops). O(n). */
export function voicedSpans(pcm: Float32Array, t0: number, floor = 0.01, bridgeMs = 150): Span[] {
  const out: Span[] = [];
  for (let at = 0; at + 512 <= pcm.length; at += 512) {
    let s = 0;
    for (let k = at; k < at + 512; k++) s += pcm[k]! * pcm[k]!;
    if (Math.sqrt(s / 512) < floor) continue;
    const a = t0 + at / 16, b = a + 32, last = out.at(-1);
    if (last && a - last[1] <= bridgeMs) last[1] = b; else out.push([a, b]);
  }
  return out;
}
