// The regression's corpus chunking and its per-engine summary, shared by
// run.ts and bakeoff.ts.
import { stripMarkdown, toSpeech, SentenceChunker } from "../../../apps/web/src/lib/live/voiceText";
import type { ReplyMetrics } from "./analyze";

// Means over the corpus, each against the one-go render. `max` is the
// absolute threshold, for the mean and, for the four join metrics, for each
// join: a join past any of them is rough. `drift` is how far past its
// baseline a metric may move (times the engine's slack). Calibrated
// 2026-09-25 on Kitten nano over 7 and 5 runs: the current chunker gave 1-2
// rough joins of 29, pauses 9-12 ms and start pitch 0.16-0.30 st off one-go;
// the old comma-cut first chunk 5-6 of 30, 38-43 ms and 0.50-0.62 st.
export const METRICS = {
  f0JumpSt: { max: 1.5, drift: 0.6, what: "pitch step at a join vs one-go (semitones)" },
  pauseMs: { max: 150, drift: 12, what: "pause at a join vs one-go (ms)" },
  loudJumpDb: { max: 3, drift: 0.5, what: "loudness step at a join vs one-go (dB)" },
  startPitchSt: { max: 1.5, drift: 0.15, what: "a chunk's first 0.6 s pitch vs the same words one-go (semitones)" },
  roughJoins: { max: 0.1, drift: 0.05, what: "share of joins past any join threshold" },
  leadMs: { max: 250, drift: 40, what: "silence before the reply's first word (ms)" },
  tailMs: { max: 600, drift: 100, what: "silence after the reply's last word (ms)" },
  durationDev: { max: 0.15, drift: 0.03, what: "|reply length / one-go length - 1|" },
  broken: { max: 0, drift: 0, what: "NaN or clipped samples, or silent chunks" },
} as const;
export type Summary = Record<keyof typeof METRICS, number> & { replies: number; joins: number };

/** LLM-like deltas of 1-3 words (the space leading the word), from a fixed seed. */
function deltas(text: string, seed: number): string[] {
  const words = text.match(/\s*\S+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < words.length;) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (seed % 3);
    out.push(words.slice(i, i + n).join(""));
    i += n;
  }
  return out;
}

/** The reply's spoken chunks, as voiceEngine.ts feeds the chunker and enqueueSpeak cleans each one,
 *  with the voice well ahead (synthesis far faster than speech, the usual case): after the
 *  opening, sentences go only as they fill a chunk, and the rest at the reply's end. */
export function chunks(reply: string, seed: number, Chunker: typeof SentenceChunker = SentenceChunker): string[] {
  const c = new Chunker();
  const out = deltas(reply, seed).flatMap((d) => c.push(d, "en"));
  out.push(c.flush());
  return out.map((s) => stripMarkdown(s)).filter(Boolean).map((s) => toSpeech(s, "en"));
}

const mean = (xs: number[]) => { const f = xs.filter(Number.isFinite); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0; };
export const round = (x: number) => Number(x.toFixed(3));

export function summarize(ms: ReplyMetrics[]): Summary {
  const joins = ms.flatMap((m) => m.joins);
  const rough = ms.reduce((n, m) => n + m.joins.filter((j, i) => Math.abs(j.f0Step - j.refF0Step) > METRICS.f0JumpSt.max
    || Math.abs(j.pause - j.refPause) * 1000 > METRICS.pauseMs.max || Math.abs(j.loudStep - j.refLoudStep) > METRICS.loudJumpDb.max
    || m.headDev[i + 1]! > METRICS.startPitchSt.max).length, 0);
  return {
    replies: ms.length, joins: joins.length, roughJoins: round(rough / Math.max(1, joins.length)),
    f0JumpSt: round(mean(joins.map((j) => Math.abs(j.f0Step - j.refF0Step)))),
    pauseMs: round(mean(joins.map((j) => Math.abs(j.pause - j.refPause))) * 1000),
    loudJumpDb: round(mean(joins.map((j) => Math.abs(j.loudStep - j.refLoudStep)))),
    startPitchSt: round(mean(ms.flatMap((m) => m.headDev))),
    leadMs: round(mean(ms.map((m) => m.lead)) * 1000),
    tailMs: round(mean(ms.map((m) => m.tail)) * 1000),
    durationDev: round(mean(ms.map((m) => Math.abs(m.durationRatio - 1)))),
    broken: ms.reduce((n, m) => n + m.nan + m.clipped + m.emptyChunks, 0),
  };
}
