/// <reference lib="webworker" />
// Runs the heavy on-device voice models OFF the main thread so the orb/UI stay
// smooth: Whisper (STT) + Kokoro (TTS) on WebGPU/WASM via transformers.js, and
// Smart-Turn v3 (semantic end-of-turn) as a small ONNX on CPU/WASM. GPU work is
// serialized. Models download from the hub on first load, then the browser Cache
// API keeps them across sessions.
import { pipeline, env, AutoProcessor } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import * as ort from "onnxruntime-web";

env.allowLocalModels = false; // fetch from the hub, then cache
env.useBrowserCache = true;   // persist weights in the Cache API across sessions
ort.env.wasm.numThreads = 1;  // single-thread → no cross-origin-isolation needed

// Fetch a URL through the Cache API so big model files download once, not every
// load. transformers.js caches its own weights; this covers the raw Smart-Turn
// ONNX we fetch by hand. Falls back to a plain fetch where Cache API is blocked.
async function cachedArrayBuffer(url: string): Promise<ArrayBuffer> {
  try {
    const cache = await caches.open("openlive-models-v1");
    let res = await cache.match(url);
    if (!res) { await cache.add(url); res = await cache.match(url); }
    if (res) return await res.arrayBuffer();
  } catch { /* Cache API unavailable (e.g. private mode) → fall through */ }
  return await (await fetch(url)).arrayBuffer();
}

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
};
const STT_MODEL_WASM = "onnx-community/whisper-tiny.en"; // lighter on the WASM tier
const sttModel = (device: Device, size: string): string =>
  device === "wasm" ? STT_MODEL_WASM : (STT_WEBGPU[size] ?? STT_WEBGPU.base!);
const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";
// Smart-Turn v3 (pipecat): Whisper-tiny encoder + head; input is a Whisper
// log-mel, the ONNX output IS a sigmoid probability (>0.5 → turn complete).
const SMART_TURN_URL = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx";
const TURN_PROCESSOR = "onnx-community/whisper-tiny.en";
const N8 = 8 * 16000; // Smart-Turn reads the last 8 s of audio

type Device = "webgpu" | "wasm";
let asr: any = null;
let tts: any = null;
let turnSession: ort.InferenceSession | null = null;
let turnProc: any = null;

// Serialize inference so two jobs never fight for the GPU.
let chain: Promise<void> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => { chain = chain.then(() => fn().then(resolve, reject)).catch(() => {}); });

const post = (m: any, transfer?: Transferable[]) => (self as any).postMessage(m, transfer ?? []);

// Whisper log-mel features cropped to Smart-Turn's [1, 80, 800] input.
async function turnFeatures(audio: Float32Array): Promise<ort.Tensor> {
  const a = new Float32Array(N8);
  if (audio.length >= N8) a.set(audio.subarray(audio.length - N8));
  else a.set(audio, N8 - audio.length); // pad zeros at the FRONT (recent speech last)
  const r: any = await turnProc(a, { sampling_rate: 16000 });
  const f = r.input_features;
  const data = f.data as Float32Array;
  const T = f.dims[2];
  const out = new Float32Array(80 * 800);
  for (let m = 0; m < 80; m++) for (let x = 0; x < 800; x++) out[m * 800 + x] = data[m * T + x]!;
  return new ort.Tensor("float32", out, [1, 80, 800]);
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      const device: Device = msg.device;
      const dtype = device === "webgpu" ? "fp32" : "q8";
      // Tag each file's progress with the model it belongs to so the UI can show a
      // per-model breakdown ("Speech recognition", "Voice", "Turn-taking").
      const tagged = (model: "stt" | "tts" | "turn") => (p: any) => post({ type: "progress", data: { ...p, model } });
      asr = await pipeline("automatic-speech-recognition", sttModel(device, msg.whisperSize), { device, dtype, progress_callback: tagged("stt") });
      tts = await KokoroTTS.from_pretrained(TTS_MODEL, { device, dtype, progress_callback: tagged("tts") });
      // Smart-Turn is tiny → always CPU/WASM. Non-fatal if it fails to load.
      try {
        turnProc = await AutoProcessor.from_pretrained(TURN_PROCESSOR, { progress_callback: tagged("turn") });
        const buf = await cachedArrayBuffer(SMART_TURN_URL);
        turnSession = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
      } catch (err) { console.warn("[live] Smart-Turn unavailable:", err); turnSession = null; turnProc = null; }
      // Warm up (compiles WebGPU shaders) so the first real turn isn't janky.
      try { await asr(new Float32Array(16000)); } catch { /* */ }
      try { await tts.generate("Hi.", { voice: VOICE }); } catch { /* */ }
      if (turnSession && turnProc) { try { await turnComplete(new Float32Array(16000)); } catch { /* */ } }
      post({ type: "ready", turn: !!(turnSession && turnProc) });
    } else if (msg.type === "stt") {
      const text = await serial(async () => String((await asr(msg.audio))?.text ?? "").trim());
      post({ type: "result", id: msg.id, text });
    } else if (msg.type === "tts") {
      const { audio, sampleRate } = await serial(async () => {
        // voice/speed come from the user's pipeline config; fall back to the defaults.
        const a = await tts.generate(msg.text, { voice: msg.voice || VOICE, speed: msg.speed || 1 });
        return { audio: a.audio as Float32Array, sampleRate: a.sampling_rate as number };
      });
      post({ type: "result", id: msg.id, audio, sampleRate }, [audio.buffer]);
    } else if (msg.type === "turn") {
      const complete = await serial(() => turnComplete(msg.audio, msg.threshold));
      post({ type: "result", id: msg.id, complete });
    } else if (msg.type === "dispose") {
      asr = null; tts = null;
      try { await turnSession?.release?.(); } catch { /* */ }
      turnSession = null; turnProc = null;
      self.close();
    }
  } catch (err: any) {
    post({ type: "error", id: msg?.id ?? null, message: String(err?.message ?? err) });
  }
};

// Is the user's turn actually complete? true if no model (caller falls back).
// `threshold` is the sigmoid cutoff (default 0.5); higher = the user must sound
// more clearly finished before we respond.
async function turnComplete(audio: Float32Array, threshold = 0.5): Promise<boolean> {
  if (!turnSession || !turnProc) return true;
  const feats = await turnFeatures(audio);
  const inName = turnSession.inputNames[0]!;
  const outName = turnSession.outputNames[0]!;
  const res: any = await turnSession.run({ [inName]: feats });
  return (res[outName].data[0] as number) > threshold;
}
