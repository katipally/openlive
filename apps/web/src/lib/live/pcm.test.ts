// Guards the PCM stream decoder (network chunks split samples).
import assert from "node:assert";
import { test } from "vitest";
import { pcmDecoder } from "./pcm.ts";

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
