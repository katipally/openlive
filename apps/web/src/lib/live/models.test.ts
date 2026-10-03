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
  // Every weight already in the browser cache, unless a test says otherwise.
  vi.stubGlobal("caches", { match: async () => new Response("") });
  vi.resetModules();
  models = await import("./models");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
/** The voice pipeline as saved, in the prefs module this test's `models` reads. */
const savedPipeline = async (pipeline: Record<string, unknown>) => (await import("../prefs")).useVoicePrefs.setState({ pipeline });

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

describe("a browser voice the agent runs", () => {
  const listing = (installed: boolean, runnable = true) => Response.json([
    { family: "kitten", kind: "tts", name: "Kitten TTS", variants: [{ id: "kitten-nano-int8", installed: true, runnable: true }] },
    { family: "supertonic", kind: "tts", name: "Supertonic", browser: "supertonic", variants: [{ id: "supertonic-3", installed, runnable }] },
  ]);
  /** The agent's engine listing from `list`, every /tts from `speak`. */
  const agent = (speak: () => Promise<Response>, list = () => listing(true)) =>
    vi.fn(async (url: string) => (url === "/api/voice/engines" ? list() : speak()));
  const ttsCalls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter((c) => c[0] === "/api/voice/tts").length;
  const opts = { engine: "supertonic", voice: "F2", speed: 1.2, lang: "es" as const };

  it("streams from the agent in the same voice, and loads nothing in the browser", async () => {
    const fetch = agent(async () => spoken([new Float32Array([0.1, 0.2, 0.3])]));
    vi.stubGlobal("fetch", fetch);
    const got: number[] = [];
    await models.ttsStream("Hola.", opts, (a) => got.push(a.length));
    await models.ttsStream("Otra.", opts, (a) => got.push(a.length));
    expect(got).toEqual([3, 3]);
    expect(bodyOf(fetch, 1)).toEqual({ engine: "supertonic-3", text: "Hola.", voice: "F2", speed: 1.2, lang: "es" });
    expect(fetch.mock.calls.filter((c) => c[0] === "/api/voice/engines")).toHaveLength(1); // asked once a call
    expect(posted).toEqual([]);
  });

  it("tries the agent again after a one-off failure rather than switching voice mid-reply", async () => {
    const speak = vi.fn().mockResolvedValueOnce(Response.json({ error: "boom" }, { status: 500 })).mockResolvedValueOnce(spoken([new Float32Array([0.5])]));
    vi.stubGlobal("fetch", agent(speak));
    const got: number[] = [];
    await models.ttsStream("Hola.", opts, (a) => got.push(a.length));
    expect(got).toEqual([1]);
    expect(posted.some((m) => m.type === "tts")).toBe(false);
  });

  it("gives way to the same voice in the browser on a lasting failure, quietly, for the rest of the call", async () => {
    const fetch = agent(async () => Response.json({ error: "engine-not-runnable" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await models.ttsStream("Uno.", opts, () => {});
    await models.ttsStream("Dos.", opts, () => {});
    expect(ttsCalls(fetch)).toBe(1);
    expect(posted.filter((m) => m.type === "tts").map((m) => [m.engine, m.voice])).toEqual([["supertonic", "F2"], ["supertonic", "F2"]]);
    expect(toast).not.toHaveBeenCalled();
    models.resetNativeFallbacks(); // the next call tries the agent again
    await models.ttsStream("Tres.", opts, () => {});
    expect(ttsCalls(fetch)).toBe(2);
  });

  it("speaks in the browser when the agent's copy is not downloaded, cannot run here, or no agent answers", async () => {
    for (const list of [() => listing(false), () => listing(true, false), () => Promise.reject(new TypeError("fetch failed"))]) {
      posted.length = 0;
      const fetch = agent(async () => spoken([]), list);
      vi.stubGlobal("fetch", fetch);
      models.resetNativeFallbacks();
      const got: number[] = [];
      await models.ttsStream("Hola.", opts, (a) => got.push(a.length));
      expect(got).toEqual([2]);
      expect(ttsCalls(fetch)).toBe(0);
      expect(posted.filter((m) => m.type === "tts").map((m) => m.engine)).toEqual(["supertonic"]);
    }
  });

  it("loads no browser Supertonic for a call the agent speaks, and does once its copy is gone", async () => {
    vi.stubGlobal("window", {});
    await savedPipeline({ stt: { engine: "parakeet" }, tts: { engine: "supertonic" } });
    let installed = true;
    vi.stubGlobal("fetch", agent(async () => spoken([]), () => listing(installed)));
    await models.loadModels(() => {});
    expect(posted.find((m) => m.type === "load")).toMatchObject({ ttsEngine: null, ttsNative: true });
    posted.length = 0;
    installed = false;
    models.resetNativeFallbacks();
    await models.loadModels(() => {});
    expect(posted.find((m) => m.type === "load")).toMatchObject({ ttsEngine: "supertonic", ttsNative: false });
  });

  it("never asks the agent about a browser voice it does not run", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await models.ttsStream("Hello.", { engine: "kokoro", lang: "en" }, () => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(posted.filter((m) => m.type === "tts").map((m) => m.engine)).toEqual(["kokoro"]);
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
    await savedPipeline({ stt: { engine: "whisper" }, tts: { engine: "pocket" } });
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
  beforeEach(async () => {
    vi.stubGlobal("window", {});
    await savedPipeline({ stt: { engine: "parakeet" }, tts: { engine: "kitten" } });
  });

  it("loads the worker on demand and transcribes the same utterance with Whisper", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "boom" }, { status: 500 })));
    const audio = new Float32Array(1600);
    const heard = await models.stt(audio);
    expect(heard.text).toBe("from whisper");
    expect(heard.at).toHaveLength(2); // Whisper times no words: placed on the audio
    expect(posted.find((m) => m.type === "load" && "whisper" in m)).toMatchObject({ whisper: false, ttsNative: true });
    expect(posted.at(-1)).toMatchObject({ type: "stt", audio });
  });

  it("waits out a slow native engine rather than falling back to a Whisper that is not loaded yet", async () => {
    // Node's own timeout signal runs on a clock the fake timers do not move.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new DOMException("signal timed out", "TimeoutError")), ms);
      return ac.signal;
    });
    /** Answers after `ms` (never, for null), or rejects when its request is aborted first. */
    const slow = (ms: number | null) => vi.fn((_u: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const t = ms === null ? undefined : setTimeout(() => resolve(Response.json({ text: "from native" })), ms);
      init.signal!.addEventListener("abort", () => { clearTimeout(t); reject(init.signal!.reason); });
    }));
    vi.stubGlobal("fetch", slow(20_000));
    const heard = models.stt(new Float32Array(1600));
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await heard).text).toBe("from native");
    expect(posted.some((m) => m.type === "stt")).toBe(false);

    // A native engine that never answers still gives way, so the utterance is heard.
    vi.stubGlobal("fetch", slow(null));
    const late = models.stt(new Float32Array(1600));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await late).text).toBe("from whisper");
    timeout.mockRestore();
  });

  it("keeps the engine's word onsets, each 50 s window's from its own start", async () => {
    const replies = [{ text: "one two", at: [100, 400] }, { text: "three", at: [50] }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(replies.shift())));
    expect(await models.stt(new Float32Array(16000 * 60))).toEqual({ text: "one two three", at: [100, 400, 50_050] });
  });

  it("places the words on the audio when a window comes back untimed", async () => {
    const replies = [{ text: "one two", at: [100, 400] }, { text: "three" }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(replies.shift())));
    const audio = new Float32Array(16000 * 60);
    audio.fill(0.3, 16000, 16000 * 2);
    const heard = await models.stt(audio);
    expect(heard.text).toBe("one two three");
    expect(heard.at).toHaveLength(3);
    expect(heard.at[0]).toBe(1000); // where the voice begins, not the engine's 100
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
  it("asks for nothing after a switch to native engines when Smart-Turn already loaded", async () => {
    const store: Record<string, string> = { "openlive-models-ready-v1": "wasm:tiny:kokoro" };
    await savedPipeline({ stt: { engine: "parakeet" }, tts: { engine: "kitten" } });
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: () => {} });
    expect(models.modelsCached()).toBe(true);
  });
});

