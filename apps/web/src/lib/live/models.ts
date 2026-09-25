// Main-thread facade over the model Web Worker, plus the routing to the native
// engines on the local agent (/api/voice) when one is selected. Downloads happen ONLY when
// loadModels() is called (on the user's click in the pre-call screen), reporting
// an aggregate progress bar. Weights are cached by the browser Cache API AND the
// worker is kept warm for the whole tab (never torn down between calls) — so opening
// Live a second time reuses the loaded pipelines with zero download and no shader recompile.
import { loadPipelineConfig, isNativeVariant, variantInfo, workerTag, tagCached, whisperCheckpoint, browserTtsFallback, languageSupport, CURATED_LANGUAGES } from "./pipelineConfig";
import type { LanguageCode } from "@openlive/shared";
import { pcmDecoder } from "./pcm";
import { failureIsLasting } from "./nativeFailure";
import { toast } from "@/lib/toast";
import { log } from "@/lib/log";

export type ModelKey = "stt" | "tts" | "turn";
export type ModelProgress = { key: ModelKey; name: string; loaded: number; total: number };
export type LoadProgress = { pct: number; loaded: number; total: number; models: ModelProgress[] };

const MODEL_NAMES: Record<ModelKey, string> = { stt: "Speech recognition", tts: "Voice", turn: "Turn-taking" };

let worker: Worker | null = null;
let turnWorker: Worker | null = null; // Smart-Turn on its own thread (turn.worker.ts)
let ready = false;
let turnAvailable = false;
let seq = 0;
let loadedTag: string | null = null; // the config (tier:stt:ttsEngine) the warm worker actually loaded
let whisperLoaded = ""; // the Whisper checkpoint the worker holds; none while a native STT engine is selected, until a fallback loads it
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
// keyed by "<model>:<file>" so the same filename under two models never collides.
const files = new Map<string, { model: ModelKey; loaded: number; total: number }>();

// Tear down the worker + all in-flight state. Used on load failure (so a retry
// starts clean, not against a dead worker with stale progress totals) and when a
// config change requires reloading different weights.
function resetWorker() {
  try { worker?.terminate(); } catch { /* already gone */ }
  try { turnWorker?.terminate(); } catch { /* already gone */ }
  worker = null; turnWorker = null; ready = false; loadedTag = null; whisperLoaded = ""; turnAvailable = false;
  files.clear();
  for (const [id, p] of pending) { pending.delete(id); p.reject(new Error("models reset")); }
}

export function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function modelsReady(): boolean { return ready; }
// Whether the warm worker matches the CURRENT pipeline config. An STT-engine,
// Whisper-size or TTS-engine change makes this false while `ready` stays true: callers use this to
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
const readyTag = () => workerTag(loadPipelineConfig(), deviceTier());
// Every config that finished loading, space-separated (a pre-list value is one tag),
// so a later switch counts whatever parts of it are already in the cache.
const loadedTags = () => (localStorage.getItem(READY_KEY) ?? "").split(" ").filter(Boolean);
export function modelsCached(): boolean {
  // Must be config-AWARE: `ready` alone is true whenever ANY size/engine is loaded,
  // which made the Pipeline UI claim every OTHER Whisper size / TTS engine was
  // "Downloaded" after the first load — so its download button never appeared and
  // the new weights only ever pulled silently on the next call. Gate on the loaded
  // config matching the current one instead.
  if (modelsMatchConfig()) return true;
  try {
    if (tagCached(readyTag(), loadedTags())) return true;
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
    const tw = new Worker(new URL("./turn.worker.ts", import.meta.url), { type: "module" });
    worker = w;
    turnWorker = tw;
    let waiting = 2; // both workers say "ready"
    w.onmessage = tw.onmessage = (e: MessageEvent) => {
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
          if (e.target === tw) turnAvailable = !!m.turn; else whisperLoaded = m.whisper;
          if (--waiting) break;
          ready = true; loadedTag = readyTag();
          warmNativeEngines();
          try { localStorage.setItem(READY_KEY, [...new Set([...loadedTags(), readyTag()])].join(" ")); } catch { /* private mode */ }
          resolve();
          break;
        case "result": { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m); } break; }
        case "error":
          if (m.id != null) { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.reject(new Error(m.message)); } }
          else { resetWorker(); reject(new Error(m.message)); } // load failed → clean slate for a retry
          break;
      }
    };
    w.onerror = tw.onerror = (e) => {
      const err = new Error(e.message || "model worker crashed");
      // Terminate the dead worker + reject every in-flight inference (resetWorker),
      // so a retry starts clean instead of awaiting a corpse with stale progress.
      resetWorker();
      reject(err); // the load promise, if we never became ready
    };
    const tier = deviceTier();
    console.info(`[live] on-device compute: ${tier === "webgpu" ? "WebGPU (fast)" : "WASM/CPU (slow — no navigator.gpu)"}`);
    const cfg = loadPipelineConfig();
    // A cloned voice loads the browser voice that stands in for it in the language (none for Chinese).
    const browserTts = isNativeVariant(cfg.tts.variant) ? null : cfg.tts.family === "clone" ? browserTtsFallback(cfg.language) : cfg.tts.family;
    w.postMessage({
      type: "load", device: tier, whisperModel: whisperCheckpoint(cfg.stt.whisperSize, cfg.language, tier), whisper: !isNativeVariant(cfg.stt.variant),
      ttsEngine: browserTts, ttsNative: !browserTts, ttsVoice: cfg.tts.voice, lang: cfg.language,
    });
    tw.postMessage({ type: "load" });
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
// engine's weights inside the first tts call (Cache API after that). So does the
// first Whisper call when a native STT engine was loaded instead of it.
const TTS_TIMEOUT_MS = 120000;

