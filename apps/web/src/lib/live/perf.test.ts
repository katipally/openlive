import { beforeEach, describe, expect, it, vi } from "vitest";
import { latencyFact, perf, roundMs, type Turn } from "./perf";

const record = (n: number) => {
  for (let i = 0; i < n; i++) {
    perf.turnCommitted(100);
    perf.firstToken();
    perf.firstAudio();
  }
};

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => {});
  perf.reset();
});

describe("perf slice", () => {
  it("returns only the turns recorded after the mark", () => {
    record(3);
    const mark = perf.mark();
    record(2);
    expect(perf.since(mark)).toHaveLength(2);
    expect(perf.since(0)).toHaveLength(5);
    expect(perf.since(perf.mark())).toEqual([]);
  });

  it("keeps the newest 200 turns, and a mark that fell out of them gets what is left", () => {
    record(150);
    const mark = perf.mark();
    record(120);
    expect(perf.since(mark)).toHaveLength(120);
    expect(perf.since(0)).toHaveLength(200);
    expect(perf.stats()?.turns).toBe(200);
  });

  it("counts marks from the start again after a reset", () => {
    record(4);
    perf.reset();
    expect(perf.mark()).toBe(0);
    record(1);
    expect(perf.since(0)).toHaveLength(1);
  });
});

describe("latencyFact", () => {
  const turn = (sttEndpoint: number, model: number, tts: number): Turn => ({ sttEndpoint, model, tts, total: sttEndpoint + model + tts });

  it("is empty when no turn was measured, so nothing is sent for a session that never spoke", () => {
    expect(latencyFact([])).toEqual({});
  });

  it("reports medians in 10 ms steps with the turn count", () => {
    expect(latencyFact([turn(234, 300, 96), turn(400, 500, 200), turn(236, 310, 104)])).toEqual({
      stt_ms_p50: 240, tts_ms_p50: 100, v2v_ms_p50: 650, v2v_turns: 3,
    });
  });

  it("rounds to the nearest 10", () => {
    expect([roundMs(4), roundMs(5), roundMs(14), roundMs(1234)]).toEqual([0, 10, 10, 1230]);
  });
});
