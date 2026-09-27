import { expect, it } from "vitest";
import { eer, far, frr, quantile, thresholdAtFrr } from "./metrics";

it("counts blocked users and admitted others at a threshold", () => {
  expect(frr([0.1, 0.5, 0.9], 0.5)).toBeCloseTo(1 / 3);
  expect(far([0.1, 0.5, 0.9], 0.5)).toBeCloseTo(2 / 3);
});

it("finds no error between separable scores, and the crossing of overlapping ones", () => {
  expect(eer([0.8, 0.9], [0.1, 0.2]).eer).toBe(0);
  const t = eer([0.8, 0.9], [0.1, 0.2]).threshold;
  expect(t).toBeGreaterThan(0.2);
  expect(t).toBeLessThanOrEqual(0.8);
  // One of four on each side crosses: 25%.
  expect(eer([0.3, 0.6, 0.7, 0.8], [0.1, 0.2, 0.4, 0.65]).eer).toBeCloseTo(0.25);
});

it("picks the highest threshold that blocks at most the given share", () => {
  const tar = Array.from({ length: 100 }, (_, i) => i / 100);
  const t = thresholdAtFrr(tar, 0.02);
  expect(frr(tar, t)).toBeLessThanOrEqual(0.02);
  expect(frr(tar, t + 0.01)).toBeGreaterThan(0.02);
  expect(quantile(tar, 0.5)).toBeCloseTo(0.5);
});
