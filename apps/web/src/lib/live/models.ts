// Main-thread facade over the model Web Worker. Downloads happen ONLY when
// loadModels() is called (on the user's click in the pre-call screen), reporting
// an aggregate progress bar. Weights are cached by the browser Cache API AND the
// worker is kept warm for the whole tab (see disposeModels) — so opening Live a
// second time reuses the loaded pipelines with zero download and no shader recompile.
export type ModelKey = "stt" | "tts" | "turn";
export type ModelProgress = { key: ModelKey; name: string; loaded: number; total: number };
export type LoadProgress = { pct: number; loaded: number; total: number; models: ModelProgress[] };

const MODEL_NAMES: Record<ModelKey, string> = { stt: "Speech recognition", tts: "Voice", turn: "Turn-taking" };

let worker: Worker | null = null;
let ready = false;
let turnAvailable = false;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
// keyed by "<model>:<file>" so the same filename under two models never collides.
const files = new Map<string, { model: ModelKey; loaded: number; total: number }>();

export function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function modelsReady(): boolean { return ready; }

// Persistent "weights are already in the Cache API" flag, keyed to the device
// tier (webgpu/wasm download DIFFERENT files). The in-memory `ready` flag resets
// on every page refresh, so without this the pre-call screen re-asks to download
// forever even though the bytes are cached. Set after a successful load; read on
// mount so a refresh auto-loads silently instead of prompting.
const READY_KEY = "takt-live-models-ready-v1";
const deviceTier = () => (hasWebGPU() ? "webgpu" : "wasm");
export function modelsCached(): boolean {
  if (ready) return true;
  try { return localStorage.getItem(READY_KEY) === deviceTier(); } catch { return false; }
}

let loading: Promise<void> | null = null;

export function loadModels(onProgress: (p: LoadProgress) => void): Promise<void> {
  if (ready) return Promise.resolve();
  // In-flight guard: a silent background preload and the start() lazy-load must
  // share ONE worker, not race to spawn two. Late callers join the same promise.
  if (loading) return loading;
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
          ready = true; turnAvailable = !!m.turn;
          try { localStorage.setItem(READY_KEY, deviceTier()); } catch { /* private mode */ }
          resolve();
          break;
        case "result": { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m); } break; }
        case "error":
          if (m.id != null) { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.reject(new Error(m.message)); } }
          else reject(new Error(m.message));
          break;
      }
    };
    w.onerror = (e) => reject(new Error(e.message || "model worker failed to load"));
    const tier = deviceTier();
    console.info(`[live] on-device compute: ${tier === "webgpu" ? "WebGPU (fast)" : "WASM/CPU (slow — no navigator.gpu)"}`);
    w.postMessage({ type: "load", device: tier });
  });
  loading.finally(() => { loading = null; }); // free the guard so a post-reset reload can re-run
  return loading;
}

function call<T>(msg: any, transfer?: Transferable[]): Promise<T> {
  if (!worker) return Promise.reject(new Error("models not loaded"));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...msg, id }, transfer ?? []);
  });
}

/** Transcribe a 16 kHz mono utterance → text. */
export async function stt(audio: Float32Array): Promise<string> {
  const m = await call<{ text: string }>({ type: "stt", audio });
  return m.text;
}

/** Synthesize a sentence → Float32 PCM + sample rate. */
export async function tts(text: string): Promise<{ audio: Float32Array; sampleRate: number }> {
  const m = await call<{ audio: Float32Array; sampleRate: number }>({ type: "tts", text });
  return { audio: m.audio, sampleRate: m.sampleRate };
}

/** Whether Smart-Turn v3 loaded (else the engine uses the silence heuristic). */
export function turnModelReady(): boolean { return turnAvailable; }

/** Semantic end-of-turn: is the user actually done? (Smart-Turn v3.) */
export async function turnComplete(audio: Float32Array): Promise<boolean> {
  const m = await call<{ complete: boolean }>({ type: "turn", audio });
  return m.complete;
}

/** Called on live-mode teardown. We deliberately KEEP the worker warm (WebGPU
 *  device + loaded pipelines) for the tab's lifetime so reopening Live is instant
 *  — terminating here was the reason models "re-downloaded" and shaders recompiled
 *  every single open. The browser reclaims the worker when the tab closes. Any
 *  in-flight call from the closed session still resolves harmlessly. Use
 *  destroyModels() only for a hard reset. */
export function disposeModels() { /* keep models warm across sessions */ }

/** Hard teardown of the worker — only for a full reset (not per-call). */
export function destroyModels() {
  try { worker?.postMessage({ type: "dispose" }); } catch { /* */ }
  try { worker?.terminate(); } catch { /* */ }
  worker = null; ready = false; loading = null;
  files.clear();
  for (const p of pending.values()) p.reject(new Error("models disposed"));
  pending.clear();
}
