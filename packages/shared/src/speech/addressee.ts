// Side talk: was a finished sentence said to the app, or to someone else in
// the room (or to no one)? Shared by the agent (the live check), and
// tools/addressee (the eval its head and threshold come from). A sentence
// embedding (the agent's "addressee" engine) goes through a logistic head
// fitted on tools/addressee's training split; a few context rules come first.
// Asymmetric by design: anything a rule or the score is unsure of is said to the app.
import { HEAD } from "./addressee-head";

/** What the check knows besides the words. `reply`: the agent's last reply as
 *  voiced; `speaker`: the voiceprint's label ("you", "other N"), when it is on. */
export interface Scene { reply: string; speaker?: string }

// Another voice than the user's (voiceprint label mode) is taken to talk to
// someone else this much more readily, in log-odds: e^1, about 2.7 times. Not
// fitted (too few other voices address the app in the synthetic set): at 2 it
// ignored two of the three there, at 1 one, as at 0.5 (tools/addressee, 2026-09-26).
export const OTHER_SHIFT = 1;
// The app's own name, said anywhere in the sentence.
const NAMED = /open\s?live/i;

/** The agent's reply ended on a question: the next sentence is its answer. */
export const askedBack = (reply: string) => /[?？]["'”’)\]]*$/.test(reply.trim());

/** How a sentence sounded and when it came, beside its words. Each is null
 *  when it cannot be known (no reply yet, voiceprint off, too little voice).
 *  `relDb`: loudness against the user's running speech level; `energySd`: the
 *  spread of frame loudness, dB; `pitch`, `pitchSd`: median and spread of the
 *  voiced pitch, semitones over 100 Hz; `gapS`: seconds since the agent's voice
 *  stopped (0 over it); `cut`: the sentence cut or paused the reply; `change`:
 *  another voiceprint label than the sentence before; `durS`: the segment's
 *  length; `rate`: words per second of speech. */
export interface Feats {
  relDb: number | null; energySd: number | null; pitch: number | null; pitchSd: number | null;
  gapS: number | null; cut: number; change: number | null; durS: number; rate: number | null;
}
export const FEATURES = ["relDb", "energySd", "pitch", "pitchSd", "gapS", "cut", "change", "durS", "rate"] as const;

/** `f` as the head reads it: gaps and lengths on a log scale, where a second
 *  more matters less the longer it already is. O(1). */
export const featureVector = (f: Feats): (number | null)[] => FEATURES.map((k) =>
  f[k] == null ? null : k === "gapS" ? Math.log1p(Math.min(f[k]!, 60)) : k === "durS" ? Math.log(Math.max(f[k]!, 0.1)) : f[k]);

// Frames of 40 ms every 20 ms at 8 kHz; pitch searched over 50-400 Hz. Only the
// last 8 s are read, bounding the page's main thread at about 18M multiply-adds.
const SR = 8000, WIN = 320, HOP = 160, MIN_LAG = 20, MAX_LAG = 160, MAX_S = 8;
// Frames within this much of the loudest are speech; quieter is the room.
const SPEECH_DB = 30;

/** The audio half of Feats, from 16 kHz mono `pcm` and its transcript: level
 *  (dB full scale, for relDb), `energySd`, `pitch`, `pitchSd` and `rate`.
 *  O(n x L) over n samples (capped at 8 s) and L = 140 pitch lags, by
 *  autocorrelation of 2x-decimated frames; words counted by Intl.Segmenter,
 *  so languages written without spaces count too. */
export function speechStats(pcm: Float32Array, text: string) {
  const from = Math.max(0, pcm.length - MAX_S * 16000);
  const x = new Float32Array((pcm.length - from) >> 1);
  for (let i = 0; i < x.length; i++) x[i] = (pcm[from + 2 * i]! + pcm[from + 2 * i + 1]!) / 2;
  const frames: { db: number; at: number }[] = [];
  for (let at = 0; at + WIN <= x.length; at += HOP) {
    let e = 0;
    for (let i = at; i < at + WIN; i++) e += x[i]! * x[i]!;
    frames.push({ db: 10 * Math.log10(e / WIN + 1e-12), at });
  }
  const top = Math.max(-70, ...frames.map((f) => f.db));
  const speech = frames.filter((f) => f.db > top - SPEECH_DB);
  const pitches: number[] = [];
  for (const { at } of speech) {
    let e0 = 0;
    for (let i = at; i < at + WIN; i++) e0 += x[i]! * x[i]!;
    let best = 0, lag = 0;
    for (let l = MIN_LAG; l <= MAX_LAG; l++) {
      let r = 0;
      for (let i = at; i + l < at + WIN; i++) r += x[i]! * x[i + l]!;
      if (r / (e0 || 1) > best) { best = r / (e0 || 1); lag = l; }
    }
    // A clear period only: noise and unvoiced consonants correlate far less.
    if (best > 0.5) pitches.push(12 * Math.log2(SR / lag / 100));
  }
  const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)].filter((w) => w.isWordLike).length;
  const power = speech.reduce((s, f) => s + 10 ** (f.db / 10), 0) / (speech.length || 1);
  return {
    db: speech.length ? 10 * Math.log10(power) : null,
    energySd: speech.length > 4 ? sd(speech.map((f) => f.db)) : null,
    pitch: pitches.length > 4 ? median(pitches) : null,
    pitchSd: pitches.length > 4 ? sd(pitches) : null,
    rate: speech.length > 4 ? words / ((speech.length * HOP) / SR) : null,
  };
}
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]!; };
const sd = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };

/** A head fitted on the user's own log (tools/addressee train.ts) also reads
 *  Feats: `mean` and `sd` standardize each, and a missing one adds nothing. */
export interface Head { w: number[]; b: number; threshold: number; feats?: { mean: number[]; sd: number[]; w: number[] } }

/** The head's log-odds that `e` (a unit sentence embedding) is side talk. O(d). */
export function sideScore(e: ArrayLike<number>, head: Pick<Head, "w" | "b" | "feats"> = HEAD, f?: Feats): number {
  let z = head.b;
  for (let i = 0; i < head.w.length; i++) z += head.w[i]! * e[i]!;
  if (head.feats && f) featureVector(f).forEach((v, i) => { if (v != null) z += (head.feats!.w[i]! * (v - head.feats!.mean[i]!)) / head.feats!.sd[i]!; });
  return z;
}

/** Side talk, to be dropped: only past the head's threshold, never after the
 *  agent asked the user something, and never when the app is named. */
export function isSideTalk(text: string, score: number, s: Scene, threshold = HEAD.threshold): boolean {
  const other = !!s.speaker && s.speaker !== "you";
  if (NAMED.test(text) || (!other && askedBack(s.reply))) return false;
  return score > (other ? threshold - OTHER_SHIFT : threshold);
}
