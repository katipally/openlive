// Guards the PCM stream decoder (network chunks split samples), the render trim and the pre-speech ring.
import assert from "node:assert";
import { test } from "vitest";
import { pcmDecoder, FrameRing, trimSilence } from "./pcm.ts";

const bytesOf = (a: number[]) => new Uint8Array(new Float32Array(a).buffer);

test("pcmDecoder: samples split across chunks at every offset come out whole and in order", () => {
  const src = bytesOf([0.5, -0.25, 1, -1, 0.125]);
  for (let cut = 0; cut <= src.length; cut++) {
    const decode = pcmDecoder();
    const out = [...decode(src.subarray(0, cut)), ...decode(src.subarray(cut))];
    assert.deepEqual(out, [0.5, -0.25, 1, -1, 0.125], `cut at ${cut}`);
  }
});

test("pcmDecoder: one-byte chunks and empty chunks", () => {
  const src = bytesOf([0.75, -0.5]);
  const decode = pcmDecoder();
  const out: number[] = [];
  for (const b of src) { out.push(...decode(new Uint8Array([b]))); out.push(...decode(new Uint8Array(0))); }
  assert.deepEqual(out, [0.75, -0.5]);
});

test("pcmDecoder: an unaligned view (odd byteOffset) decodes", () => {
  const padded = new Uint8Array(9);
  padded.set(bytesOf([0.5, 2]), 1);
  assert.deepEqual([...pcmDecoder()(padded.subarray(1))], [0.5, 2]);
});

test("FrameRing: keeps the newest frames oldest-first, then empties", () => {
  const ring = new FrameRing(3);
  assert.equal(ring.drain().length, 0);
  for (let i = 1; i <= 5; i++) ring.push(new Float32Array([i, i]));
  assert.deepEqual([...ring.drain()], [3, 3, 4, 4, 5, 5]);
  assert.equal(ring.drain().length, 0);
  ring.push(new Float32Array([9]));
  assert.deepEqual([...ring.drain()], [9]);
  ring.push(new Float32Array([1])); ring.clear();
  assert.equal(ring.drain().length, 0);
});

test("trimSilence: keeps the speech plus at most the lead and tail asked for", () => {
  const wav = new Float32Array(100);
  wav.fill(0.5, 40, 60);                                       // speech at 40..59, silence around it
  assert.equal(trimSilence(wav, 100, 0.05, 0.1).length, 5 + 20 + 10);
  assert.equal(trimSilence(wav, 100, 0.05, 0.1)[5], 0.5);       // the speech starts after the 5-sample lead
  assert.equal(trimSilence(wav, 100, 1, 1).length, 100);         // never pads past what the render has
  assert.equal(trimSilence(new Float32Array(50), 100, 0.05, 0.1).length, 0);
});
