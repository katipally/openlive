import { expect, it } from "vitest";
import { overlapMs, pct, voicedSpans } from "./measure";

it("measures overlap in one pass over two sorted timelines", () => {
  expect(overlapMs([[0, 100], [300, 400]], [[50, 350]])).toBe(100);
  expect(overlapMs([[0, 10]], [[10, 20]])).toBe(0);
  expect(overlapMs([], [[0, 1]])).toBe(0);
});

it("finds voiced spans, bridging a word's own short stops", () => {
  const pcm = new Float32Array(16000);
  for (let i = 0; i < 3200; i++) pcm[i] = 0.2;          // 0-200 ms
  for (let i = 4800; i < 6400; i++) pcm[i] = 0.2;       // 300-400 ms: 100 ms gap, bridged
  for (let i = 12800; i < 14336; i++) pcm[i] = 0.2;     // 800-896 ms
  expect(voicedSpans(pcm, 1000)).toEqual([[1000, 1416], [1800, 1896]]);
});

it("takes the nearest-rank percentile", () => {
  expect(pct([5, 1, 3], 50)).toBe(3);
  expect(pct([1, 2, 3, 4], 95)).toBe(4);
});
