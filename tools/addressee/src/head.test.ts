import { expect, it } from "vitest";
import { auc, fit, outOfFold, quantile, rates, thresholdAt } from "./head";

const x = [[1, 0], [0.9, 0.1], [0.8, 0.2], [0, 1], [0.1, 0.9], [0.2, 0.8]];
const y = [1, 1, 1, 0, 0, 0];

it("fits a head that scores side talk above addressed speech", () => {
  const h = fit(x, y);
  const z = x.map((v) => h.b + h.w[0]! * v[0]! + h.w[1]! * v[1]!);
  expect(Math.min(...z.slice(0, 3))).toBeGreaterThan(Math.max(...z.slice(3)));
});

it("scores every row once, out of its fold", () => {
  const s = outOfFold([...x, ...x], [...y, ...y], 2);
  expect(s).toHaveLength(12);
  expect(s.every(Number.isFinite)).toBe(true);
});

it("only trains on a row outside every fold", () => {
  const s = outOfFold([...x, ...x], [...y, ...y], 2, [-1, -1, -1, -1, -1, -1, 0, 0, 0, 1, 1, 1]);
  expect(s.slice(0, 6).every(Number.isNaN)).toBe(true);
  expect(s.slice(6).every(Number.isFinite)).toBe(true);
});

it("weighs a row as that many copies of it", () => {
  const once = fit([...x, [1, 0]], [...y, 0], [1, 1, 1, 1, 1, 1, 3]);
  const thrice = fit([...x, [1, 0], [1, 0], [1, 0]], [...y, 0, 0, 0]);
  expect(once.b).toBeCloseTo(thrice.b, 6);
  once.w.forEach((w, i) => expect(w).toBeCloseTo(thrice.w[i]!, 6));
});

it("picks the threshold that ignores at most the given share of addressed speech", () => {
  const s = Array.from({ length: 100 }, (_, i) => i);
  expect(s.filter((v) => v > thresholdAt(s, 0.01)).length).toBe(1);
  expect(s.filter((v) => v > thresholdAt(s, 0)).length).toBe(0);
});

it("counts false ignores, side talk caught and precision", () => {
  const r = rates([true, true, false, false], [true, false, true, false]);
  expect(r).toMatchObject({ falseIgnore: 0.5, caught: 0.5, precision: 0.5 });
  expect(auc([2, 3], [0, 1])).toBe(1);
  expect(auc([1], [1])).toBe(0.5);
  expect(quantile([1, 2, 3, 4], 0.5)).toBe(3);
});
