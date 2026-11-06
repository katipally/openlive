export type HoldCue = "start" | "stop";

const CUES: Record<HoldCue, { hz: number; ms: number }> = { start: { hz: 880, ms: 80 }, stop: { hz: 587, ms: 60 } };
/** Soft enough to sit under a voice, and the window keeps its edges from clicking. */
export const CUE_GAIN = 0.1;

/** A short sine blip with a raised-cosine envelope, mono at `rate`. */
export function cueTone(cue: HoldCue, rate: number): Float32Array {
  const { hz, ms } = CUES[cue];
  const n = Math.max(1, Math.round((rate * ms) / 1000));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = CUE_GAIN * Math.sin(Math.PI * (i / n)) ** 2 * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}
