import { describe, expect, it } from "vitest";
import { sineMark } from "./sineMark";

const points = (d: string) => d.slice(1).split("L").map((p) => p.split(" ").map(Number) as [number, number]);

describe("sineMark", () => {
  it("draws one whole sine, up on the left and down on the right, centred in the disc", () => {
    for (const n of [15, 16, 18, 32]) {
      const pts = points(sineMark(n).d), ys = pts.map(([, y]) => y);
      const top = ys.indexOf(Math.min(...ys)), bottom = ys.indexOf(Math.max(...ys));
      expect(top).toBeLessThan(pts.length / 2);
      expect(bottom).toBeGreaterThan(pts.length / 2);
      expect(n / 2 - Math.min(...ys)).toBeCloseTo(Math.max(...ys) - n / 2, 9);
      expect(pts[0]![1]).toBeCloseTo(n / 2, 9);
      expect(pts.at(-1)![1]).toBeCloseTo(n / 2, 9);
      expect(pts[0]![0] + pts.at(-1)![0]).toBeCloseTo(n, 9);
    }
  });

  it("keeps the stroke and the peaks on whole pixels at icon sizes", () => {
    for (const [n, stroke, amp] of [[16, 2, 2], [18, 2, 3], [32, 4, 5]] as const) {
      const m = sineMark(n), ys = points(m.d).map(([, y]) => y);
      expect(m.stroke).toBe(stroke);
      expect(n / 2 - Math.min(...ys)).toBe(amp);
    }
  });
});
