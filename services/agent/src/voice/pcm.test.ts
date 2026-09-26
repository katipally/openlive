import { describe, it, expect } from "vitest";
import { fitSilence, limitPeak, pcmBytes, pcmFromBytes, splitAtPauses, SAMPLE_RATE } from "./pcm.js";

describe("pcmFromBytes / pcmBytes", () => {
  it("round-trips samples", () => {
    const s = new Float32Array([0, 0.5, -1, 1e-7]);
    expect(Array.from(pcmFromBytes(pcmBytes(s))!)).toEqual(Array.from(s));
  });

  it("rejects a byte count that is not whole samples", () => {
    expect(pcmFromBytes(new Uint8Array(6))).toBeNull();
  });

  it("returns an empty array for an empty body", () => {
    expect(pcmFromBytes(new Uint8Array(0))!.length).toBe(0);
  });

  it("reads only its own bytes from a pooled, offset Buffer", () => {
    const pool = Buffer.alloc(64, 0xff);
    const view = pool.subarray(3, 3 + 8);
    Buffer.from(new Float32Array([0.25, -0.75]).buffer).copy(view);
    const out = pcmFromBytes(view)!;
    expect(Array.from(out)).toEqual([0.25, -0.75]);
    expect(out.buffer.byteLength).toBe(8);
  });

  it("pcmBytes keeps a subarray's offset", () => {
    const s = new Float32Array([1, 2, 3]).subarray(1);
    expect(Array.from(pcmFromBytes(pcmBytes(s))!)).toEqual([2, 3]);
  });
});

describe("splitAtPauses", () => {
  const MAX = 8 * SAMPLE_RATE;
  const tone = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 5) * 0.5);

  it("leaves short and empty audio whole", () => {
    expect(splitAtPauses(new Float32Array(0)).map((w) => w.length)).toEqual([0]);
    expect(splitAtPauses(tone(MAX)).map((w) => w.length)).toEqual([MAX]);
  });

  it("cuts inside the silence nearest the window end and loses nothing", () => {
    const s = tone(20 * SAMPLE_RATE);
    const quietAt = 6.5 * SAMPLE_RATE;
    s.fill(0, quietAt, quietAt + SAMPLE_RATE / 10);
    const windows = splitAtPauses(s);
    expect(windows[0]!.length).toBeGreaterThanOrEqual(quietAt);
    expect(windows[0]!.length).toBeLessThanOrEqual(quietAt + SAMPLE_RATE / 10);
    expect(windows.every((w) => w.length <= MAX)).toBe(true);
    expect(windows.reduce((n, w) => n + w.length, 0)).toBe(s.length);
  });

  it("bounds every window for very long audio with no pauses", () => {
    const windows = splitAtPauses(tone(60 * SAMPLE_RATE));
    expect(windows.every((w) => w.length > 0 && w.length <= MAX)).toBe(true);
    expect(windows.reduce((n, w) => n + w.length, 0)).toBe(60 * SAMPLE_RATE);
  });
});

describe("limitPeak", () => {
  it("brings a clipping chunk down to the ceiling, keeping its shape", () => {
    const out = limitPeak(new Float32Array([0.5, -1.076, 0.2]));
    expect(Math.max(...Array.from(out, Math.abs))).toBeCloseTo(0.95, 5);
    expect(out[0]! / out[2]!).toBeCloseTo(2.5, 5);
  });

  it("never raises a quiet chunk", () => {
    expect(Array.from(limitPeak(new Float32Array([0.1, -0.9, 0])))).toEqual(Array.from(new Float32Array([0.1, -0.9, 0])));
    expect(limitPeak(new Float32Array(0)).length).toBe(0);
  });
});

describe("fitSilence", () => {
  // At 1 kHz a frame is 10 samples. This hiss is under -50 dBFS RMS though half its samples cross -50 dBFS.
  const hiss = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? 0.004 : 0.001));
  const speech = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.5 : -0.4));
  const wav = new Float32Array([...hiss(300), ...speech, ...hiss(400)]);

  it("keeps exactly the lead and tail asked for, the render's own samples first", () => {
    const out = fitSilence(wav, 1000, 0.05, 0.1);
    expect(out.length).toBe(50 + 30 + 100);
    expect(Array.from(out.subarray(50, 80))).toEqual(Array.from(wav.subarray(300, 330)));
    expect(out[49]).toBe(wav[299]);
    expect(out[179]).toBe(wav[429]);
  });

  it("pads with zeros where the render has less silence than asked", () => {
    const out = fitSilence(new Float32Array(speech.slice(0, 20)), 1000, 0.01, 0.02);
    expect(out.length).toBe(10 + 20 + 20);
    expect([out[0], out[9], out[30], out[49]]).toEqual([0, 0, 0, 0]);
    expect(out[10]).toBe(Math.fround(-0.4));
  });

  it("returns nothing for all silence", () => {
    expect(fitSilence(new Float32Array(hiss(500)), 1000, 0.05, 0.1).length).toBe(0);
  });
});
