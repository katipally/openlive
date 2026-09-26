import assert from "node:assert";
import { test } from "vitest";
import { trimSilence } from "./trim";

test("trimSilence: keeps the speech plus at most the lead and tail asked for", () => {
  const wav = new Float32Array(100);
  wav.fill(0.5, 40, 60);                                       // speech at 40..59, silence around it
  assert.equal(trimSilence(wav, 100, 0.05, 0.1).length, 5 + 20 + 10);
  assert.equal(trimSilence(wav, 100, 0.05, 0.1)[5], 0.5);       // the speech starts after the 5-sample lead
  assert.equal(trimSilence(wav, 100, 1, 1).length, 100);         // never pads past what the render has
  assert.equal(trimSilence(new Float32Array(50), 100, 0.05, 0.1).length, 0);
});
