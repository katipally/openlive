import { describe, expect, it } from "vitest";
import { popOrigin, staggerDelay, STAGGER_MAX, STAGGER_S } from "./motion";

describe("staggerDelay", () => {
  it("steps per item and stops growing at the cap", () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(2)).toBeCloseTo(2 * STAGGER_S);
    expect(staggerDelay(STAGGER_MAX + 400)).toBeCloseTo(STAGGER_MAX * STAGGER_S);
    expect(staggerDelay(-3)).toBe(0);
  });
});

describe("popOrigin", () => {
  const panel = { left: 100, top: 40, width: 200, height: 120 };
  it("grows down from under the trigger's centre", () => {
    expect(popOrigin(panel, { left: 260, top: 10, width: 28, height: 28 })).toEqual({ x: 174, below: true });
  });
  it("grows up when the panel sits over the trigger", () => {
    expect(popOrigin(panel, { left: 100, top: 170, width: 40, height: 44 }).below).toBe(false);
  });
  it("stays on the panel's own edge when the trigger is off to one side", () => {
    expect(popOrigin(panel, { left: 0, top: 0, width: 20, height: 20 }).x).toBe(0);
    expect(popOrigin(panel, { left: 900, top: 0, width: 20, height: 20 }).x).toBe(200);
  });
  it("falls back to the top centre without a trigger", () => {
    expect(popOrigin(panel, null)).toEqual({ x: 100, below: true });
  });
});
