import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Silero } from "@ricky0123/vad-web/dist/models";
import { ort } from "@ricky0123/vad-web/dist/real-time-vad";
import { MIN_SPEECH_FRAMES, PRE_ROLL_MS, speechFrom } from "./tapeSpeech";

// The words were rendered offline with macOS `say` (Flo "yes", Fred "ok",
// Samantha "thanks"), 16 kHz 16-bit mono; the room is made here.
const FIXTURES = join(import.meta.dirname, "fixtures");
const DIST = join(createRequire(import.meta.url).resolve("@ricky0123/vad-web"), "..");
const THRESHOLD = 0.5; // the pipeline's default speechThreshold

function wav(name: string): Float32Array {
  const b = readFileSync(join(FIXTURES, `${name}.wav`));
  const n = b.readUInt32LE(40) / 2;
  return Float32Array.from({ length: n }, (_, i) => b.readInt16LE(44 + 2 * i) / 32768);
}

let seed = 7;
const noise = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 * 2 - 1; };
const scaled = (a: Float32Array, rms: number) => {
  const now = Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) || 1;
  return a.map((v) => (v * rms) / now);
};
/** Room sounds, `n` samples at `rms`. */
const ROOMS: Record<string, (n: number) => Float32Array> = {
  pink: (n) => { let a = 0, b = 0, c = 0; return Float32Array.from({ length: n }, () => { const w = noise(); a = 0.99765 * a + w * 0.099046; b = 0.963 * b + w * 0.2965164; c = 0.57 * c + w * 1.0526913; return a + b + c + w * 0.1848; }); },
  white: (n) => Float32Array.from({ length: n }, noise),
  brown: (n) => { let x = 0; return Float32Array.from({ length: n }, () => (x = (x + 0.02 * noise()) * 0.998)); },
  hum: (n) => Float32Array.from({ length: n }, (_, i) => { const t = i / 16000; return Math.sin(2 * Math.PI * 60 * t) + 0.5 * Math.sin(2 * Math.PI * 120 * t) + 0.3 * Math.sin(2 * Math.PI * 180 * t); }),
  keys: (n) => { const a = new Float32Array(n); for (let k = 800; k < n; k += 2400) for (let j = 0; j < 200 && k + j < n; j++) a[k + j] = noise() * Math.exp(-j / 30); return a; },
};

describe.each(["v5", "v6"])("Silero %s over a hold's tape", async (model) => {
  const silero = await Silero.new(ort, async () => readFileSync(join(DIST, `silero_vad_${model}.onnx`)).buffer as ArrayBuffer);
  const from = (tape: Float32Array) => { silero.reset_state(); return speechFrom(tape, async (f) => (await silero.process(f)).isSpeech, THRESHOLD); };

  it.each(["yes", "ok", "thanks"])("finds a single %s in a quiet room, cut just before it", async (word) => {
    // 400 ms of room, the word, 300 ms of room, the room at -54 dBFS.
    const said = scaled(wav(word), 0.03);
    const tape = scaled(ROOMS.pink!(6400 + said.length + 4800), 0.002);
    said.forEach((v, i) => { tape[6400 + i]! += v; });
    const at = await from(tape);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThanOrEqual(6400);
    expect(at).toBeGreaterThanOrEqual(6400 - (PRE_ROLL_MS + MIN_SPEECH_FRAMES * 32) * 16 - 512 * 8);
  });

  it.each(Object.keys(ROOMS))("finds no speech in %s noise, quiet or loud", async (room) => {
    for (const rms of [0.003, 0.03, 0.1]) expect(await from(scaled(ROOMS[room]!(2 * 16000), rms))).toBe(-1);
  });

  it("finds no speech in silence", async () => {
    expect(await from(new Float32Array(2 * 16000))).toBe(-1);
  });
});

it("cuts the pre-roll before the first run, and never before the tape", async () => {
  const at = (probs: number[]) => { let i = 0; return speechFrom(new Float32Array(probs.length * 512), async () => probs[i++]!, 0.5); };
  expect(await at([0, 0.9, 0.9, 0, 0, 0, 0])).toBe(-1); // two frames: a click, not a word
  expect(await at([...Array(20).fill(0), 0.6, 0.7, 0.8, 0])).toBe(20 * 512 - PRE_ROLL_MS * 16);
  expect(await at([0.9, 0.9, 0.9])).toBe(0);
});
