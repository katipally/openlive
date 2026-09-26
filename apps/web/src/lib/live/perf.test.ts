import { describe, expect, it } from "vitest";
import { perf, perfStats, pct } from "./perf";

describe("perf aggregation", () => {
  it("takes nearest-rank percentiles, whatever the order", () => {
    const v = [900, 100, 500, 300, 700, 200, 800, 400, 600, 1000];
    expect(pct(v, 50)).toBe(600);
    expect(pct(v, 95)).toBe(1000);
    expect(pct([42], 95)).toBe(42);
    expect(pct([], 50)).toBe(0);
  });

  it("summarizes every stage, and nothing before the first turn", () => {
    expect(perfStats([])).toBeNull();
    const turn = (s: number, m: number, t: number) => ({ sttEndpoint: s, model: m, tts: t, total: s + m + t });
    expect(perfStats([turn(200, 400, 300), turn(100, 800, 200), turn(300, 600, 100)])).toEqual({
      turns: 3, sttEndpoint: { p50: 200, p95: 300 }, model: { p50: 600, p95: 800 }, tts: { p50: 200, p95: 300 }, voiceToVoice: { p50: 1000, p95: 1100 },
    });
  });

  it("tells subscribers about each turn and a reset, with a stable snapshot between them", () => {
    let calls = 0;
    const off = perf.subscribe(() => calls++);
    perf.turnCommitted(150);
    perf.firstToken();
    perf.firstAudio();
    expect(calls).toBe(1);
    const s = perf.stats();
    expect(s?.turns).toBe(1);
    expect(perf.stats()).toBe(s);
    perf.firstAudio(); // no turn in flight: nothing recorded
    expect(calls).toBe(1);
    perf.reset();
    expect(perf.stats()).toBeNull();
    off();
    perf.reset();
    expect(calls).toBe(2);
  });
});
