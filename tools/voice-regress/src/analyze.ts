// Frame-level analysis of rendered speech, and the comparison of a reply
// rendered chunk by chunk (as the app speaks it) against the same reply
// rendered in one go. Pure, so the analyzer itself is unit-tested.
import { SILENCE } from "../../../packages/shared/src/speech/trim";

const FRAME_S = 0.04, HOP_S = 0.01; // 40 ms window, 10 ms hop: 100 frames per second
const WIN_FRAMES = Math.round(FRAME_S / HOP_S);
const F0_MIN = 60, F0_MAX = 400;
// Autocorrelation peak over its zero-lag value: above this a frame is voiced.
const VOICED_ACF = 0.45;
// Frame level relative to the loudest 5% of frames, below which a frame is
// silence (0.05 = -26 dB) or too quiet to trust its pitch (0.1 = -20 dB).
const ACTIVE_REL = 0.05, VOICED_REL = 0.1;
const EDGE_FRAMES = 50;  // the 0.5 s of speech either side of a join
const HEAD_FRAMES = 60;  // a chunk's first 0.6 s of speech
const SNAP_FRAMES = 60;  // a one-go boundary is searched +-0.6 s around its estimate

export interface Track { rms: Float64Array; f0: Float64Array; active: Uint8Array }

/** In-place radix-2 FFT, `re.length` a power of two. O(n log n). */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti; re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = next;
      }
    }
  }
}

export const percentile = (xs: ArrayLike<number>, p: number) => {
  const s = Float64Array.from(xs).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};
/** Median of the finite values; NaN when there are none. */
export function median(xs: Iterable<number>): number {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
}
export const semitones = (a: number, b: number) => 12 * Math.log2(a / b);
export const db = (power: number) => 10 * Math.log10(power + 1e-18);

/** Per 10 ms frame: RMS, F0 in Hz (NaN when unvoiced) and speech activity.
 *  F0 is the autocorrelation peak between 60 and 400 Hz, the autocorrelation
 *  taken from the frame's power spectrum band-limited to 50-1000 Hz (the
 *  bandpass and the autocorrelation in one FFT pair), refined by a parabola
 *  through the peak. O(frames x N log N), N the FFT size (2048 at 24 kHz). */
export function track(x: Float32Array, sr: number): Track {
  const win = Math.round(FRAME_S * sr), hop = Math.round(HOP_S * sr);
  const frames = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  let n = 1;
  while (n < 2 * win) n <<= 1;
  const hann = Float64Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1)));
  const lo = Math.floor(sr / F0_MAX), hi = Math.ceil(sr / F0_MIN);
  const binLo = Math.floor((50 * n) / sr), binHi = Math.ceil((1000 * n) / sr);
  const rms = new Float64Array(frames), f0 = new Float64Array(frames).fill(NaN), acf0 = new Float64Array(frames);
  const re = new Float64Array(n), im = new Float64Array(n), peak = new Float64Array(frames), lag = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    re.fill(0); im.fill(0);
    let sum = 0;
    for (let i = 0; i < win; i++) { const v = x[f * hop + i]!; sum += v * v; re[i] = v * hann[i]!; }
    rms[f] = Math.sqrt(sum / win);
    fft(re, im);
    for (let k = 0; k < n; k++) {
      const bin = Math.min(k, n - k);
      re[k] = bin >= binLo && bin <= binHi ? re[k]! ** 2 + im[k]! ** 2 : 0;
      im[k] = 0;
    }
    fft(re, im); // the power spectrum is real and even, so a forward FFT is its inverse up to 1/n
    acf0[f] = re[0]!;
    let k = lo;
    for (let j = lo + 1; j <= hi; j++) if (re[j]! > re[k]!) k = j;
    const a = re[k - 1]!, b = re[k]!, c = re[k + 1]!;
    const d = a - 2 * b + c;
    peak[f] = b;
    lag[f] = d < 0 ? k + (0.5 * (a - c)) / d : k;
  }
  const loud = percentile(rms, 0.95);
  const active = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    active[f] = rms[f]! > ACTIVE_REL * loud ? 1 : 0;
    if (acf0[f]! > 0 && peak[f]! > VOICED_ACF * acf0[f]! && rms[f]! > VOICED_REL * loud) f0[f] = sr / lag[f]!;
  }
  return { rms, f0, active };
}

/** The first and last+1 active frame in [a, b); [a, a) when none is. */
export function speech(t: Track, a: number, b: number): [number, number] {
  let s = Math.max(0, a), e = Math.min(t.active.length, b);
  while (s < e && !t.active[s]) s++;
  while (e > s && !t.active[e - 1]) e--;
  return s < e ? [s, e] : [a, a];
}

/** Median F0 and mean power (dB) of the EDGE_FRAMES active frames just before
 *  (or from) frame `at`. */
export function edge(t: Track, at: number, before: boolean): { f0: number; db: number } {
  const idx: number[] = [];
  if (before) for (let f = at - 1; f >= 0 && idx.length < EDGE_FRAMES; f--) { if (t.active[f]) idx.push(f); }
  else for (let f = at; f < t.active.length && idx.length < EDGE_FRAMES; f++) { if (t.active[f]) idx.push(f); }
  return { f0: median(idx.map((f) => t.f0[f]!)), db: db(idx.reduce((s, f) => s + t.rms[f]! ** 2, 0) / Math.max(1, idx.length)) };
}

