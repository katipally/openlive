import { expect, it } from "vitest";
import { band, mix, onset, pink, power, rng, room, windowOf } from "./audio";

const SR = 16000;
const sine = (hz: number, s: number) => Float32Array.from({ length: s * SR }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / SR));
const db = (x: number) => 10 * Math.log10(x);

it("mixes noise in at the asked SNR", () => {
  const x = sine(300, 1), n = pink(SR, rng(1));
  const y = mix(x, n, 5);
  expect(db(power(x) / power(y.map((v, i) => v - x[i]!)))).toBeCloseTo(5, 1);
});

it("is the same for the same seed", () => {
  expect(pink(100, rng(7))).toEqual(pink(100, rng(7)));
});

it("passes the voice band and cuts what is outside it", () => {
  expect(db(power(band(sine(1000, 1))) / power(sine(1000, 1)))).toBeGreaterThan(-1);
  expect(db(power(band(sine(80, 1))) / power(sine(80, 1)))).toBeLessThan(-12);
  expect(db(power(band(sine(7000, 1))) / power(sine(7000, 1)))).toBeLessThan(-12);
});

it("adds a tail that rings on after the sound stops", () => {
  const x = new Float32Array(SR);
  x.set(sine(500, 0.2));
  const y = room(x);
  expect(power(y.subarray(0.3 * SR, 0.5 * SR))).toBeGreaterThan(1e-5);
});

it("starts a window 0.1 s before the speech and runs it the asked length", () => {
  const x = new Float32Array(3 * SR);
  x.set(sine(200, 2), SR);
  expect(onset(x) / SR).toBeCloseTo(0.9, 1);
  expect(windowOf(x, 1).length).toBe(SR);
  expect(windowOf(x, Infinity).length).toBe(x.length - onset(x));
});
