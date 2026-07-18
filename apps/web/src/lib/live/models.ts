// Main-thread facade over the model Web Worker. Downloads happen ONLY when
// loadModels() is called (on the user's click in the pre-call screen), reporting
// an aggregate progress bar. Weights are cached by the browser Cache API AND the
// worker is kept warm for the whole tab (never torn down between calls) — so opening
// Live a second time reuses the loaded pipelines with zero download and no shader recompile.
import { loadPipelineConfig } from "./pipelineConfig";

export type ModelKey = "stt" | "tts" | "turn";
export type ModelProgress = { key: ModelKey; name: string; loaded: number; total: number };
export type LoadProgress = { pct: number; loaded: number; total: number; models: ModelProgress[] };

const MODEL_NAMES: Record<ModelKey, string> = { stt: "Speech recognition", tts: "Voice", turn: "Turn-taking" };

let worker: Worker | null = null;
let ready = false;
let turnAvailable = false;
let seq = 0;
let loadedTag: string | null = null; // the config (tier:sttSize:ttsEngine) the warm worker actually loaded
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
// keyed by "<model>:<file>" so the same filename under two models never collides.
const files = new Map<string, { model: ModelKey; loaded: number; total: number }>();

// Tear down the worker + all in-flight state. Used on load failure (so a retry
// starts clean, not against a dead worker with stale progress totals) and when a
// config change requires reloading different weights.
function resetWorker() {
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null; ready = false; loadedTag = null;
  files.clear();
  for (const [id, p] of pending) { pending.delete(id); p.reject(new Error("models reset")); }
}

export function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function modelsReady(): boolean { return ready; }
// Whether the warm worker matches the CURRENT pipeline config. A Whisper-size or
// TTS-engine change makes this false while `ready` stays true — callers use this to
// reload the right weights instead of silently keeping the old ones.
export function modelsMatchConfig(): boolean { return ready && loadedTag === readyTag(); }

// Persistent "weights are already in the Cache API" flag, keyed to the device
// tier (webgpu/wasm download DIFFERENT files). The in-memory `ready` flag resets
// on every page refresh, so without this the pre-call screen re-asks to download
// forever even though the bytes are cached. Set after a successful load; read on
// mount so a refresh auto-loads silently instead of prompting.
const READY_KEY = "openlive-models-ready-v1";
const OLD_READY_KEY = "takt-live-models-ready-v1"; // pre-rebrand; migrated below
const deviceTier = () => (hasWebGPU() ? "webgpu" : "wasm");
// WASM always uses whisper-tiny.en (size choice only applies on WebGPU), so the
// cache tag folds the STT size in — changing size re-prompts the download. The
// TTS engine is folded in too (kokoro vs supertonic download different weights).
const sttSize = () => (deviceTier() === "wasm" ? "tiny" : loadPipelineConfig().stt.whisperSize);
const readyTag = () => `${deviceTier()}:${sttSize()}:${loadPipelineConfig().tts.engine}`;
export function modelsCached(): boolean {
  // Must be config-AWARE: `ready` alone is true whenever ANY size/engine is loaded,
  // which made the Pipeline UI claim every OTHER Whisper size / TTS engine was
  // "Downloaded" after the first load — so its download button never appeared and
  // the new weights only ever pulled silently on the next call. Gate on the loaded
  // config matching the current one instead.
  if (modelsMatchConfig()) return true;
  try {
    if (localStorage.getItem(READY_KEY) === readyTag()) return true;
    // Migration: a pre-rebrand flag (keyed by tier only) still means the heavy
    // weights are in the browser cache — count it as cached so we don't re-prompt.
    const old = localStorage.getItem(OLD_READY_KEY);
    return !!old && old.startsWith(deviceTier());
  } catch { return false; }
}