/** Seconds of the silent run that frame `at` sits in (0 inside speech). */
export function pauseAt(t: Track, at: number): number {
  let a = at, b = at;
  while (a > 0 && !t.active[a - 1]) a--;
  while (b < t.active.length && !t.active[b]) b++;
  return (b - a) * HOP_S;
}

/** Where a boundary estimated at frame `at` really is: the middle of the
 *  longest silent run within +-SNAP_FRAMES, or the quietest frame when there
 *  is no run of 3 frames. O(SNAP_FRAMES). */
export function snap(t: Track, at: number): number {
  const lo = Math.max(1, at - SNAP_FRAMES), hi = Math.min(t.active.length - 1, at + SNAP_FRAMES);
  let best = 0, bestAt = at, run = 0, quiet = at;
  for (let f = lo; f < hi; f++) {
    run = t.active[f] ? 0 : run + 1;
    if (run > best) { best = run; bestAt = f - Math.floor(run / 2); }
    if (t.rms[f]! < t.rms[quiet]!) quiet = f;
  }
  return best >= 3 ? bestAt : quiet;
}

/** Seconds before the first and after the last sample above the app's
 *  -50 dBFS silence floor (pcm.ts). O(n). */
export function leadTail(x: Float32Array, sr: number): { lead: number; tail: number } {
  let a = 0, b = x.length;
  while (a < b && !(Math.abs(x[a]!) >= SILENCE)) a++;
  while (b > a && !(Math.abs(x[b - 1]!) >= SILENCE)) b--;
  return { lead: a / sr, tail: (x.length - b) / sr };
}

export interface Join { f0Step: number; refF0Step: number; pause: number; refPause: number; loudStep: number; refLoudStep: number }
export interface ReplyMetrics {
  joins: Join[];
  /** Per chunk: |semitones| between its first 0.6 s of speech and the same words in the one-go render. */
  headDev: number[];
  lead: number; tail: number; durationRatio: number;
  nan: number; clipped: number; emptyChunks: number;
}

/** A reply rendered as `chunks` played back to back, against its one-go
 *  render `ref`. A join's place in the one-go render is estimated from the
 *  share of speech before it, then snapped to the pause there. O(frames). */
export function compareReply(chunks: Float32Array[], ref: Float32Array, sr: number): ReplyMetrics {
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  // Tracked with a window of silence between chunks: a frame that spans a join
  // would let a chunk speaking from its first sample mark the previous chunk's
  // last frames active and hide the pause before it. The window is taken back
  // off each pause below.
  const gap = WIN_FRAMES * Math.round(HOP_S * sr);
  const spaced = new Float32Array(all.length + gap * Math.max(0, chunks.length - 1));
  const starts: number[] = [];
  let off = 0, nan = 0, clipped = 0, emptyChunks = 0;
  for (const [i, c] of chunks.entries()) {
    starts.push(Math.round((off + i * gap) / (HOP_S * sr)));
    for (const v of c) { if (Number.isNaN(v)) nan++; else if (Math.abs(v) > 1) clipped++; }
    if (leadTail(c, sr).lead * sr >= c.length) emptyChunks++;
    all.set(c, off); spaced.set(c, off + i * gap); off += c.length;
  }
  const t = track(spaced, sr), r = track(ref, sr);
  starts.push(t.active.length + WIN_FRAMES - 1);
  // A chunk's frames stop short of any window that reaches into the next one.
  const spans = chunks.map((_, i) => speech(t, starts[i]!, starts[i + 1]! - WIN_FRAMES + 1));
  const voiced = spans.map(([s, e]) => e - s), total = voiced.reduce((a, b) => a + b, 0) || 1;
  const [rs, re] = speech(r, 0, r.active.length);
  const bounds = [rs];
  let cum = 0;
  for (let i = 1; i < spans.length; i++) { cum += voiced[i - 1]!; bounds.push(snap(r, Math.round(rs + (cum / total) * (re - rs)))); }
  const joins: Join[] = [], headDev: number[] = [];
  for (let i = 0; i < spans.length; i++) {
    const [s] = spans[i]!, rb = bounds[i]!, rStart = speech(r, rb, re)[0];
    headDev.push(Math.abs(semitones(median(t.f0.subarray(s, s + HEAD_FRAMES)), median(r.f0.subarray(rStart, rStart + HEAD_FRAMES)))));
    if (!i) continue;
    const prevEnd = spans[i - 1]![1];
    const [pb, pa, qb, qa] = [edge(t, prevEnd, true), edge(t, s, false), edge(r, rb, true), edge(r, rb, false)];
    joins.push({
      f0Step: semitones(pa.f0, pb.f0), refF0Step: semitones(qa.f0, qb.f0),
      pause: Math.max(0, (s - prevEnd - WIN_FRAMES) * HOP_S), refPause: pauseAt(r, rb),
      loudStep: pa.db - pb.db, refLoudStep: qa.db - qb.db,
    });
  }
  const { lead, tail } = leadTail(all, sr);
  return { joins, headDev, lead, tail, durationRatio: all.length / Math.max(1, ref.length), nan, clipped, emptyChunks };
}