describe("download consent", () => {
  const empty = () => vi.stubGlobal("caches", { match: async () => undefined });

  it("never downloads weights nobody agreed to: a start, a warm-up or a fallback refuses instead", async () => {
    empty();
    for (const trigger of ["call_start", "launch_warm", "flow_open"] as const) {
      await expect(models.loadModels(() => {}, trigger)).rejects.toBeInstanceOf(models.ModelsNotDownloaded);
    }
    await expect(models.stt(new Float32Array(1600))).rejects.toBeInstanceOf(models.ModelsNotDownloaded);
    expect(posted).toEqual([]);
  });

  it("downloads once agreed to, and a refusing load in flight does not swallow the yes", async () => {
    empty();
    const refused = models.loadModels(() => {}, "launch_warm");
    const agreed = models.loadModels(() => {}, "lobby_button", true);
    await expect(refused).rejects.toBeInstanceOf(models.ModelsNotDownloaded);
    await agreed;
    expect(posted.filter((m) => m.type === "load")).toHaveLength(2); // the model worker and the turn worker
    expect(models.modelsReady()).toBe(true);
  });

  it("warms up without asking when every weight is cached", async () => {
    await models.loadModels(() => {}, "launch_warm");
    expect(models.modelsReady()).toBe(true);
  });

  it("plans the download from what the cache lacks, sized by the hub's listing", async () => {
    const held = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx";
    vi.stubGlobal("caches", { match: async (url: string) => (url === held ? new Response("") : undefined) });
    const fetch = vi.fn(async (url: string) => Response.json(url.includes("Kokoro")
      ? [{ path: "onnx/model_quantized.onnx", size: 134, lfs: { size: 92_361_116 } }]
      : [{ path: "onnx/encoder_model_quantized.onnx", size: 23_201_320 }, { path: "onnx/decoder_model_merged_quantized.onnx", size: 53_692_803 }]));
    vi.stubGlobal("fetch", fetch);
    const plan = await models.voiceDownloadPlan();
    expect(plan.missing.map((f) => f.key)).toEqual(["stt", "stt", "tts"]);
    expect(plan.bytes).toBe(23_201_320 + 53_692_803 + 92_361_116);
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith("https://huggingface.co/api/models/"))).toBe(true);
    // A file at the repo's root is listed without a trailing slash, which the hub answers with a redirect.
    empty();
    fetch.mockImplementation(async () => Response.json([{ path: "smart-turn-v3.2-cpu.onnx", size: 8_679_182 }]));
    await models.voiceDownloadPlan();
    expect(fetch.mock.calls.map(([url]) => url)).toContain("https://huggingface.co/api/models/pipecat-ai/smart-turn-v3/tree/main");
  });

  it("still plans, with no size, when the hub cannot be reached", async () => {
    empty();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await models.voiceDownloadPlan()).toMatchObject({ bytes: null });
  });
});

