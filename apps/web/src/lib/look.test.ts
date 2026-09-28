import { describe, expect, it } from "vitest";
import { GLASS_REASON, SLOW_P95_MS, p95, slowFrames } from "./look";

describe("p95", () => {
  it("is 0 with no samples and the 95th value otherwise", () => {
    expect(p95([])).toBe(0);
    expect(p95([5])).toBe(5);
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(xs)).toBe(95);
  });
});

describe("slowFrames", () => {
  const frames = (ms: number, n = 60) => Array.from({ length: n }, () => ms);
  it("passes a display that keeps its own rate, at 60 and 120 Hz", () => {
    expect(slowFrames(frames(16.7))).toBe(false);
    expect(slowFrames(frames(8.3, 120))).toBe(false);
  });
  it("forgives a hitch or two but not steady dropped frames", () => {
    expect(slowFrames([...frames(16.7, 58), 80, 90])).toBe(false);
    expect(slowFrames([...frames(16.7, 50), ...frames(50, 10)])).toBe(true);
    expect(slowFrames(frames(SLOW_P95_MS + 1, 25))).toBe(true);
  });
  it("never calls no evidence slow", () => {
    expect(slowFrames([])).toBe(false);
  });
});

describe("GLASS_REASON", () => {
  it("has copy for every reason, with no em dashes", () => {
    for (const r of ["reduce-transparency", "no-gpu", "unsupported-os", "slow"] as const) {
      expect(GLASS_REASON[r].length).toBeGreaterThan(20);
      expect(GLASS_REASON[r]).not.toContain("—");
    }
  });
});
