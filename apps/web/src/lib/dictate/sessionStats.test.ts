import { describe, expect, it } from "vitest";
import { bucketLatency, latencyPercentiles, LATENCY_MAX_MS } from "./sessionStats";

describe("bucketLatency", () => {
  it("rounds to 50 ms and caps at 30 s", () => {
    expect(bucketLatency(0)).toBe(0);
    expect(bucketLatency(74)).toBe(50);
    expect(bucketLatency(75)).toBe(100);
    expect(bucketLatency(1e9)).toBe(LATENCY_MAX_MS);
    expect(bucketLatency(-5)).toBe(0);
  });
});

describe("latencyPercentiles", () => {
  it("is null without samples", () => expect(latencyPercentiles([])).toBeNull());
  it("is the sample itself for one", () => expect(latencyPercentiles([420])).toEqual({ p50: 400, p90: 400 }));
  it("reads the nearest rank, whatever the order", () => {
    const ms = Array.from({ length: 10 }, (_, i) => (i + 1) * 100).reverse();
    expect(latencyPercentiles(ms)).toEqual({ p50: 500, p90: 900 });
  });
  it("does not change the input and caps outliers", () => {
    const ms = [300, 99999, 100];
    expect(latencyPercentiles(ms)).toEqual({ p50: 300, p90: LATENCY_MAX_MS });
    expect(ms).toEqual([300, 99999, 100]);
  });
});