describe("downloadModel", () => {
  const lines = (...ls: object[]) => new Response(ls.map((l) => JSON.stringify(l) + "\n").join(""));

  it("reports progress and resolves once the agent says done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => lines({ loaded: 5, total: 10 }, { loaded: 10, total: 10, done: true })));
    const seen: number[] = [];
    await models.downloadModel("/api/voice/model/download", (l, t) => seen.push(l / t));
    expect(seen).toEqual([0.5, 1]);
  });

  it("throws when the agent refuses, instead of reporting an install", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "already downloading" }, { status: 409 })));
    await expect(models.downloadModel("/api/voice/model/download", () => {})).rejects.toThrow("already downloading");
  });

  it("throws on a failure line and on a stream that ends early", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => lines({ loaded: 1, total: 10 }, { error: "vocoder download HTTP 404" })));
    await expect(models.downloadModel("/api/voice/model/download", () => {})).rejects.toThrow("vocoder download HTTP 404");
    vi.stubGlobal("fetch", vi.fn(async () => lines({ loaded: 1, total: 10 })));
    await expect(models.downloadModel("/api/voice/engines/x/download", () => {})).rejects.toThrow("download ended early");
  });
});

describe("voice models result", () => {
  const track = vi.fn();
  const store: Record<string, string> = {};
  const uiStorage = () => vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
  const results = () => track.mock.calls.filter(([name]) => name === "voice_models_result").map(([, props]) => props);
  const steps = () => track.mock.calls.filter(([name]) => name === "onboarding_step").map(([, props]) => props);
  beforeEach(() => {
    track.mockReset();
    for (const k of Object.keys(store)) delete store[k];
    vi.stubGlobal("window", { openlive: { telemetry: { track } } });
    uiStorage();
  });

  /** A worker that reports `bytes` of downloading, then is ready. */
  const downloading = (bytes: number) => class extends FakeWorker {
    override postMessage(m: { type: string; id?: number }) {
      if (m.type === "load") queueMicrotask(() => this.onmessage?.({ data: { type: "progress", data: { file: "a.onnx", model: "stt", loaded: bytes, total: bytes } }, target: this } as { data: unknown }));
      super.postMessage(m);
    }
  };

  it("reports a download with its size in 10 MB steps, and the voice models becoming ready", async () => {
    vi.stubGlobal("Worker", downloading(293_000_000));
    await models.loadModels(() => {}, "lobby_button");
    expect(results()).toEqual([{ trigger: "lobby_button", result: "ok", duration_s: 0, mb: 290, stt_family: "whisper", tts_family: "kokoro", webgpu: false }]);
    expect(steps()).toEqual([{ step: "voice_models_ready" }]);
  });

  it("stays silent about a warm-up of weights already in the cache, but still marks the models ready", async () => {
    await models.loadModels(() => {});
    track.mockClear();
    vi.resetModules();
    models = await import("./models");
    await models.loadModels(() => {}, "launch_warm");
    expect(results()).toEqual([]);
    expect(steps()).toEqual([{ step: "voice_models_ready" }]);
  });

  it("reports a failure, as offline when the network is gone", async () => {
    class Broken extends FakeWorker {
      override postMessage(m: { type: string }) { if (m.type === "load") queueMicrotask(() => this.onmessage?.({ data: { type: "error", message: "fetch failed for https://host/secret" }, target: this } as { data: unknown })); }
    }
    vi.stubGlobal("Worker", Broken);
    await expect(models.loadModels(() => {}, "settings")).rejects.toThrow();
    vi.stubGlobal("navigator", { onLine: false });
    vi.resetModules();
    models = await import("./models");
    await expect(models.loadModels(() => {}, "call_start")).rejects.toThrow();
    expect(results().map((r) => [r.trigger, r.result])).toEqual([["settings", "failed"], ["call_start", "offline"]]);
    expect(steps()).toEqual([]);
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/secret|host/);
  });
});