async function call<T>(msg: any, transfer?: Transferable[]): Promise<T> {
  // A native engine that fails before the worker ever loaded (Flow with native
  // engines opens no worker) falls back here: load it now, so the same utterance
  // or sentence still goes through instead of being dropped.
  if (!worker) await loadModels(() => {});
  const id = ++seq;
  const timeoutMs = msg.type === "tts" || (msg.type === "stt" && msg.model !== whisperLoaded) ? TTS_TIMEOUT_MS : CALL_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`model call "${msg.type}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    (msg.type === "turn" ? turnWorker : worker)!.postMessage({ ...msg, id }, transfer ?? []);
  });
}

// ── native engines on the local agent ────────────────────────────────────────
// A native engine that fails falls back to the in-browser one that speaks the
// session language, for that call. A lasting failure (nativeFailure.ts) swaps
// it out for the rest of the session, with one toast; either way, never a broken call.
let sttFallback: string | null = null;
let ttsFallback: string | null = null;
const familyName = (variant: string) => variantInfo(variant)?.family.name ?? variant;
const languageName = (lang: LanguageCode) => CURATED_LANGUAGES.find((l) => l.code === lang)!.name;
const httpError = async (res: Response) =>
  Object.assign(new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`), { status: res.status });

export const isNativeTts = isNativeVariant;

/** A new call gives a failed native engine another chance. */
export function resetNativeFallbacks() { sttFallback = null; ttsFallback = null; }

/** The STT variant this session really uses: the selection, or Whisper once it
 *  failed (Whisper speaks every curated language). */
export function activeSttEngine(): string {
  const e = loadPipelineConfig().stt.variant;
  return e === sttFallback ? "whisper" : e;
}

export function nativeSttFailed(engine: string, err: unknown, lasting = failureIsLasting(err)) {
  log.error("stt", `${engine} failed, using Whisper:`, err);
  if (!lasting || sttFallback === engine) return;
  sttFallback = engine;
  toast(`${familyName(engine)} unavailable, using Whisper. Check Settings > Voice pipeline.`);
}

// Call start, model load and every Flow open all ask for a warm-up; one per
// engine a minute keeps the agent's engines loaded (it unloads after 5 idle
// minutes) without a duplicate "Hi." queueing ahead of the first real sentence.
const WARM_FRESH_MS = 60_000;
const warmedAt = new Map<string, number>();
const warmDue = (engine: string) => {
  const now = Date.now();
  if (now - (warmedAt.get(engine) ?? -Infinity) < WARM_FRESH_MS) return false;
  warmedAt.set(engine, now);
  return true;
};

/** Loads the selected native engines on the agent (up to ~1 s each, cold) before
 *  the first turn needs them. Quiet: a failure here is reported by the first real call. */
