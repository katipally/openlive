import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { nextRestartDelay } = createRequire(import.meta.url)("./service-restart.cjs");

describe("nextRestartDelay", () => {
  it("backs off, then gives up after six quick crashes in a row", () => {
    const budget = { count: 0 };
    const delays = Array.from({ length: 7 }, () => nextRestartDelay(budget, 2000));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000, null]);
  });

  it("starts over once a run stayed up long enough to be healthy", () => {
    const budget = { count: 0 };
    for (let i = 0; i < 6; i++) nextRestartDelay(budget, 1000);
    expect(nextRestartDelay(budget, 60000)).toBe(500);
    expect(budget.count).toBe(1);
  });

  it("does not let slow crashes add up across a long session", () => {
    const budget = { count: 0 };
    for (let i = 0; i < 50; i++) expect(nextRestartDelay(budget, 3_600_000)).toBe(500);
  });
});
