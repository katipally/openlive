// Voice-to-voice latency instrumentation. It records the real per-turn breakdown
// (mic → VAD → STT → model → TTS → speaker) on actual hardware, never estimates.
// The call's top bar shows its medians and p95 (LatencyChip); the console also
// gets per-turn lines, and `openlivePerf.summary()` prints the table.
//
// Stages, all measured on-device except the model turn:
//   stt+endpoint  transcribe the final utterance and decide the turn is over
//   model         provider time to the first token of the reply
//   tts           synthesize and start playing the first audio
//   voice-to-voice = stt+endpoint + model + tts (deliberate "wait for them to
//                    finish" pauses are excluded, since those are chosen, not latency)

export type Turn = { sttEndpoint: number; model: number; tts: number; total: number };
type Pct = { p50: number; p95: number };
export type PerfStats = { turns: number; sttEndpoint: Pct; model: Pct; tts: Pct; voiceToVoice: Pct };

const turns: Turn[] = [];
let cur: { committedAt: number; sttEndpoint: number; firstTokenAt: number } | null = null;
let stats: PerfStats | null = null;
const listeners = new Set<() => void>();

/** Nearest-rank percentile. O(n log n). */
export function pct(values: number[], p: number): number {
  const a = values.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;
}

/** Medians and p95 per stage; null before the first turn. O(n log n). */
export function perfStats(list: Turn[]): PerfStats | null {
  if (!list.length) return null;
  const col = (k: keyof Turn) => { const v = list.map((t) => t[k]); return { p50: pct(v, 50), p95: pct(v, 95) }; };
  return { turns: list.length, sttEndpoint: col("sttEndpoint"), model: col("model"), tts: col("tts"), voiceToVoice: col("total") };
}

const changed = () => { stats = perfStats(turns); for (const l of listeners) l(); };

export const perf = {
  // Turn committed: the final text is going to the model now. sttEndpointMs is the
  // transcribe + end-of-turn time already measured before this point.
  turnCommitted(sttEndpointMs: number) {
    cur = { committedAt: performance.now(), sttEndpoint: Math.round(sttEndpointMs), firstTokenAt: 0 };
  },
  firstToken() {
    if (cur && !cur.firstTokenAt) cur.firstTokenAt = performance.now();
  },
  firstAudio() {
    if (!cur) return;
    const now = performance.now();
    const model = cur.firstTokenAt ? Math.round(cur.firstTokenAt - cur.committedAt) : 0;
    const tts = Math.round(now - (cur.firstTokenAt || cur.committedAt));
    const t: Turn = { sttEndpoint: cur.sttEndpoint, model, tts, total: cur.sttEndpoint + model + tts };
    turns.push(t);
    console.debug(`[live:perf] turn ${turns.length}: stt+endpoint ${t.sttEndpoint}ms · model ${t.model}ms · tts ${t.tts}ms · voice-to-voice ${t.total}ms`);
    cur = null;
    changed();
  },
  /** The session's stats, the same object until the next turn (useSyncExternalStore). */
  stats: () => stats,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  summary() {
    if (!stats) { console.log("[live:perf] no turns recorded yet"); return null; }
    console.table(stats);
    return stats;
  },
  reset() { turns.length = 0; cur = null; changed(); },
};

if (typeof window !== "undefined") {
  (window as unknown as { openlivePerf?: typeof perf }).openlivePerf = perf;
}