export function warmNativeEngines() {
  const { stt: s, tts: t, language: lang } = loadPipelineConfig();
  if (isNativeVariant(s.variant) && s.variant !== sttFallback && warmDue(s.variant)) {
    void fetch(`/api/voice/stt?engine=${s.variant}&lang=${lang}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Float32Array(1600) }).catch(() => {});
  }
  // A cloned voice runs on the agent too (ZipVoice), with the same cold start.
  // The warm-up line is English: it is never played, and every voice reads it.
  const body = isNativeTts(t.variant) && t.variant !== ttsFallback ? { engine: t.variant, voice: t.voice || undefined, text: "Hi." }
    : t.family === "clone" && t.voice ? { profileId: t.voice, text: "Hi." } : null;
  if (body && warmDue(t.variant)) {
    void fetch("/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.arrayBuffer()).catch(() => {});
  }
}

const STT_WINDOW = 50 * 16000; // the agent refuses more than 60 s per request

/** O(samples); one request per 50 s window, so a long monologue still transcribes. */
async function nativeStt(engine: string, lang: LanguageCode, audio: Float32Array, signal?: AbortSignal): Promise<string> {
  const texts: string[] = [];
  for (let i = 0; i < audio.length; i += STT_WINDOW) {
    const res = await fetch(`/api/voice/stt?engine=${engine}&lang=${lang}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: audio.subarray(i, i + STT_WINDOW) as Float32Array<ArrayBuffer>,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw await httpError(res);
    texts.push(((await res.json()) as { text: string }).text.trim());
  }
  return texts.filter(Boolean).join(" ");
}

/** One downloadable variant, as GET /api/voice/engines lists it. */
export interface NativeEngineStatus {
  id: string; legacyId?: string; name: string; sizeBytes: number; quality: "fastest" | "fast" | "balanced" | "best";
  languages: string[]; streaming: boolean; latencyMs?: number; license: string;
  installed: boolean; downloading: boolean; bytes: number;
  voices?: { id: string; name: string; lang?: string; gender?: "female" | "male" }[];
}
export interface NativeFamilyStatus { family: string; kind: "asr" | "tts"; name: string; variants: NativeEngineStatus[] }

/** The agent's engine families, each with its variants' sizes, languages,
 *  licenses, voices and install state. */
export async function listNativeEngines(): Promise<NativeFamilyStatus[]> {
  const res = await fetch("/api/voice/engines");
  if (!res.ok) throw await httpError(res);
  return res.json();
}

/** Streams the agent's JSON-lines progress; resolves when installed, throws on
 *  failure or cancel. Aborting `signal` only stops listening: the agent keeps
 *  going until deleteNativeEngine cancels it. */
export async function downloadNativeEngine(id: string, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/voice/engines/${id}/download`, { method: "POST", signal });
  if (!res.ok || !res.body) throw await httpError(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("download ended early");
    const lines = (rest + value).split("\n");
    rest = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const m = JSON.parse(line) as { loaded?: number; total?: number; done?: boolean; error?: string };
      if (m.error) throw new Error(m.error);
      if (m.loaded != null && m.total) onProgress(m.loaded, m.total);
      if (m.done) return;
    }
  }
}

/** Deletes an engine's files on the agent (or cancels its download). */
export async function deleteNativeEngine(id: string): Promise<void> {
  const res = await fetch(`/api/voice/engines/${id}`, { method: "DELETE" });
  if (!res.ok) throw await httpError(res);
}

/** Transcribe a 16 kHz mono utterance → text, on the selected engine. Aborting
 *  `signal` drops a native request the agent has not started yet (an interim
 *  caption giving way to the final); it rejects and never falls back. */
export async function stt(audio: Float32Array, signal?: AbortSignal): Promise<string> {
  const engine = activeSttEngine();
  const lang = loadPipelineConfig().language;
  if (isNativeVariant(engine)) {
    try { return await nativeStt(engine, lang, audio, signal); }
    catch (e) { signal?.throwIfAborted(); nativeSttFailed(engine, e); }
  }
  // The checkpoint follows the language, so a switch mid-call swaps it on the next utterance.
  const model = whisperCheckpoint(loadPipelineConfig().stt.whisperSize, lang, deviceTier());
  const m = await call<{ text: string }>({ type: "stt", audio, lang, model });
  whisperLoaded = model;
  return m.text;
}

// Cloned-voice synthesis runs in the LOCAL agent service (ZipVoice via
// sherpa-onnx), reached through the same-origin /api/voice proxy. Falls back to
// the browser voice for the language if the model/profile is missing or the
// call fails: one toast per session, never a broken call.
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
      toast("Cloned voice unavailable, using a built-in voice. Check Settings → Voice.");
    }
    log.error("tts", "clone synth failed, falling back:", e);
    return null;
  }
}

/** `engine` is a variant id (a browser engine's is its family's). */
type TtsOpts = { engine?: string; voice?: string; speed?: number; lang?: LanguageCode };

// Nothing in the browser speaks the language (Chinese): said once per session,
// and the sentence goes unspoken instead of read wrong.
let noVoiceToasted = false;
/** The browser engine that stands in for `opts`' engine, or null (after one notice). */
function browserStandIn(opts: TtsOpts | undefined): TtsOpts | null {
  const lang = opts?.lang ?? "en";
  const engine = browserTtsFallback(lang);
  if (engine) return { engine, speed: opts?.speed, lang }; // the worker's default voice
  if (!noVoiceToasted) {
    noVoiceToasted = true;
    toast(`No voice for ${languageName(lang)} is ready. Download one in Settings > Voice pipeline.`);
  }
  return null;
}

// How long a native engine may go without sending audio before the sentence
// counts as stalled. Measured 2026-09-24 on Apple Silicon: first chunk 0.3-0.5 s
// (Pocket) and 0.4-0.85 s (a whole Kitten sentence) for a short sentence, but
// 1.2-1.5 s and ~2 s for a 200-character chunk with no punctuation (Kitten does
// it in one piece, ~10 ms a character); a cold load adds ~0.3 s. 4 s plus 50 ms
// a character is about 5x that for any length, room for a slow CPU, while a hung
// agent costs one sentence instead of the reply. A gap between chunks is at most
// the next Kitten sentence of the same text, so the same bound covers it.
const ttsStallMs = (text: string) => 4000 + 50 * text.length;

/** Speak `text`, handing each piece of audio to `onChunk` as soon as it exists:
 *  a native engine streams from the agent, the others arrive in one piece. A
 *  native engine that fails before any audio falls back to the browser voice
 *  for the language. Resolves once every piece is handed over; aborting
 *  `signal` ends it quietly. */
export async function ttsStream(text: string, opts: TtsOpts | undefined, onChunk: (audio: Float32Array, sampleRate: number) => void, signal?: AbortSignal): Promise<void> {
  const engine = opts?.engine;
  if (isNativeTts(engine) && engine !== ttsFallback) {
    let voiced = false;
    // A stalled agent aborts like a failure with no status: this sentence falls
    // back, the session keeps the engine (failureIsLasting is false for it).
    const stalled = new AbortController();
    const stallMs = ttsStallMs(text);
    let timer = setTimeout(() => stalled.abort(new Error("no audio in time")), stallMs);
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No voice: the agent picks the engine's first one that speaks `lang`.
        body: JSON.stringify({ engine, text, voice: opts?.voice || undefined, speed: opts?.speed, lang: opts?.lang }),
        signal: signal ? AbortSignal.any([signal, stalled.signal]) : stalled.signal,
      });
      if (!res.ok || !res.body) throw await httpError(res);
      const rate = Number(res.headers.get("x-sample-rate")) || 24000;
      const decode = pcmDecoder();
      const reader = res.body.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        const pcm = decode(r.value);
        if (!pcm.length) continue;
        clearTimeout(timer);
        timer = setTimeout(() => stalled.abort(new Error("audio stopped arriving")), stallMs);
        voiced = true;
        onChunk(pcm, rate);
      }
      return;
    } catch (e) {
      if (signal?.aborted) return;
      // Restarting a half-spoken sentence in another voice is worse than its tail missing.
      if (voiced) { log.warn("tts", `${engine} stream broke off:`, e); return; }
      const standIn = browserTtsFallback(opts?.lang ?? "en");
      log.error("tts", `${engine} failed, using ${standIn ?? "no voice"}:`, e);
      if (failureIsLasting(e) && ttsFallback !== engine) {
        ttsFallback = engine!;
        if (standIn) toast(`${familyName(engine!)} unavailable, using ${familyName(standIn)}. Check Settings > Voice pipeline.`);
      }
    } finally { clearTimeout(timer); }
  }
  if (isNativeTts(engine)) {
    const standIn = browserStandIn(opts);
    if (!standIn) return;
    opts = standIn;
  }
  const out = await tts(text, opts);
  if (!signal?.aborted && out.audio.length) onChunk(out.audio, out.sampleRate);
}

/** Synthesize a sentence → Float32 PCM + sample rate. Voice/speed come from the
 *  user's pipeline config; a cloned voice or a native engine routes to the local
 *  agent service and falls back to the browser voice for the language if
 *  unavailable (silence when there is none). */
export async function tts(text: string, opts?: TtsOpts): Promise<{ audio: Float32Array; sampleRate: number }> {
  if (isNativeTts(opts?.engine)) {
    const parts: Float32Array[] = [];
    let sampleRate = 24000;
    await ttsStream(text, opts, (a, r) => { parts.push(a); sampleRate = r; });
    const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((off, p) => { audio.set(p, off); return off + p.length; }, 0);
    return { audio, sampleRate };
  }
  // A browser or cloned voice that does not speak the language (a config set
  // without pickCompatible) reads it wrong: the stand-in speaks it instead.
  if (opts?.engine && opts.lang && !languageSupport(opts.engine, opts.lang)) {
    const standIn = browserStandIn(opts);
    if (!standIn) return { audio: new Float32Array(0), sampleRate: 24000 };
    opts = standIn;
  }
  if (opts?.engine === "clone") {
    const cloned = opts.voice ? await cloneTts(text, opts.voice, opts.speed) : null;
    if (cloned) return cloned;
    const standIn = browserStandIn(opts);
    if (!standIn) return { audio: new Float32Array(0), sampleRate: 24000 };
    opts = standIn;
  }
  const m = await call<{ audio: Float32Array; sampleRate: number }>({ type: "tts", text, engine: opts?.engine, voice: opts?.voice, speed: opts?.speed, lang: opts?.lang });
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