// Remove a downloaded on-device model from the browser caches (frees the disk it
// took). The warm worker is reset and the ready flag cleared so whatever's left
// reloads — and the removed model re-downloads — the next time it's needed.
// Kokoro/Whisper weights live in transformers.js's "transformers-cache"; Supertonic
// (and Smart-Turn) in the app's "openlive-models-v1" — clear matching URLs from both.
export async function removeModel(kind: "whisper" | "kokoro" | "supertonic"): Promise<number> {
  const needle = kind; // "whisper" / "kokoro" / "supertonic" each appear in their HF file URLs
  let removed = 0;
  for (const name of ["transformers-cache", "openlive-models-v1"]) {
    try {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        if (req.url.toLowerCase().includes(needle)) { await cache.delete(req); removed++; }
      }
    } catch { /* Cache API unavailable (private mode) */ }
  }
  resetWorker();
  try { localStorage.removeItem(READY_KEY); } catch { /* private mode */ }
  return removed;
}

let loading: Promise<void> | null = null;

export function loadModels(onProgress: (p: LoadProgress) => void): Promise<void> {
  if (modelsMatchConfig()) return Promise.resolve();
  // In-flight guard: a silent background preload and the start() lazy-load must
  // share ONE worker, not race to spawn two. Late callers join the same promise.
  if (loading) return loading;
  // A warm worker loaded with a DIFFERENT config (the user changed Whisper size /
  // TTS engine) — tear it down so we reload the right weights. This is what makes
  // "Applies on the next call" true instead of needing a full app restart.
  if (ready) resetWorker();
  // Fresh totals — a prior failed/partial load's leftover entries would corrupt the
  // new download's progress bar.
  files.clear();
  // Best-effort: ask the browser not to evict the model cache under storage pressure.
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }
  loading = new Promise<void>((resolve, reject) => {
    const w = new Worker(new URL("./models.worker.ts", import.meta.url), { type: "module" });
    worker = w;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      switch (m.type) {
        case "progress": {
          const d = m.data;
          if (d?.file && d.total) {
            const key: ModelKey = d.model === "tts" ? "tts" : d.model === "turn" ? "turn" : "stt";
            files.set(`${key}:${d.file}`, { model: key, loaded: d.loaded ?? 0, total: d.total });
            let load = 0, tot = 0;
            const per = new Map<ModelKey, { loaded: number; total: number }>();
            for (const f of files.values()) {
              const l = Math.min(f.loaded, f.total);
              load += l; tot += f.total;
              const p = per.get(f.model) ?? { loaded: 0, total: 0 };
              p.loaded += l; p.total += f.total; per.set(f.model, p);
            }
            const models: ModelProgress[] = (["stt", "tts", "turn"] as ModelKey[])
              .filter((k) => per.has(k))
              .map((k) => ({ key: k, name: MODEL_NAMES[k], loaded: per.get(k)!.loaded, total: per.get(k)!.total }));
            onProgress({ pct: tot ? load / tot : 0, loaded: load, total: tot, models });
          }
          break;
        }
        case "ready":
          ready = true; turnAvailable = !!m.turn; loadedTag = readyTag();
          try { localStorage.setItem(READY_KEY, readyTag()); } catch { /* private mode */ }
          resolve();
          break;
        case "result": { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m); } break; }
        case "error":
          if (m.id != null) { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.reject(new Error(m.message)); } }
          else { resetWorker(); reject(new Error(m.message)); } // load failed → clean slate for a retry
          break;
      }
    };
    w.onerror = (e) => {
      const err = new Error(e.message || "model worker crashed");
      // Terminate the dead worker + reject every in-flight inference (resetWorker),
      // so a retry starts clean instead of awaiting a corpse with stale progress.
      resetWorker();
      reject(err); // the load promise, if we never became ready
    };
    const tier = deviceTier();
    console.info(`[live] on-device compute: ${tier === "webgpu" ? "WebGPU (fast)" : "WASM/CPU (slow — no navigator.gpu)"}`);
    const cfg = loadPipelineConfig();
    w.postMessage({ type: "load", device: tier, whisperSize: sttSize(), ttsEngine: cfg.tts.engine, ttsVoice: cfg.tts.voice });
  });
  loading.finally(() => { loading = null; }); // free the guard so a post-reset reload can re-run
  return loading;
}

