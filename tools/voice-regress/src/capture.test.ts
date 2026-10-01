import { describe, expect, it } from "vitest";
import { articulation, joinCheck, reconstruct, spikes } from "./capture";

const SR = 24000;
const tone = (hz: number, s: number, amp = 0.3) => Float32Array.from({ length: Math.round(s * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
const silence = (s: number) => new Float32Array(Math.round(s * SR));
const cat = (...xs: Float32Array[]) => {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0));
  xs.reduce((o, x) => (out.set(x, o), o + x.length), 0);
  return out;
};

describe("articulation", () => {
  it("leaves a pause of 150 ms or more out of the speech time", () => {
    const a = articulation(cat(tone(150, 1), silence(0.5), tone(150, 1)), SR, 40);
    expect(a.speechS).toBeGreaterThan(1.9);
    expect(a.speechS).toBeLessThan(2.1);
    expect(a.cps).toBeCloseTo(40 / a.speechS, 5);
    expect(Math.abs(a.f0 - 150)).toBeLessThan(3);
  });
  it("keeps a short gap and calls silence NaN", () => {
    expect(articulation(cat(tone(150, 1), silence(0.08), tone(150, 1)), SR, 40).speechS).toBeGreaterThan(2.04);
    expect(articulation(silence(1), SR, 40).cps).toBeNaN();
  });
});

describe("joinCheck", () => {
  it("passes a clean fade into silence and a continuous join", () => {
    const x = tone(150, 1);
    expect(joinCheck(x.subarray(0, 12000), SR, x.subarray(12000), SR, true).flags).toEqual([]);
    expect(joinCheck(silence(0.1), SR, silence(0.1), SR, false).flags).toEqual([]);
  });
  it("flags a signal cut off or begun against silence", () => {
    const x = tone(150, 1, 0.3);
    expect(joinCheck(x, SR, null, SR, false).flags).toContain("abrupt-end");
    expect(joinCheck(null, SR, x.subarray(1000), SR, false).flags).toContain("abrupt-start");
  });
  it("flags a step between adjoining pieces and a DC offset", () => {
    const x = tone(150, 1, 0.3);
    const b = x.slice(0, 6000).map((v) => v + 0.05);
    const c = joinCheck(x.subarray(0, 6000), SR, b, SR, true);
    expect(c.flags).toEqual(expect.arrayContaining(["jump", "dc"]));
  });
  it("copes with an empty piece", () => {
    expect(joinCheck(new Float32Array(0), SR, new Float32Array(0), SR, true).flags).toEqual([]);
  });
});

describe("spikes", () => {
  it("finds one isolated click, not a tone or noise", () => {
    const x = tone(150, 1);
    x[12000] = 0.6;
    const at = spikes(x, SR);
    expect(at.length).toBe(1);
    expect(at[0]).toBeCloseTo(0.5, 2);
    let seed = 1;
    const noise = Float32Array.from({ length: SR }, () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 0.8 - 0.4);
    expect(spikes(cat(tone(150, 1), noise), SR)).toEqual([]);
  });
});

describe("reconstruct", () => {
  it("puts each piece at its scheduled time, gap included, and resamples a different rate", () => {
    const out = reconstruct([{ x: tone(150, 1), rate: SR, startAt: 10 }, { x: tone(150, 1).slice(0, 22050), rate: 22050, startAt: 11.5 }], SR)!;
    expect(out.length / SR).toBeCloseTo(2.5, 1);
    expect(Math.max(...out.subarray(SR * 1.1, SR * 1.4).map(Math.abs))).toBe(0);
    expect(Math.max(...out.subarray(SR * 1.6, SR * 1.9).map(Math.abs))).toBeGreaterThan(0.2);
  });
  it("gives up on a span past 30 minutes and on no audio", () => {
    expect(reconstruct([{ x: tone(150, 1), rate: SR, startAt: 0 }, { x: tone(150, 1), rate: SR, startAt: 5000 }], SR)).toBeNull();
    expect(reconstruct([], SR)).toBeNull();
  });
});
