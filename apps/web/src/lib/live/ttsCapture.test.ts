import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePart, captureEvent, nextCaptureReply, type PartMeta } from "./ttsCapture";

const meta = (over: Partial<PartMeta> = {}): PartMeta => ({
  reply: nextCaptureReply(), chunk: 0, piece: 0, epoch: 0, outOfBand: false, said: "Hello there.", spoken: "Hello there.", askedAt: 1, sampleRate: 24000,
  voice: { engine: "kokoro", family: "kokoro", voice: "af_heart", speed: 1, lang: "en" },
  source: { route: "agent", engine: "kokoro-native", fallback: false }, ...over,
});
const at = (startAt: number, prevEnd: number) => ({ startAt, now: startAt - 0.05, prevEnd, held: false, rate: 48000, baseLatency: 0.01, outputLatency: undefined });

const calls = () => vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: String(url), body: init?.body }));
const manifest = () => {
  const last = calls().filter((c) => c.url.endsWith("manifest.json")).at(-1)!;
  return JSON.parse(String(last.body)) as { pieces: Record<string, unknown>[]; events: Record<string, unknown>[] };
};

let flag: string | null, host: string;
beforeEach(() => {
  flag = "tts"; host = "localhost";
  vi.stubGlobal("localStorage", { getItem: () => flag });
  vi.stubGlobal("location", { get hostname() { return host; } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("ttsCapture", () => {
  it("does nothing unless the flag holds tts and the page is local", () => {
    for (const [f, h] of [[null, "localhost"], ["1", "localhost"], ["tts", "example.com"]] as const) {
      flag = f; host = h;
      capturePart(meta(), new Float32Array(10), at(1, 0));
    }
    vi.advanceTimersByTime(1000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends each piece's PCM and a manifest with its gap, underrun and route", () => {
    const m = meta();
    capturePart(m, new Float32Array(24000), at(1, 0));
    capturePart({ ...m, chunk: 1 }, new Float32Array(2400), at(3.2, 2));
    captureEvent("flush", 4);
    vi.advanceTimersByTime(1000);
    expect(calls().filter((c) => c.url.endsWith(".f32")).length).toBe(2);
    const { pieces, events } = manifest();
    expect(pieces[0]).toMatchObject({ n: 0, gap: null, underrun: false, route: "agent", usedEngine: "kokoro-native", samples: 24000, durationS: 1 });
    expect(pieces[1]).toMatchObject({ n: 1, chunk: 1, prevEnd: 2, underrun: true });
    expect(pieces[1]!.gap).toBeCloseTo(1.2);
    expect(events).toMatchObject([{ kind: "flush", ctxTime: 4 }]);
  });

  it("numbers parts within a piece, uploads four PCM at a time and queues the rest", async () => {
    const done: (() => void)[] = [];
    vi.mocked(fetch).mockImplementation((url) => String(url).endsWith(".f32") ? new Promise((r) => done.push(() => r(new Response("{}")))) : Promise.resolve(new Response("{}")));
    const pcm = () => calls().filter((c) => c.url.endsWith(".f32")).length;
    const m = meta();
    for (let i = 0; i < 12; i++) capturePart(m, new Float32Array(10), at(1 + i, i));
    vi.advanceTimersByTime(1000);
    expect(pcm()).toBe(4);
    expect(manifest().pieces.map((p) => p.part)).toEqual([...Array(12).keys()]);
    expect(manifest().pieces.every((p) => p.pcm !== null)).toBe(true);
    while (done.length) { done.shift()!(); await vi.advanceTimersByTimeAsync(0); }
    expect(pcm()).toBe(12);
  });

  it("records no PCM past the queue's memory budget, and goes on once it drains", async () => {
    const done: (() => void)[] = [];
    vi.mocked(fetch).mockImplementation((url) => String(url).endsWith(".f32") ? new Promise((r) => done.push(() => r(new Response("{}")))) : Promise.resolve(new Response("{}")));
    const m = meta(), big = new Float32Array(4 * 1024 * 1024); // 16 MB: four in flight, four queued fill the 64 MB budget
    for (let i = 0; i < 10; i++) capturePart(m, big, at(1 + i, i));
    vi.advanceTimersByTime(1000);
    expect(manifest().pieces.map((p) => p.pcm !== null)).toEqual([...Array(8).fill(true), false, false]);
    while (done.length) { done.shift()!(); await vi.advanceTimersByTimeAsync(0); }
    capturePart(m, big, at(20, 19));
    vi.advanceTimersByTime(1000);
    expect(manifest().pieces.at(-1)!.pcm).not.toBeNull();
    while (done.length) { done.shift()!(); await vi.advanceTimersByTimeAsync(0); }
  });

  it("ignores audio the player refused", () => {
    capturePart(meta(), new Float32Array(10), undefined);
    vi.advanceTimersByTime(1000);
    expect(fetch).not.toHaveBeenCalled();
  });
});
