import { describe, expect, it } from "vitest";
import { mergePipelineConfig } from "./pipelineConfig";
import { aboutSize, listed, missingWeights, planModels, weightFiles } from "./weights";

const cfg = (stt: string, tts: string, whisperSize = "base", language = "en") =>
  mergePipelineConfig({ language, stt: { engine: stt, whisperSize }, tts: { engine: tts } });
const paths = (fs: { repo: string; path: string }[]) => fs.map((f) => `${f.repo}/${f.path}`);

describe("weightFiles", () => {
  it("lists the files the worker loads, in the dtype each tier asks for", () => {
    expect(paths(weightFiles(cfg("whisper", "kokoro"), "webgpu", "kokoro"))).toEqual([
      "onnx-community/whisper-base.en/onnx/encoder_model.onnx",
      "onnx-community/whisper-base.en/onnx/decoder_model_merged.onnx",
      "onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx",
      "pipecat-ai/smart-turn-v3/smart-turn-v3.2-cpu.onnx",
    ]);
    expect(paths(weightFiles(cfg("whisper", "kokoro", "small", "fr"), "wasm", "kokoro")).slice(0, 3)).toEqual([
      "onnx-community/whisper-tiny/onnx/encoder_model_quantized.onnx",
      "onnx-community/whisper-tiny/onnx/decoder_model_merged_quantized.onnx",
      "onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx",
    ]);
  });

  it("splits large-v3-turbo into an fp16 encoder and a q4 decoder", () => {
    expect(paths(weightFiles(cfg("whisper", "kokoro", "large-v3-turbo"), "webgpu", null))).toEqual([
      "onnx-community/whisper-large-v3-turbo/onnx/encoder_model_fp16.onnx",
      "onnx-community/whisper-large-v3-turbo/onnx/decoder_model_merged_q4.onnx",
      "pipecat-ai/smart-turn-v3/smart-turn-v3.2-cpu.onnx",
    ]);
  });

  it("downloads nothing for a native engine, and Supertonic's four parts for it", () => {
    const files = weightFiles(cfg("parakeet", "supertonic"), "webgpu", "supertonic");
    expect(files.map((f) => f.key)).toEqual(["tts", "tts", "tts", "tts", "turn"]);
    expect(weightFiles(cfg("parakeet", "pocket"), "webgpu", null).map((f) => f.key)).toEqual(["turn"]);
  });
});

describe("missingWeights", () => {
  it("keeps what the cache lacks, and everything without a Cache API", async () => {
    const files = weightFiles(cfg("whisper", "kokoro"), "webgpu", "kokoro");
    expect(await missingWeights(files)).toEqual(files);
    const g = globalThis as { caches?: unknown };
    g.caches = { match: async (url: string) => (url.includes("smart-turn") ? new Response("") : undefined) };
    try { expect((await missingWeights(files)).map((f) => f.key)).toEqual(["stt", "stt", "tts"]); }
    finally { delete g.caches; }
  });
});

describe("the offer's words", () => {
  it("names each model once, in the UI's words", () => {
    const missing = weightFiles(cfg("whisper", "kokoro"), "webgpu", "kokoro");
    expect(listed(planModels({ missing, bytes: 0 }))).toBe("speech recognition, voice and turn-taking");
  });

  it("rounds a size to what reads at a glance, and says nothing for an unknown one", () => {
    expect(aboutSize(212_400_000)).toBe("about 212 MB");
    expect(aboutSize(400_000)).toBe("about 1 MB");
    expect(aboutSize(1_644_000_000)).toBe("about 1.6 GB");
    expect(aboutSize(null)).toBeNull();
  });
});
