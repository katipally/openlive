import { describe, expect, it } from "vitest";
import { bestScore, cosine, fold, informative, OtherVoices, type Print } from "./voiceprint";

describe("cosine", () => {
  it("is 1 for the same direction, 0 for orthogonal or zero vectors", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 3])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

it("finds nothing to compare in a zero, NaN or infinite embedding", () => {
  expect(informative([0.1, -2])).toBe(true);
  for (const e of [[], [0, 0], [NaN, 1], [Infinity, 0]]) expect(informative(e)).toBe(false);
});

describe("fold", () => {
  it("keeps the mean of unit vectors, whatever their length", () => {
    let p = { mean: [] as number[], n: 0 };
    for (const e of [[10, 0], [0, 0.5], [3, 0]]) p = { mean: fold(p, e), n: p.n + 1 };
    expect(p.mean[0]).toBeCloseTo(2 / 3);
    expect(p.mean[1]).toBeCloseTo(1 / 3);
  });
});

it("scores against the closest print, 0 with none", () => {
  const print = (mic: string, mean: number[]): Print => ({ mic, mean, n: 1, seconds: 15, at: 0 });
  expect(bestScore([], [1, 0])).toBe(0);
  expect(bestScore([print("a", [1, 0]), print("b", [0, 1])], [0.1, 1])).toBeCloseTo(cosine([0, 1], [0.1, 1]));
  expect(bestScore([print("a", [1, 0])], [-1, 0.2])).toBeCloseTo(cosine([1, 0], [-1, 0.2]));
});

it("numbers other voices in the order first heard, the same voice keeping its number", () => {
  const others = new OtherVoices(0.8);
  expect(others.label([1, 0, 0])).toBe(1);
  expect(others.label([0, 1, 0])).toBe(2);
  expect(others.label([0.95, 0.1, 0])).toBe(1);
  expect(others.label([0, 0, 1])).toBe(3);
  expect(others.label([0.1, 0.98, 0])).toBe(2);
});
