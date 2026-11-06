import { describe, expect, it } from "vitest";
import { CUE_GAIN, cueTone } from "./holdCue";

describe("cueTone", () => {
  it("is 60 to 90 ms long at any rate", () => {
    for (const rate of [16000, 24000, 48000]) {
      for (const cue of ["start", "stop"] as const) {
        const ms = (cueTone(cue, rate).length / rate) * 1000;
        expect(ms).toBeGreaterThanOrEqual(60);
        expect(ms).toBeLessThanOrEqual(90);
      }
    }
  });
  it("stays under the gain and starts and ends near zero", () => {
    const t = cueTone("start", 48000);
    expect(Math.max(...t.map(Math.abs))).toBeLessThanOrEqual(CUE_GAIN);
    expect(Math.abs(t[0]!)).toBeLessThan(1e-3);
    expect(Math.abs(t[t.length - 1]!)).toBeLessThan(1e-3);
  });
  it("is not silent", () => {
    expect(Math.max(...cueTone("stop", 24000))).toBeGreaterThan(CUE_GAIN / 2);
  });
});
