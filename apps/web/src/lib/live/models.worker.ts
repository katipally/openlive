/// <reference lib="webworker" />
// Runs the heavy on-device voice models OFF the main thread so the orb/UI stay
// smooth: Whisper (STT) + Kokoro (TTS) on WebGPU/WASM via transformers.js.
// Smart-Turn runs in turn.worker.ts, so end-of-turn never waits here. A native
// TTS engine on the agent leaves Kokoro unloaded until it is needed as the
// fallback. GPU work is
// serialized. Models download from the hub on first load, then the browser Cache
// API keeps them across sessions.
import { pipeline, env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import * as ort from "onnxruntime-web";
import { Supertonic } from "./supertonic";

env.allowLocalModels = false; // fetch from the hub, then cache
env.useBrowserCache = true;   // persist weights in the Cache API across sessions
ort.env.wasm.numThreads = 1;  // single-thread → no cross-origin-isolation needed

// English-ONLY variants: same size/speed as the multilingual base/tiny but more
// accurate on English (incl. product terms) — the assistant is English-only, and
// the turn model already uses whisper-tiny.en. (.en models reject a `language`
// arg, so the stt call passes none.)
// English-only Whisper family; the user picks the size (Pipeline settings). WASM
// is always tiny (small/base are too slow on CPU). ponytail: `.en` ids only —
// the assistant is English-only and `.en` rejects a `language` arg.
const STT_WEBGPU: Record<string, string> = {
  tiny: "onnx-community/whisper-tiny.en",
  base: "onnx-community/whisper-base.en",
  small: "onnx-community/whisper-small.en",
  // Multilingual (no `.en` variant exists at this size) — best accuracy on capable
  // machines; the stt call pins `language: "en"` so it never auto-detects wrong.
  "large-v3-turbo": "onnx-community/whisper-large-v3-turbo",
};
const STT_MODEL_WASM = "onnx-community/whisper-tiny.en"; // lighter on the WASM tier
const sttModel = (device: Device, size: string): string =>
  device === "wasm" ? STT_MODEL_WASM : (STT_WEBGPU[size] ?? STT_WEBGPU.base!);
const sttIsMultilingual = (model: string) => !model.endsWith(".en");
// fp32 for the whole large model would blow past sane GPU memory — the standard
// transformers.js split (fp16 encoder + q4 decoder) keeps it ~1.6 GB on disk.
const sttDtype = (model: string, dtype: string) =>
  model.includes("large-v3-turbo") ? { encoder_model: "fp16", decoder_model_merged: "q4" } : dtype;
const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";

type Device = "webgpu" | "wasm";
let asr: any = null;
let asrMultilingual = false; // multilingual models take (and need) a pinned language
let tts: any = null;              // Kokoro (lazy when Supertonic is the pick)
let supertonic: Supertonic | null = null;
let deviceTier: Device = "wasm";

// One in-flight loader per engine so a mid-call engine switch never races two
// downloads of the same weights.
let kokoroLoading: Promise<void> | null = null;
let supertonicLoading: Promise<void> | null = null;
const taggedTts = (p: any) => post({ type: "progress", data: { ...p, model: "tts" } });
function ensureKokoro(): Promise<void> {
  if (tts) return Promise.resolve();
  kokoroLoading ??= KokoroTTS.from_pretrained(TTS_MODEL, { device: deviceTier, dtype: deviceTier === "webgpu" ? "fp32" : "q8", progress_callback: taggedTts })
    .then((t: any) => { tts = t; }).finally(() => { kokoroLoading = null; });
  return kokoroLoading;
}
function ensureSupertonic(): Promise<void> {
  if (supertonic) return Promise.resolve();
  supertonicLoading ??= Supertonic.load(deviceTier, taggedTts)
    .then((s) => { supertonic = s; }).finally(() => { supertonicLoading = null; });
  return supertonicLoading;
}

// Serialize inference so two jobs never fight for the GPU.
let chain: Promise<void> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => { chain = chain.then(() => fn().then(resolve, reject)).catch(() => {}); });

const post = (m: any, transfer?: Transferable[]) => (self as any).postMessage(m, transfer ?? []);

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      const device: Device = msg.device;
      deviceTier = device;
      const dtype = device === "webgpu" ? "fp32" : "q8";
      // Tag each file's progress with the model it belongs to so the UI can show a
      // per-model breakdown ("Speech recognition", "Voice", "Turn-taking").
      const tagged = (model: "stt" | "tts") => (p: any) => post({ type: "progress", data: { ...p, model } });
      const sttId = sttModel(device, msg.whisperSize);
      asrMultilingual = sttIsMultilingual(sttId);
      asr = await pipeline("automatic-speech-recognition", sttId, { device, dtype: sttDtype(sttId, dtype) as never, progress_callback: tagged("stt") });
      // Load only the SELECTED TTS engine up front; the other lazy-loads on a
      // mid-call engine switch (its first sentence pays the download).
      if (msg.ttsEngine === "supertonic") await ensureSupertonic();
      else if (!msg.ttsNative) await ensureKokoro();
      // Warm up (compiles WebGPU shaders) so the first real turn isn't janky.
      try { await asr(new Float32Array(16000), asrMultilingual ? { language: "en", task: "transcribe" } : undefined); } catch { /* */ }
      try { if (supertonic) await supertonic.synthesize("Hi.", msg.ttsVoice || "M1"); else if (tts) await tts.generate("Hi.", { voice: VOICE }); } catch { /* */ }
      post({ type: "ready" });
    } else if (msg.type === "stt") {
      const opts = asrMultilingual ? { language: "en", task: "transcribe" } : undefined;
      const text = await serial(async () => String((await asr(msg.audio, opts))?.text ?? "").trim());
      post({ type: "result", id: msg.id, text });
    } else if (msg.type === "tts") {
      const { audio, sampleRate } = await serial(async () => {
        // engine/voice/speed come from the user's pipeline config, read fresh per
        // sentence — an engine switch applies to the very next spoken sentence.
        if (msg.engine === "supertonic") {
          await ensureSupertonic();
          const audio = await supertonic!.synthesize(msg.text, msg.voice || "M1", msg.speed || 1);
          return { audio, sampleRate: supertonic!.sampleRate };
        }
        await ensureKokoro();
        const a = await tts.generate(msg.text, { voice: msg.voice || VOICE, speed: msg.speed || 1 });
        return { audio: a.audio as Float32Array, sampleRate: a.sampling_rate as number };
      });
      post({ type: "result", id: msg.id, audio, sampleRate }, [audio.buffer]);
    }
  } catch (err: any) {
    post({ type: "error", id: msg?.id ?? null, message: String(err?.message ?? err) });
  }
};
