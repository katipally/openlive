import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The native-engine routing in models.ts against a stubbed fetch and a stand-in
// model worker that answers as the real one would.
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ toast }));
vi.mock("@/lib/log", () => ({ log: { error: () => {}, warn: () => {}, debug: () => {} } }));

const posted: Array<{ type: string; [k: string]: unknown }> = [];
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage(m: { type: string; id?: number }) {
    posted.push(m);
    const reply = (data: unknown) => queueMicrotask(() => this.onmessage?.({ data, target: this } as { data: unknown }));
    if (m.type === "load") reply({ type: "ready", turn: true, whisper: false });
    else if (m.type === "stt") reply({ type: "result", id: m.id, text: "from whisper" });
    else if (m.type === "tts") reply({ type: "result", id: m.id, audio: new Float32Array([0.1, 0.2]), sampleRate: 24000 });
  }
  terminate() {}
}

/** A streamed /tts response: `chunks` arrive, then it hangs until aborted, as a stalled agent would. */
function stalledTts(chunks: Float32Array[]) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(new Uint8Array(c.buffer));
        init.signal?.addEventListener("abort", () => ctrl.error(init.signal!.reason));
      },
    });
    return new Response(body, { headers: { "x-sample-rate": "24000" } });
  });
}

let models: typeof import("./models");
beforeEach(async () => {
  posted.length = 0;
  toast.mockClear();
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  vi.resetModules();
  models = await import("./models");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("native TTS stall", () => {
  it("falls back to Kokoro for this sentence when no audio arrives in time, without latching", async () => {
    const fetch = stalledTts([]);
    vi.stubGlobal("fetch", fetch);
    const got: number[] = [];
    const done = models.ttsStream("Hello there.", { engine: "pocket" }, (a) => got.push(a.length));
    const stallMs = 4000 + 50 * "Hello there.".length;
    await vi.advanceTimersByTimeAsync(stallMs - 1);
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect((fetch.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(true);
    expect(posted.find((m) => m.type === "tts")).toMatchObject({ text: "Hello there.", engine: "kokoro" });
    expect(got).toEqual([2]);
    expect(toast).not.toHaveBeenCalled();
    // The engine is still tried next time.
    const again = models.ttsStream("Again.", { engine: "pocket" }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await again;
  });

  it("ends a sentence quietly when audio stops arriving mid-stream", async () => {
    vi.stubGlobal("fetch", stalledTts([new Float32Array([0.5, 0.5, 0.5])]));
    const got: number[] = [];
    const done = models.ttsStream("Hello there.", { engine: "kitten" }, (a) => got.push(a.length));
    await vi.advanceTimersByTimeAsync(4000 + 50 * "Hello there.".length);
    await done;
    expect(got).toEqual([3]);
    expect(posted.some((m) => m.type === "tts")).toBe(false);
  });

  it("leaves a barge-in abort to the caller: no fallback", async () => {
    vi.stubGlobal("fetch", stalledTts([]));
    const cut = new AbortController();
    const done = models.ttsStream("Hello there.", { engine: "pocket" }, () => {}, cut.signal);
    cut.abort();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(posted.some((m) => m.type === "tts")).toBe(false);
  });
});

describe("native STT fallback", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ stt: { engine: "parakeet" }, tts: { engine: "kitten" } }), setItem: () => {} });
  });

  it("loads the worker on demand and transcribes the same utterance with Whisper", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "boom" }, { status: 500 })));
    const audio = new Float32Array(1600);
    await expect(models.stt(audio)).resolves.toBe("from whisper");
    expect(posted.find((m) => m.type === "load" && "whisper" in m)).toMatchObject({ whisper: false, ttsNative: true });
    expect(posted.at(-1)).toMatchObject({ type: "stt", audio });
  });

  it("an aborted request rejects and never falls back", async () => {
    const cut = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      cut.abort();
      throw init.signal!.reason;
    }));
    await expect(models.stt(new Float32Array(1600), cut.signal)).rejects.toThrow();
    expect(posted).toEqual([]);
  });
});

describe("modelsCached", () => {
  it("asks for nothing after a switch to native engines when Smart-Turn already loaded", () => {
    const store: Record<string, string> = {
      "openlive-pipeline-v1": JSON.stringify({ stt: { engine: "parakeet" }, tts: { engine: "kitten" } }),
      "openlive-models-ready-v1": "wasm:tiny:kokoro",
    };
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: () => {} });
    expect(models.modelsCached()).toBe(true);
  });
});
