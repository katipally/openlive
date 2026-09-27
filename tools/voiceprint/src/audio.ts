// The eval's rooms and mics, applied to 16 kHz mono audio. All O(samples) and
// deterministic for a seed, so every model hears the same trials.
const SR = 16000;

/** mulberry32: a seeded [0, 1) generator. */
export function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const power = (x: Float32Array) => { let s = 0; for (const v of x) s += v * v; return s / (x.length || 1); };
export const scale = (x: Float32Array, g: number) => x.map((v) => v * g);
/** Hard clipping at full scale, as an overdriven mic or ADC does. */
export const clip = (x: Float32Array) => x.map((v) => Math.max(-1, Math.min(1, v)));

/** `x` with `noise` (looped to length) added at `snrDb`. */
export function mix(x: Float32Array, noise: Float32Array, snrDb: number): Float32Array {
  const g = Math.sqrt(power(x) / (power(noise) || 1) / 10 ** (snrDb / 10));
  return x.map((v, i) => v + g * noise[i % noise.length]!);
}

/** Pink noise (Paul Kellett's filter): a fan, traffic, a room's hum. */
export function pink(n: number, rand: () => number): Float32Array {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return Float32Array.from({ length: n }, () => {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return out * 0.11;
  });
}

/** RBJ biquad, applied in place on a copy. */
function biquad(x: Float32Array, type: "lowpass" | "highpass", hz: number, q = Math.SQRT1_2): Float32Array {
  const w = (2 * Math.PI * hz) / SR, a = Math.sin(w) / (2 * q), c = Math.cos(w);
  const [b0, b1, b2] = type === "lowpass" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
/** A narrow mic: a headset on Bluetooth's voice profile, or a cheap webcam's. */
export const band = (x: Float32Array, lo = 300, hi = 3400) => biquad(biquad(x, "highpass", lo), "lowpass", hi);

/** A Schroeder reverb (four combs, two allpasses) mixed under the dry signal:
 *  a hard, echoey room with the mic an arm's length or more away. `rt60` sets
 *  the comb feedback. */
export function room(x: Float32Array, rt60 = 0.5, wet = 0.7): Float32Array {
  const combs = [1557, 1617, 1491, 1422].map((d) => Math.round((d * SR) / 44100));
  const y = new Float32Array(x.length);
  for (const d of combs) {
    const g = 10 ** ((-3 * d) / (rt60 * SR));
    const buf = new Float32Array(d);
    for (let i = 0, k = 0; i < x.length; i++, k = (k + 1) % d) { const out = buf[k]!; buf[k] = x[i]! + g * out; y[i]! += out / combs.length; }
  }
  for (const d of [225, 556].map((v) => Math.round((v * SR) / 44100))) {
    const buf = new Float32Array(d);
    for (let i = 0, k = 0; i < y.length; i++, k = (k + 1) % d) { const b = buf[k]!, v = y[i]!; buf[k] = v + 0.5 * b; y[i] = b - 0.5 * buf[k]!; }
  }
  const g = Math.sqrt(power(x) / (power(y) || 1));
  return x.map((v, i) => v + wet * g * y[i]!);
}

/** Where speech begins: the first 20 ms frame within 26 dB of the loudest
 *  frames, less 0.1 s, as a VAD's pre-roll would keep it. */
export function onset(x: Float32Array): number {
  const f = 320, e: number[] = [];
  for (let i = 0; i + f <= x.length; i += f) e.push(power(x.subarray(i, i + f)));
  const loud = [...e].sort((a, b) => a - b)[Math.floor(e.length * 0.95)] ?? 0;
  const i = e.findIndex((v) => v > loud * 0.0025);
  return Math.max(0, (i < 0 ? 0 : i) * f - 0.1 * SR);
}

/** The first `s` seconds from speech onset, or all of it for Infinity. */
export const windowOf = (x: Float32Array, s: number) => {
  const a = onset(x);
  return x.slice(a, Number.isFinite(s) ? a + Math.round(s * SR) : x.length);
};
