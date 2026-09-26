// When each word of a spoken caption is heard. No engine the app runs reports
// word or phoneme timing (kokoro-js 1.2.1 and Kokoro's ONNX export return the
// waveform alone, Supertonic's duration predictor one length per utterance,
// sherpa-onnx 1.13.8's TTS samples and a rate), so the words are placed on the
// synthesized audio itself: the pauses the voice makes land on the word
// boundaries most likely to hold them, and between two pauses each word takes
// a share of the voiced time as long as its spoken form (normalizeAligned:
// "$1,200" is as long as "one thousand two hundred dollars"). The user's own
// words take their recognizer's token times (tokenOnsets), or, from one that
// reports none, the same placement on the mic audio (heardOnsets).

import { SILENCE } from "./trim";

// Chinese and Japanese write no spaces: each of their characters is a word
// of its own, with the punctuation after it.
const CAPTION_WORD = /[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}][^\s\p{L}\p{N}]*|(?:(?![\p{scx=Han}\p{scx=Hira}\p{scx=Kana}])\S)+/gu;
const LETTERS = /[\p{L}\p{N}]/gu;
const PAUSE_MARK = /[,.;:!?…、，。！？；：।]["'”’」』)\]]*$/u;

/** [start, end) of each caption word of `text`. O(n). */
export function captionWords(text: string): [number, number][] {
  return [...text.matchAll(CAPTION_WORD)].map((m) => [m.index, m.index + m[0].length]);
}

/** A word the voice says: where it starts in `said`, the caption word it was
 *  read from, how long it is to say (its letters), and whether punctuation,
 *  where a voice pauses, follows it. */
export interface SpokenWord { start: number; unit: number; weight: number; pause: boolean }

/** The words of `said` (normalizeAligned of `caption`, with its `from`). O(n). */
export function spokenWords(caption: string, said: string, from: readonly number[]): SpokenWord[] {
  const units = captionWords(caption);
  let u = 0;
  return captionWords(said).map(([a, b]) => {
    while (u < units.length - 1 && from[a]! >= units[u]![1]) u++;
    const word = said.slice(a, b);
    return { start: a, unit: u, weight: word.match(LETTERS)?.length ?? 0, pause: PAUSE_MARK.test(word) };
  });
}

/** Each word's onset (ms) with the words spread by weight over `ms`. O(n). */
export function paceWords(words: readonly SpokenWord[], ms: number): number[] {
  const total = words.reduce((s, w) => s + w.weight, 0);
  let before = 0;
  return words.map((w, i) => {
    const at = total ? (before / total) * ms : (i / words.length) * ms;
    before += w.weight;
    return at;
  });
}

const FRAME_MS = 10;
// Measured 2026-09-25 on the voice-regress corpus with Kitten, kokoro-js and
// Supertonic against a CTC forced alignment: a frame 35 dB under the loudest
// is silent, and 90 ms of silence is a pause a word boundary may hold.
const QUIET_DB = 35;
const SILENT_DB = 20 * Math.log10(SILENCE); // trimSilence's floor, for audio with no voice at all
const PAUSE_FRAMES = 9;

/**
 * Each word's onset (ms from the first sample) in `samples`, the audio that
 * says exactly `words`. Pauses are matched to word boundaries in order (a
 * pause scores for its length and for punctuation before it, less its
 * distance from where the words' weights put that boundary); between two
 * matched pauses the words share the voiced frames by weight. Silent audio
 * falls back to paceWords over its length.
 * O(F + P·N) for F frames, P pauses and N words.
 */
export function placeWords(words: readonly SpokenWord[], samples: Float32Array, rate: number): number[] {
  const hop = Math.max(1, Math.round((rate * FRAME_MS) / 1000)), F = Math.floor(samples.length / hop);
  const db = new Float64Array(F);
  let peak = -Infinity;
  for (let f = 0; f < F; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += samples[i]! * samples[i]!;
    db[f] = 10 * Math.log10(e / hop + 1e-12);
    peak = Math.max(peak, db[f]!);
  }
  const loud = (f: number) => db[f]! > Math.max(peak - QUIET_DB, SILENT_DB);
  let first = 0, last = F - 1;
  while (first < F && !loud(first)) first++;
  while (last > first && !loud(last)) last--;
  const N = words.length;
  if (first >= F || N < 2) return paceWords(words, (samples.length / rate) * 1000).map((t) => t + (first < F ? first * FRAME_MS : 0));

  // Pauses inside the speech, each with the voiced frames before it.
  const pauses: { s: number; e: number; voiced: number }[] = [];
  const quiet = new Uint8Array(F);
  let voiced = 0;
  for (let f = first; f <= last;) {
    if (loud(f)) { voiced++; f++; continue; }
    let g = f;
    while (!loud(g)) g++;
    if (g - f >= PAUSE_FRAMES) { pauses.push({ s: f, e: g, voiced }); quiet.fill(1, f, g); } else voiced += g - f;
    f = g;
  }
  const weight = words.reduce((s, w) => s + w.weight, 0) || 1;
  const cum = [0];
  for (const w of words) cum.push(cum.at(-1)! + w.weight);
  // A point per 50 ms of pause, three after punctuation, one off per 150 ms
  // from the boundary's place by weight (the same 2026-09-25 corpus).
  const score = (p: (typeof pauses)[number], k: number) =>
    (p.e - p.s) / 5 + (words[k - 1]!.pause ? 3 : 0) - Math.abs(p.voiced - (cum[k]! / weight) * voiced) / 15;

  // dp[i][k]: the best total with the first i pauses and boundaries 1..k.
  const P = pauses.length, dp = new Float64Array((P + 1) * N);
  for (let i = 1; i <= P; i++) for (let k = 1; k < N; k++) {
    const s = score(pauses[i - 1]!, k);
    dp[i * N + k] = Math.max(dp[(i - 1) * N + k]!, dp[i * N + k - 1]!, s > 0 ? dp[(i - 1) * N + k - 1]! + s : -Infinity);
  }
  const held = new Array<number>(N).fill(-1); // boundary k → the pause it holds
  for (let i = P, k = N - 1; i > 0 && k > 0;) {
    if (dp[i * N + k] === dp[(i - 1) * N + k]) i--;
    else if (dp[i * N + k] === dp[i * N + k - 1]) k--;
    else held[k--] = --i;
  }

  // Between held pauses, each word starts where its share of the voiced frames begins.
  const at = new Array<number>(N);
  for (let k0 = 0; k0 < N;) {
    let k1 = k0 + 1;
    while (k1 < N && held[k1]! < 0) k1++;
    const from = k0 ? pauses[held[k0]!]!.e : first, to = k1 < N ? pauses[held[k1]!]!.s : last + 1;
    const frames: number[] = [];
    for (let f = from; f < to; f++) if (!quiet[f]) frames.push(f);
    const segment = cum[k1]! - cum[k0]!;
    for (let k = k0; k < k1; k++) {
      const share = segment ? (cum[k]! - cum[k0]!) / segment : (k - k0) / (k1 - k0);
      at[k] = (k === k0 ? from : frames[Math.floor(share * frames.length)] ?? from) * FRAME_MS;
    }
    k0 = k1;
  }
  return at;
}

/** The onset of each captionWords(caption) word: its first spoken word's. A
 *  caption word nothing was said for (an emoji) shows with the next one. O(n). */
export function captionOnsets(caption: string, words: readonly SpokenWord[], at: readonly number[]): number[] {
  const out = new Array<number>(captionWords(caption).length).fill(NaN);
  words.forEach((w, i) => { if (Number.isNaN(out[w.unit])) out[w.unit] = at[i]!; });
  for (let k = out.length - 1, next = at.at(-1) ?? 0; k >= 0; k--) {
    if (Number.isNaN(out[k])) out[k] = next;
    next = out[k]!;
  }
  return out;
}

/** Each captionWords(text) word's onset (ms): the time of the token its first
 *  character is in, from a recognizer's `tokens` and their start `seconds`
 *  (sherpa-onnx's result), plus `shiftMs`. Tokens and text are matched by
 *  their non-space characters, so it does not matter where either puts spaces
 *  (Chinese and Japanese have none). Undefined when the tokens carry no times.
 *  O(n). */
export function tokenOnsets(text: string, tokens: readonly string[], seconds: readonly number[], shiftMs = 0): number[] | undefined {
  const words = captionWords(text);
  if (!words.length) return [];
  if (seconds.length !== tokens.length) return undefined;
  const starts: number[] = [], at: number[] = []; // each timed token's first non-space character, and its onset
  let chars = 0;
  tokens.forEach((t, i) => {
    const n = t.replace(/\s/g, "").length;
    if (n) { starts.push(chars); at.push(seconds[i]! * 1000 + shiftMs); chars += n; }
  });
  if (!at.length) return undefined;
  let j = 0, seen = 0, pos = 0;
  return words.map(([a]) => {
    seen += text.slice(pos, a).replace(/\s/g, "").length;
    pos = a;
    while (j < starts.length - 1 && starts[j + 1]! <= seen) j++;
    return at[j]!;
  });
}

/** Each captionWords(text) word's onset (ms from the first sample) in
 *  `samples`, the audio that says `text` (`aligned`: its normalizeAligned),
 *  for a recognizer that times no words: placeWords on the speaker's own
 *  pauses. O(F + P·N). */
export function heardOnsets(text: string, { said, from }: { said: string; from: readonly number[] }, samples: Float32Array, rate: number): number[] {
  const words = spokenWords(text, said, from);
  return captionOnsets(text, words, placeWords(words, samples, rate));
}

/** How many caption words have begun `ms` into their chunk, at least the
 *  first; every word when there are no onsets. O(log n): onsets never decrease. */
export function wordsHeard(at: readonly number[], ms: number): number {
  let lo = 1, hi = at.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (at[mid]! <= ms) lo = mid + 1; else hi = mid; }
  return at.length ? lo : Infinity;
}

/** `text` up to its last caption word begun `ms` in: what a voice cut off
 *  there has said. O(n). */
export function heardText(text: string, at: readonly number[], ms: number): string {
  const words = captionWords(text);
  return text.slice(0, words[Math.min(words.length, wordsHeard(at, ms)) - 1]?.[1] ?? text.length);
}
