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
  createBiquadFilter() { return { type: "", frequency: { value: 0 }, connect() {} }; }
  sources: { to: unknown[]; startAt?: number; stopAt?: number }[] = [];
  createBufferSource() {
    const src = { to: [] as unknown[], startAt: undefined as number | undefined, stopAt: undefined as number | undefined, buffer: null, onended: null,
      connect(n: unknown) { src.to.push(n); }, start(t: number) { src.startAt = t; }, stop(t?: number) { src.stopAt = t; } };
    this.sources.push(src);
    return src;
  }
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

test("each chunk stops exactly at its end, goes through the DC block, and ahead() counts what is left", () => {
  const p = new AudioPlayer();
  p.play(new Float32Array(24000), 0);
  p.play(new Float32Array(12000), 0);
  const ctx = (p as unknown as { ctx: FakeContext; dcBlock: unknown }).ctx;
  const [a, b] = ctx.sources;
  assert.equal(a!.startAt, 0.02);
  assert.equal(a!.stopAt, 1.02);
  assert.equal(b!.startAt, 1.02);
  assert.equal(b!.stopAt, 1.52);
  assert.deepEqual(a!.to, [(p as unknown as { dcBlock: unknown }).dcBlock]);
  ctx.currentTime = 0.52;
  assert.equal(p.ahead(), 1);
  p.flush(1);
  assert.equal(p.ahead(), 0);
});
