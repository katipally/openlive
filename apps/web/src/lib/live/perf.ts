// Voice-to-voice latency instrumentation. It records the real per-turn breakdown
// so the numbers in BENCHMARKS.md come from actual runs on real hardware, never
// from estimates. Open the console during a call to watch per-turn lines, and run
// `openlivePerf.summary()` to print medians and p95 across the session.
//
// Stages, all measured on-device except the model turn:
//   stt+endpoint  transcribe the final utterance and decide the turn is over
//   model         provider time to the first token of the reply
//   tts           synthesize and start playing the first audio
//   voice-to-voice = stt+endpoint + model + tts (deliberate "wait for them to
//                    finish" pauses are excluded, since those are chosen, not latency)

type Turn = { sttEndpoint: number; model: number; tts: number; total: number };

const turns: Turn[] = [];
let cur: { committedAt: number; sttEndpoint: number; firstTokenAt: number } | null = null;

function pct(values: number[], p: number): number {
  const a = values.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;
}

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
  },
  summary() {
    if (!turns.length) { console.log("[live:perf] no turns recorded yet"); return null; }
    const col = (k: keyof Turn) => ({ p50: pct(turns.map((t) => t[k]), 50), p95: pct(turns.map((t) => t[k]), 95) });
    const out = { turns: turns.length, sttEndpoint: col("sttEndpoint"), model: col("model"), tts: col("tts"), voiceToVoice: col("total") };
    console.table(out);
    return out;
  },
  reset() { turns.length = 0; cur = null; },
};

if (typeof window !== "undefined") {
  (window as unknown as { openlivePerf?: typeof perf }).openlivePerf = perf;
}