// Safety net: a hung/dead worker (a stalled inference, a dropped message, a crashed
// WebGPU context) must NEVER leave a call unsettled — otherwise the voice engine's
// finalize step awaits forever and the whole turn loop deadlocks ("stuck listening").
// Generous enough not to trip a legitimately slow WASM/CPU transcription of a long
// utterance; short enough that a real stall self-heals in seconds.
const CALL_TIMEOUT_MS = 12000;
// TTS gets a longer leash: a mid-call ENGINE SWITCH lazy-downloads the new
// engine's weights inside the first tts call (Cache API after that).
const TTS_TIMEOUT_MS = 120000;

function call<T>(msg: any, transfer?: Transferable[]): Promise<T> {
  if (!worker) return Promise.reject(new Error("models not loaded"));
  const id = ++seq;
  const timeoutMs = msg.type === "tts" ? TTS_TIMEOUT_MS : CALL_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`model call "${msg.type}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    worker!.postMessage({ ...msg, id }, transfer ?? []);
  });
}

/** Transcribe a 16 kHz mono utterance → text. */
export async function stt(audio: Float32Array): Promise<string> {
  const m = await call<{ text: string }>({ type: "stt", audio });
  return m.text;
}

// Cloned-voice synthesis runs in the LOCAL agent service (ZipVoice via
// sherpa-onnx), reached through the same-origin /api/voice proxy. Falls back to
// Kokoro (worker) if the model/profile is missing or the call fails — one toast
// per session, never a broken call.
let cloneFallbackToasted = false;
async function cloneTts(text: string, voice: string, speed?: number): Promise<{ audio: Float32Array; sampleRate: number } | null> {
  try {
    const res = await fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, profileId: voice, speed }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return { audio: new Float32Array(buf), sampleRate: Number(res.headers.get("x-sample-rate")) || 24000 };
  } catch (e) {
    if (!cloneFallbackToasted) {
      cloneFallbackToasted = true;
      const { toast } = await import("@/lib/toast");
      toast("Cloned voice unavailable — using Kokoro. Check Settings → Clone Voice.");
    }
    const { log } = await import("@/lib/log");
    log.error("tts", "clone synth failed, falling back:", e);
    return null;
  }
}

/** Synthesize a sentence → Float32 PCM + sample rate. Voice/speed come from the
 *  user's pipeline config; a cloned voice routes to the local agent service and
 *  falls back to Kokoro if unavailable. */
export async function tts(text: string, opts?: { engine?: string; voice?: string; speed?: number }): Promise<{ audio: Float32Array; sampleRate: number }> {
  if (opts?.engine === "clone") {
    const cloned = opts.voice ? await cloneTts(text, opts.voice, opts.speed) : null;
    if (cloned) return cloned;
    opts = { engine: "kokoro", speed: opts.speed }; // worker default voice
  }
  const m = await call<{ audio: Float32Array; sampleRate: number }>({ type: "tts", text, engine: opts?.engine, voice: opts?.voice, speed: opts?.speed });
  return { audio: m.audio, sampleRate: m.sampleRate };
}

/** Whether Smart-Turn v3 loaded (else the engine uses the silence heuristic). */
export function turnModelReady(): boolean { return turnAvailable; }

/** Semantic end-of-turn: is the user actually done? (Smart-Turn v3.) `threshold`
 *  is the sigmoid cutoff (higher = wait longer before responding). */
export async function turnComplete(audio: Float32Array, threshold?: number): Promise<boolean> {
  const m = await call<{ complete: boolean }>({ type: "turn", audio, threshold });
  return m.complete;
}

