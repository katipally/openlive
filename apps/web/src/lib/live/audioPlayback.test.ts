// Guards the playback clock across hold / release / flush (a Web Audio stand-in, no sound).
import assert from "node:assert";
import { test } from "vitest";
import { AudioPlayer } from "./audioPlayback.ts";

class FakeContext {
  state: "running" | "suspended" = "running";
  currentTime = 0;
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  resume() { this.state = "running"; return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamDestination() { return { stream: {} }; }
  createAnalyser() { return { fftSize: 0, frequencyBinCount: 8, smoothingTimeConstant: 0 }; }
  createBuffer(_c: number, n: number, rate: number) { return { duration: n / rate, getChannelData: () => new Float32Array(n) }; }
  createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {}, onended: null }; }
}
const g = globalThis as Record<string, unknown>;
g.AudioContext = FakeContext;
g.document = { createElement: () => ({ setAttribute() {}, style: {}, play: () => Promise.resolve() }), body: { appendChild() {} } };

test("flush over a held reply leaves the clock running, not suspended until the next reply", () => {
  const p = new AudioPlayer();
  p.play(new Float32Array(2400), 0);
  const ctx = (p as unknown as { ctx: FakeContext }).ctx;
  p.hold();
  assert.equal(ctx.state, "suspended");
  p.flush(1);
  assert.equal(ctx.state, "running");
  assert.equal(p.playing(), false);
  p.hold(); p.release();
  assert.equal(ctx.state, "running");
});
