/// <reference lib="webworker" />
// Smart-Turn v3 (semantic end-of-turn) on its own thread. In the model worker a
// Kokoro synthesis held the thread for its whole run (measured 2026-09-24: a
// turn check sent 120 ms into a 1.7 s sentence answered only after it), so the
// end of every turn spoken over a reply waited for speech. Tiny, CPU/WASM only.
import { env, AutoProcessor } from "@huggingface/transformers";
import * as ort from "onnxruntime-web/wasm";

env.allowLocalModels = false; // fetch from the hub, then cache
env.useBrowserCache = true;   // persist weights in the Cache API across sessions
ort.env.wasm.numThreads = 1;  // single-thread → no cross-origin-isolation needed

// Smart-Turn v3 (pipecat): Whisper-tiny encoder + head; input is a Whisper
// log-mel, the ONNX output IS a sigmoid probability (>0.5 → turn complete).
const SMART_TURN_URL = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx";
const TURN_PROCESSOR = "onnx-community/whisper-tiny.en";
const N8 = 8 * 16000; // Smart-Turn reads the last 8 s of audio

let turnSession: ort.InferenceSession | null = null;
let turnProc: any = null;

const post = (m: any) => (self as any).postMessage(m);

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

// One run at a time: a session's run keeps wasm stack state across its awaits.
let chain: Promise<void> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => { chain = chain.then(() => fn().then(resolve, reject)).catch(() => {}); });

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

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      // Non-fatal if it fails to load: the voice engine falls back to silence endpointing.
      try {
        turnProc = await AutoProcessor.from_pretrained(TURN_PROCESSOR, { progress_callback: (p: any) => post({ type: "progress", data: { ...p, model: "turn" } }) });
        turnSession = await ort.InferenceSession.create(await cachedArrayBuffer(SMART_TURN_URL), { executionProviders: ["wasm"] });
      } catch (err) { console.warn("[live] Smart-Turn unavailable:", err); turnSession = null; turnProc = null; }
      try { await turnComplete(new Float32Array(16000)); } catch { /* warm-up only */ }
      post({ type: "ready", turn: !!(turnSession && turnProc) });
    } else if (msg.type === "turn") {
      const complete = await serial(() => turnComplete(msg.audio, msg.threshold));
      post({ type: "result", id: msg.id, complete });
    }
  } catch (err: any) {
    post({ type: "error", id: msg?.id ?? null, message: String(err?.message ?? err) });
  }
};
