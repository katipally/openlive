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

/** A /tts response that streams `chunks` and then ends. */
const spoken = (chunks: Float32Array[]) => new Response(new ReadableStream<Uint8Array>({
  start(ctrl) { for (const c of chunks) ctrl.enqueue(new Uint8Array(c.buffer)); ctrl.close(); },
}), { headers: { "x-sample-rate": "24000" } });
const bodyOf = (f: ReturnType<typeof vi.fn>, i: number) => JSON.parse((f.mock.calls[i]![1] as RequestInit).body as string);

describe("native TTS stall", () => {
  it("tries the same voice again when no audio arrives in time, then leaves the sentence unspoken", async () => {
    const fetch = stalledTts([]);
    vi.stubGlobal("fetch", fetch);
    const got: number[] = [];
    const opts = { engine: "pocket", voice: "bria", lang: "en" as const };
    const done = models.ttsStream("Hello there.", opts, (a) => got.push(a.length));
    const stallMs = 4000 + 50 * "Hello there.".length;
    await vi.advanceTimersByTimeAsync(stallMs - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((fetch.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetch, 1)).toEqual(bodyOf(fetch, 0));
    await vi.advanceTimersByTimeAsync(stallMs);
    await done;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(got).toEqual([]);
    expect(posted.some((m) => m.type === "tts")).toBe(false); // never another voice
    expect(toast).not.toHaveBeenCalled();
    // The engine is still tried next time.
    const again = models.ttsStream("Again.", opts, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    await again;
  });

  it("speaks a sentence in the same voice after a 500", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(spoken([new Float32Array([0.1, 0.2, 0.3])]));
    vi.stubGlobal("fetch", fetch);
    const got: number[] = [];
    await models.ttsStream("Hello there.", { engine: "kitten", voice: "luna", lang: "en" }, (a) => got.push(a.length));
    expect(got).toEqual([3]);
    expect(bodyOf(fetch, 1)).toMatchObject({ engine: "kitten", voice: "luna" });
    expect(posted.some((m) => m.type === "tts")).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("counts the stall from when the agent starts, not from a queued or cold start", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 8000)); // a cold load, or a warm-up queued ahead
      return new Response(new ReadableStream<Uint8Array>({
        start(ctrl) {
          setTimeout(() => { ctrl.enqueue(new Uint8Array(new Float32Array([0.5, 0.5]).buffer)); ctrl.close(); }, 2000);
          init.signal?.addEventListener("abort", () => ctrl.error(init.signal!.reason));
        },
      }), { headers: { "x-sample-rate": "24000" } });
    });
    vi.stubGlobal("fetch", fetch);
    const got: number[] = [];
    const done = models.ttsStream("Hi.", { engine: "pocket" }, (a) => got.push(a.length));
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(got).toEqual([2]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a lasting failure switches the call to the browser voice once, with one toast, and never back", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "engine-not-installed" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const got: number[] = [];
    await models.ttsStream("One.", { engine: "pocket", lang: "en" }, (a) => got.push(a.length));
    await models.ttsStream("Two.", { engine: "pocket", lang: "en" }, (a) => got.push(a.length));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(posted.filter((m) => m.type === "tts").map((m) => m.engine)).toEqual(["kokoro", "kokoro"]);
    expect(got).toEqual([2, 2]);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("switches the call to the browser voice once the engine never starts on two sentences in a row", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    vi.stubGlobal("fetch", fetch);
    const got: number[] = [];
    const opts = { engine: "pocket", lang: "en" as const };
    const one = models.ttsStream("One.", opts, (a) => got.push(a.length));
    await vi.advanceTimersByTimeAsync(20_000);
    await one;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(got).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
    const two = models.ttsStream("Two.", opts, (a) => got.push(a.length));
    await vi.advanceTimersByTimeAsync(20_000);
    await two;
    await models.ttsStream("Three.", opts, (a) => got.push(a.length));
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(posted.filter((m) => m.type === "tts").map((m) => m.engine)).toEqual(["kokoro", "kokoro"]);
    expect(got).toEqual([2, 2]);
    expect(toast).toHaveBeenCalledTimes(1);
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

describe("no voice for the language", () => {
  it("says so once per call, and again on the next call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "engine-not-installed" }, { status: 409 })));
    await models.ttsStream("One.", { engine: "pocket", lang: "zh" }, () => {});
    await models.ttsStream("Two.", { engine: "pocket", lang: "zh" }, () => {});
    expect(toast).toHaveBeenCalledTimes(1);
    models.resetNativeFallbacks();
    await models.ttsStream("Three.", { engine: "pocket", lang: "zh" }, () => {});
    expect(toast).toHaveBeenCalledTimes(2);
  });
});

describe("keep-warm", () => {
  it("sends no warm-up for an engine that just served a real sentence, and one after a quiet minute", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ stt: { engine: "whisper" }, tts: { engine: "pocket" } }), setItem: () => {} });
    const fetch = vi.fn(async () => spoken([new Float32Array([0.1])]));
    vi.stubGlobal("fetch", fetch);
    await models.ttsStream("Hello.", { engine: "pocket-int8" }, () => {});
    models.warmNativeEngines();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    models.warmNativeEngines();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetch, 1)).toMatchObject({ engine: "pocket-int8", text: "Hi." });
  });
});

describe("cloned voice", () => {
  it("tries the cloned voice again after a 500 instead of reading one sentence in another voice", async () => {
    const pcm = new Float32Array([0.1, 0.2, 0.3]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(new Response(pcm.buffer, { headers: { "x-sample-rate": "24000" } }));
    vi.stubGlobal("fetch", fetch);
    const out = await models.tts("Hello.", { engine: "clone", voice: "p1", lang: "en" });
    expect(out.audio.length).toBe(3);
    expect(bodyOf(fetch, 1)).toMatchObject({ profileId: "p1" });
    expect(posted.some((m) => m.type === "tts")).toBe(false);
  });

  it("a deleted profile switches the call to the browser voice once", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "profile-missing" }, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await models.tts("One.", { engine: "clone", voice: "p1", lang: "en" });
    await models.tts("Two.", { engine: "clone", voice: "p1", lang: "en" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(posted.filter((m) => m.type === "tts").map((m) => m.engine)).toEqual(["kokoro", "kokoro"]);
    expect(toast).toHaveBeenCalledTimes(1);
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
