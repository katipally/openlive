import { describe, it, expect, beforeEach, vi } from "vitest";
import { hubUrl, voiceWeights, whisperWeights, TURN_WEIGHTS } from "./weights";

// The model workers are the one place weights are fetched, so they hold the
// line themselves: with the cache empty, no message of any type loads a model
// whose files the person did not agree to, and each says what it refused.

const loaders = vi.hoisted(() => ({
  whisper: vi.fn(async () => Object.assign(async () => ({ text: "hi" }), { dispose: () => {} })),
  kokoro: vi.fn(async () => ({ generate: async () => ({ audio: new Float32Array(2), sampling_rate: 24000 }) })),
  supertonic: vi.fn(async () => ({ sampleRate: 44100, synthesize: async () => new Float32Array(2) })),
  turnProcessor: vi.fn(async () => async () => ({ input_features: { data: new Float32Array(80 * 800), dims: [1, 80, 800] } })),
  turnSession: vi.fn(async () => ({ inputNames: ["x"], outputNames: ["y"], run: async () => ({ y: { data: [0.9] } }) })),
}));
vi.mock("@huggingface/transformers", () => ({
  env: {}, LogLevel: { ERROR: 40 }, pipeline: loaders.whisper, AutoProcessor: { from_pretrained: loaders.turnProcessor },
}));
vi.mock("kokoro-js", () => ({ KokoroTTS: { from_pretrained: loaders.kokoro } }));
vi.mock("onnxruntime-web", () => ({ env: { wasm: {} } }));
vi.mock("onnxruntime-web/wasm", () => ({ env: { wasm: {} }, InferenceSession: { create: loaders.turnSession }, Tensor: class {} }));
vi.mock("./supertonic", () => ({ loadSupertonic: loaders.supertonic }));

type Msg = Record<string, unknown>;
const posted: Msg[] = [];
let handler: (e: { data: Msg }) => Promise<void>;

/** A fresh copy of `worker`'s module with an empty cache, and its message handler. */
async function load(worker: "./models.worker" | "./turn.worker") {
  vi.resetModules();
  posted.length = 0;
  for (const l of Object.values(loaders)) l.mockClear();
  const self = { postMessage: (m: Msg) => posted.push(m), onmessage: null as unknown };
  vi.stubGlobal("self", self);
  vi.stubGlobal("caches", { match: async () => undefined, open: async () => ({ match: async () => undefined, add: async () => {} }) });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  await import(worker);
  handler = self.onmessage as typeof handler;
}

const WHISPER = "onnx-community/whisper-base";
const urls = (files: { repo: string; path: string }[]) => files.map((f) => hubUrl(f.repo, f.path));
const refusals = () => posted.filter((m) => m.type === "error" && Array.isArray(m.missing));

describe("the model worker refuses a download nobody agreed to", () => {
  beforeEach(() => load("./models.worker"));

  const cases: [string, Msg][] = [
    ["load, Whisper and Kokoro", { type: "load", device: "wasm", whisper: true, whisperModel: WHISPER, ttsEngine: "kokoro", lang: "en" }],
    ["load, Supertonic", { type: "load", device: "wasm", whisper: false, ttsEngine: "supertonic", lang: "en" }],
    ["stt, a language switch or a Whisper stand-in", { type: "stt", id: 1, audio: new Float32Array(1600), lang: "fr", model: WHISPER }],
    ["tts, a switch to Kokoro", { type: "tts", id: 2, text: "Hi.", engine: "kokoro" }],
    ["tts, a switch to Supertonic", { type: "tts", id: 3, text: "Hi.", engine: "supertonic" }],
  ];
  for (const [name, msg] of cases) {
    it(name, async () => {
      await handler({ data: { ...msg, allow: [] } });
      expect(loaders.whisper).not.toHaveBeenCalled();
      expect(loaders.kokoro).not.toHaveBeenCalled();
      expect(loaders.supertonic).not.toHaveBeenCalled();
      expect(refusals()).toHaveLength(1);
      expect(posted.some((m) => m.type === "ready" || m.type === "result")).toBe(false);
    });
  }

  it("with no allow list at all, as an older page would send", async () => {
    await handler({ data: { type: "tts", id: 4, text: "Hi.", engine: "kokoro" } });
    expect(loaders.kokoro).not.toHaveBeenCalled();
    expect(refusals()).toHaveLength(1);
  });

  it("names exactly the files it would have fetched", async () => {
    await handler({ data: { type: "tts", id: 5, text: "Hi.", engine: "supertonic", allow: [] } });
    expect(urls(refusals()[0]!.missing as never)).toEqual(urls(voiceWeights("supertonic", "wasm")));
  });

  it("loads what was agreed to", async () => {
    await handler({ data: { type: "stt", id: 6, audio: new Float32Array(1600), lang: "en", model: WHISPER, allow: urls(whisperWeights(WHISPER, "wasm")) } });
    expect(loaders.whisper).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual(expect.objectContaining({ type: "result", id: 6 }));
  });
});

describe("the turn worker refuses a download nobody agreed to", () => {
  beforeEach(() => load("./turn.worker"));

  it("loads without Smart-Turn, so the call falls back to silence", async () => {
    await handler({ data: { type: "load", allow: [] } });
    expect(loaders.turnSession).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: "ready", turn: false });
  });

  it("loads it once agreed to", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ArrayBuffer(8))));
    await handler({ data: { type: "load", allow: urls(TURN_WEIGHTS) } });
    expect(loaders.turnSession).toHaveBeenCalledTimes(1);
  });
});
