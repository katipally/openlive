// Guards the PCM stream decoder (network chunks split samples) and the pre-speech ring.
import assert from "node:assert";
import { test } from "vitest";
import { pcmDecoder, FrameRing } from "./pcm.ts";

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
