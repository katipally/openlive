import { describe, expect, it } from "vitest";
import { compareReply, edge, leadTail, median, pauseAt, semitones, snap, speech, track } from "./analyze";

const SR = 24000;
/** `hz` tone (with two harmonics, like a voice) for `s` seconds at `amp`; hz 0 is silence. */
function tone(hz: number, s: number, amp = 0.3): Float32Array {
  const x = new Float32Array(Math.round(s * SR));
  for (let i = 0; i < x.length && hz; i++) {
    const t = (2 * Math.PI * hz * i) / SR;
    x[i] = amp * (Math.sin(t) + 0.5 * Math.sin(2 * t) + 0.25 * Math.sin(3 * t)) / 1.75;
  }
  return x;
}
const cat = (...xs: Float32Array[]) => {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0));
  xs.reduce((o, x) => (out.set(x, o), o + x.length), 0);
  return out;
};

describe("track", () => {
  it.each([90, 150, 220, 330])("finds F0 of a %i Hz voice-like tone within a third of a semitone", (hz) => {
    const f0 = median(track(tone(hz, 1), SR).f0);
    expect(Math.abs(semitones(f0, hz))).toBeLessThan(1 / 3);
  });

  it("works at 44.1 kHz and 16 kHz too", () => {
    for (const sr of [44100, 16000]) {
      const x = Float32Array.from({ length: sr }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 180 * i) / sr));
      expect(Math.abs(median(track(x, sr).f0) - 180)).toBeLessThan(2);
    }
  });

  it("calls silence and white noise unvoiced", () => {
    let seed = 1;
    const noise = Float32Array.from({ length: SR }, () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 0.4 - 0.2);
    const t = track(cat(tone(0, 0.5), noise), SR);
    expect(t.f0.filter(Number.isFinite).length).toBeLessThan(t.f0.length * 0.05);
  });

  it("handles audio shorter than one frame", () => {
    expect(track(new Float32Array(100), SR).rms.length).toBe(0);
  });
});

describe("gaps and edges", () => {
  const x = cat(tone(0, 0.3), tone(200, 1), tone(0, 0.4), tone(250, 1, 0.075), tone(0, 0.2));
  const t = track(x, SR);

  it("finds speech and the pause between two tones", () => {
    const [s, e] = speech(t, 0, t.active.length);
    expect(s).toBeGreaterThanOrEqual(26); expect(s).toBeLessThanOrEqual(31);
    expect(e).toBeGreaterThanOrEqual(266); expect(e).toBeLessThanOrEqual(273);
    expect(pauseAt(t, 80)).toBe(0);
    expect(pauseAt(t, 150)).toBeCloseTo(0.4, 1);
  });

  it("snaps an estimate to the middle of the nearby pause", () => {
    expect(Math.abs(snap(t, 110) - 150)).toBeLessThanOrEqual(3);
  });

  it("measures the pitch step and a 12 dB loudness step across the pause", () => {
    const before = edge(t, 150, true), after = edge(t, 150, false);
    expect(semitones(after.f0, before.f0)).toBeCloseTo(12 * Math.log2(250 / 200), 0);
    expect(after.db - before.db).toBeCloseTo(-12, 0);
  });

  it("measures lead and tail silence at the -50 dBFS floor", () => {
    const { lead, tail } = leadTail(x, SR);
    expect(lead).toBeCloseTo(0.3, 2);
    expect(tail).toBeCloseTo(0.2, 2);
    expect(leadTail(new Float32Array(10), SR).lead * SR).toBe(10);
  });
});

describe("compareReply", () => {
  const a = tone(200, 1), b = tone(190, 1);
  const ref = cat(tone(0, 0.05), a, tone(0, 0.3), b, tone(0, 0.1));

  it("reads a render that matches the one-go render as seamless", () => {
    const m = compareReply([cat(tone(0, 0.05), a, tone(0, 0.15)), cat(tone(0, 0.15), b, tone(0, 0.1))], ref, SR);
    expect(m.joins).toHaveLength(1);
    const j = m.joins[0]!;
    expect(Math.abs(j.pause - j.refPause)).toBeLessThan(0.03);
    expect(Math.abs(j.f0Step - j.refF0Step)).toBeLessThan(0.2);
    expect(Math.abs(j.loudStep - j.refLoudStep)).toBeLessThan(0.5);
    expect(Math.max(...m.headDev)).toBeLessThan(0.2);
    expect(m.durationRatio).toBeCloseTo(1, 2);
    expect(m.nan + m.clipped + m.emptyChunks).toBe(0);
  });

  it("keeps the pause before a chunk that speaks from its first sample, and finds none at a hard join", () => {
    const m = compareReply([cat(a, tone(0, 0.3)), b], ref, SR);
    expect(Math.abs(m.joins[0]!.pause - m.joins[0]!.refPause)).toBeLessThan(0.03);
    expect(compareReply([a, b], ref, SR).joins[0]!.pause).toBeLessThan(0.02);
  });

  it("flags a long pause, a pitch jump and a loudness jump at a join", () => {
    const m = compareReply([cat(a, tone(0, 0.6)), cat(tone(0, 0.5), tone(240, 1, 0.9))], ref, SR);
    const j = m.joins[0]!;
    expect(j.pause - j.refPause).toBeGreaterThan(0.7);
    expect(Math.abs(j.f0Step - j.refF0Step)).toBeGreaterThan(3);
    expect(j.loudStep - j.refLoudStep).toBeGreaterThan(8);
    expect(m.headDev[1]).toBeGreaterThan(3);
  });

  it("counts NaN, clipped and silent chunks", () => {
    const bad = tone(200, 0.5);
    bad[10] = NaN; bad[20] = 1.2;
    const m = compareReply([bad, new Float32Array(2400), new Float32Array(0)], ref, SR);
    expect([m.nan, m.clipped, m.emptyChunks]).toEqual([1, 1, 2]);
  });
});
