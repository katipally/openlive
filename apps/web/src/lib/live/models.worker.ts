/// <reference lib="webworker" />
// Runs the heavy on-device voice models OFF the main thread so the orb/UI stay
// smooth: Whisper (STT) + Kokoro (TTS) on WebGPU/WASM via transformers.js.
// Smart-Turn runs in turn.worker.ts, so end-of-turn never waits here. When a
// native engine on the agent is selected, its in-browser counterpart is not
// loaded up front, only lazily as the fallback. GPU work is
// serialized. Models download from the hub on first load, then the browser Cache
// API keeps them across sessions.
import { pipeline, env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import * as ort from "onnxruntime-web";
import type { Supertonic } from "@openlive/shared/speech/supertonic";
import { loadSupertonic } from "./supertonic";
import { whisperMaxTokens } from "./pipelineConfig";
import { trimSilence, KEEP_S } from "@openlive/shared/speech/trim";

env.allowLocalModels = false; // fetch from the hub, then cache
env.useBrowserCache = true;   // persist weights in the Cache API across sessions
ort.env.wasm.numThreads = 1;  // single-thread → no cross-origin-isolation needed

// The Whisper checkpoint comes from the main thread (whisperCheckpoint in
// pipelineConfig.ts): English-only `.en` builds for English, which reject a
// `language` arg, and multilingual builds for everything else, which get the
// session language pinned so they never auto-detect wrong.
const sttIsMultilingual = (model: string) => !model.endsWith(".en");
// fp32 for the whole large model would blow past sane GPU memory — the standard
// transformers.js split (fp16 encoder + q4 decoder) keeps it ~1.6 GB on disk.
const sttDtype = (model: string, dtype: string) =>
  model.includes("large-v3-turbo") ? { encoder_model: "fp16", decoder_model_merged: "q4" } : dtype;
const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";

type Device = "webgpu" | "wasm";
let asr: any = null;
let asrModel = "";           // the checkpoint `asr` holds
let asrMultilingual = false; // multilingual models take (and need) a pinned language
let tts: any = null;              // Kokoro (lazy when Supertonic is the pick)
let supertonic: Supertonic | null = null;
let deviceTier: Device = "wasm";

// One in-flight loader per engine so a mid-call engine switch never races two
// downloads of the same weights.
let whisperLoading: Promise<void> | null = null;
let kokoroLoading: Promise<void> | null = null;
let supertonicLoading: Promise<void> | null = null;
const taggedTts = (p: any) => post({ type: "progress", data: { ...p, model: "tts" } });
// A language switch mid-call can ask for another checkpoint: the old one is
// released once the jobs queued on it are done, before the new one loads, so
// two Whisper models never share the GPU.
async function ensureWhisper(id: string, progress_callback?: (p: any) => void): Promise<void> {
  if (asr && asrModel === id) return;
  await whisperLoading?.catch(() => {});
  if (asr && asrModel === id) return;
  if (asr) { const old = asr; asr = null; asrModel = ""; await serial(async () => old.dispose?.()).catch(() => {}); }
  whisperLoading ??= pipeline("automatic-speech-recognition", id, { device: deviceTier, dtype: sttDtype(id, deviceTier === "webgpu" ? "fp32" : "q8") as never, progress_callback })
    .then((p: any) => { asr = p; asrModel = id; asrMultilingual = sttIsMultilingual(id); }).finally(() => { whisperLoading = null; });
  return whisperLoading;
}
const pinned = (lang: string) => (asrMultilingual ? { language: lang, task: "transcribe" } : undefined);
function ensureKokoro(): Promise<void> {
  if (tts) return Promise.resolve();
  kokoroLoading ??= KokoroTTS.from_pretrained(TTS_MODEL, { device: deviceTier, dtype: deviceTier === "webgpu" ? "fp32" : "q8", progress_callback: taggedTts })
    .then((t: any) => { tts = t; }).finally(() => { kokoroLoading = null; });
  return kokoroLoading;
}
function ensureSupertonic(): Promise<void> {
  if (supertonic) return Promise.resolve();
  supertonicLoading ??= loadSupertonic(deviceTier, taggedTts)
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
      deviceTier = msg.device;
      // Tag each file's progress with the model it belongs to so the UI can show a
      // per-model breakdown ("Speech recognition", "Voice", "Turn-taking").
      const tagged = (model: "stt" | "tts") => (p: any) => post({ type: "progress", data: { ...p, model } });
      if (msg.whisper) await ensureWhisper(msg.whisperModel, tagged("stt"));
      // Load only the SELECTED TTS engine up front; the other lazy-loads on a
      // mid-call engine switch (its first sentence pays the download).
      if (msg.ttsEngine === "supertonic") await ensureSupertonic();
      else if (!msg.ttsNative) await ensureKokoro();
      // Warm up (compiles WebGPU shaders) so the first real turn isn't janky.
      try { if (asr) await asr(new Float32Array(16000), pinned(msg.lang)); } catch { /* */ }
      try { if (supertonic) await supertonic.synthesize("Hi.", msg.ttsVoice || "M1", 1, "en"); else if (tts) await tts.generate("Hi.", { voice: VOICE }); } catch { /* */ }
      post({ type: "ready", whisper: asrModel });
    } else if (msg.type === "stt") {
      await ensureWhisper(msg.model); // outside `serial`: a fallback download must not stall speech
      const [run, opts] = [asr, { ...pinned(msg.lang), max_new_tokens: whisperMaxTokens(msg.audio.length) }]; // this checkpoint, even if a later utterance swaps it
      const text = await serial(async () => String((await run(msg.audio, opts))?.text ?? "").trim());
      post({ type: "result", id: msg.id, text });
    } else if (msg.type === "tts") {
      const { audio, sampleRate } = await serial(async () => {
        // engine/voice/speed come from the user's pipeline config, read fresh per
        // sentence — an engine switch applies to the very next spoken sentence.
        if (msg.engine === "supertonic") {
          await ensureSupertonic();
          const audio = await supertonic!.synthesize(msg.text, msg.voice || "M1", msg.speed || 1, msg.lang || "en");
          return { audio: trimSilence(audio, supertonic!.sampleRate, ...KEEP_S.supertonic), sampleRate: supertonic!.sampleRate };
        }
        await ensureKokoro();
        const a = await tts.generate(msg.text, { voice: msg.voice || VOICE, speed: msg.speed || 1 });
        return { audio: trimSilence(a.audio as Float32Array, a.sampling_rate as number, ...KEEP_S.kokoro), sampleRate: a.sampling_rate as number };
      });
      post({ type: "result", id: msg.id, audio, sampleRate }, [audio.buffer]);
    }
  } catch (err: any) {
    post({ type: "error", id: msg?.id ?? null, message: String(err?.message ?? err) });
  }
};
