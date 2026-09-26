// Silence trimming for the voice engines' renders, shared by the browser
// worker (apps/web/src/lib/live/models.worker.ts) and the agent
// (services/agent/src/voice/native-worker.ts), so a voice cuts the same on
// either. Pure, so it is unit-tested.

export const SILENCE = 10 ** (-50 / 20);

// Seconds of silence a render keeps before and after its speech. Each render
// comes with its own (measured 2026-09-24, -50 dBFS floor: Supertonic M4 ~0.4 s
// and ~0.5 s, Kokoro af_heart 0.28-0.39 s and 0.39-0.54 s), so sentences played
// back to back sat 0.8-1.1 s apart and each started over like a new utterance.
// A short lead-in keeps soft onsets; the tail leaves the pause the model makes
// between sentences inside one render (Supertonic mean 0.38 s, Kokoro 0.51 s).
export const KEEP_S = { supertonic: [0.05, 0.35], kokoro: [0.05, 0.45] } as const;

/** `wav` cut to its speech, the first to the last sample above -50 dBFS, keeping
 *  up to `leadS` seconds before it and `tailS` after. Empty when it is all
 *  silence. O(n). */
export function trimSilence(wav: Float32Array, sampleRate: number, leadS: number, tailS: number): Float32Array {
  let first = 0, last = wav.length - 1;
  while (first <= last && Math.abs(wav[first]!) < SILENCE) first++;
  while (last > first && Math.abs(wav[last]!) < SILENCE) last--;
  if (first > last) return new Float32Array(0);
  return wav.slice(Math.max(0, first - Math.round(leadS * sampleRate)), Math.min(wav.length, last + 1 + Math.round(tailS * sampleRate)));
}
