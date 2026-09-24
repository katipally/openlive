// Browser-only config for the voice pipeline (VAD · STT · turn · TTS).
// Lives in localStorage because the renderer drives the whole pipeline: the
// in-browser models run here, and the native engines are stateless calls to
// the local agent, so there's nothing to persist server-side. Read fresh on
// each TTS/turn call so a settings change applies to
// the next spoken sentence with no restart; VAD knobs are baked into MicVAD at
// construction, so they apply on the next session start.

export type WhisperSize = "tiny" | "base" | "small" | "large-v3-turbo";
export const WHISPER_SIZE_IDS: readonly WhisperSize[] = ["tiny", "base", "small", "large-v3-turbo"];
export type SttEngine = "whisper" | "nemotron" | "parakeet" | "moonshine";
export const STT_ENGINE_IDS: readonly SttEngine[] = ["whisper", "nemotron", "parakeet", "moonshine"];
export type VadModel = "v6" | "v5";
export const VAD_MODEL_IDS: readonly VadModel[] = ["v6", "v5"];
export type TurnEngine = "smart-turn" | "silence";
export type TtsEngine = "kokoro" | "supertonic" | "clone" | "pocket" | "kitten";
export const TTS_ENGINE_IDS: readonly TtsEngine[] = ["kokoro", "supertonic", "clone", "pocket", "kitten"];

export interface PipelineConfig {
  stt: { engine: SttEngine; whisperSize: WhisperSize };     // STT engine; Whisper.en model size (applies on reload)
  tts: { engine: TtsEngine; voice: string; speed: number }; // TTS engine + voice id + speaking rate
  turn: { engine: TurnEngine; threshold: number; holdMs: number }; // Smart-Turn (semantic) vs silence timeout; sigmoid cutoff (0..1); max mid-thought hold before auto-send
  vad: { model: VadModel; speechThreshold: number; redemptionMs: number }; // Silero weights + sensitivity + trailing silence before a turn ends
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  stt: { engine: "whisper", whisperSize: "base" },
  tts: { engine: "kokoro", voice: "af_heart", speed: 1 },
  turn: { engine: "smart-turn", threshold: 0.5, holdMs: 4000 },
  vad: { model: "v6", speechThreshold: 0.5, redemptionMs: 550 },
};

// Menus for the Pipeline settings UI. Whisper runs in the browser; the native
// engines run on the local agent's CPU (services/agent/src/voice/native-models.ts
// holds their downloads, sizes are the archive bytes there). A streaming engine
// transcribes while you talk instead of after you stop.
export const STT_ENGINES: { id: SttEngine; name: string; native: boolean; streaming: boolean; note?: string }[] = [
  { id: "whisper", name: "Whisper (in the browser, size below)", native: false, streaming: false },
  { id: "nemotron", name: "Nemotron Streaming 0.6B (~464 MB)", native: true, streaming: true, note: "NVIDIA Open Model License" },
  { id: "parakeet", name: "Parakeet TDT 0.6B v2 (~482 MB)", native: true, streaming: false, note: "CC BY 4.0" },
  { id: "moonshine", name: "Moonshine Base (~111 MB): fastest, less accurate on long speech", native: true, streaming: false, note: "MIT" },
];
export const isNativeStt = (id: SttEngine): id is Exclude<SttEngine, "whisper"> => id !== "whisper";

// Defaults are tuned for modest devices; the bigger models are opt-in for machines
// that can carry them (WebGPU only — WASM always runs tiny regardless).
export const WHISPER_SIZES: { id: WhisperSize; name: string }[] = [
  { id: "tiny", name: "Tiny — fastest, least accurate (~120 MB)" },
  { id: "base", name: "Base — balanced, default (~290 MB)" },
  { id: "small", name: "Small — more accurate, heavier (~950 MB)" },
  { id: "large-v3-turbo", name: "Large v3 Turbo — best accuracy, multilingual (~1.6 GB)" },
];
// vad-web ships Silero v6.2 as "v6"; same network and frame size as v5, only
// retrained weights, so v5 stays selectable for A/B on hardware where v6 misbehaves.
export const VAD_MODELS: { id: VadModel; name: string }[] = [
  { id: "v6", name: "Silero v6.2 (default): fewer errors on noise, soft and phone-quality voices" },
  { id: "v5", name: "Silero v5: the previous model" },
];
export const TURN_ENGINES: { id: TurnEngine; name: string }[] = [
  { id: "smart-turn", name: "Smart-Turn v3 — semantic end-of-turn" },
  { id: "silence", name: "Silence timeout — VAD only, no model" },
];

// Turn-taking presets: one knob for the three raw values (trailing silence,
// end-of-turn threshold, mid-thought hold). Derived, not stored — the active
// preset is whichever one matches the current values ("custom" otherwise), so
// editing a raw slider naturally drops out of the preset.
export interface TurnPresetValues { redemptionMs: number; threshold: number; holdMs: number }
export const TURN_PRESETS: { id: "relaxed" | "balanced" | "snappy"; name: string; desc: string; values: TurnPresetValues }[] = [
  { id: "relaxed", name: "Relaxed", desc: "Waits you out — best for thinking aloud", values: { redemptionMs: 800, threshold: 0.65, holdMs: 6000 } },
  { id: "balanced", name: "Balanced", desc: "The default give-and-take", values: { redemptionMs: 550, threshold: 0.5, holdMs: 4000 } },
  { id: "snappy", name: "Snappy", desc: "Replies fast — best for quick commands", values: { redemptionMs: 350, threshold: 0.35, holdMs: 2500 } },
];
export function activeTurnPreset(c: PipelineConfig): "relaxed" | "balanced" | "snappy" | "custom" {
  const hit = TURN_PRESETS.find((p) =>
    p.values.redemptionMs === c.vad.redemptionMs && p.values.threshold === c.turn.threshold && p.values.holdMs === c.turn.holdMs);
  return hit?.id ?? "custom";
}

export interface VoiceOption { id: string; name: string; accent: "American" | "British"; gender: "Female" | "Male" }

// The 28 English Kokoro voices shipped in kokoro-js 1.2.1 (its `.voices` getter).
// ponytail: hardcoded — stable for this model version; update the list if kokoro-js
// changes its English set. Non-English .bin voices exist but the English-only
// assistant phonemizes them poorly, so they're intentionally omitted.
const VOICE_IDS = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
  "bm_george", "bm_lewis", "bm_daniel", "bm_fable",
];
export const KOKORO_VOICES: VoiceOption[] = VOICE_IDS.map((id) => ({
  id,
  name: id.slice(3).replace(/^./, (c) => c.toUpperCase()),
  accent: id[0] === "b" ? "British" : "American",
  gender: id[1] === "f" ? "Female" : "Male",
}));

// Supertonic's ten preset styles (supertonic-3). Faster/lower-latency than Kokoro;
// English voice list here (the model itself is multilingual — deferred).
export const SUPERTONIC_VOICES: VoiceOption[] = (["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"] as const).map((id) => ({
  id,
  name: `${id[0] === "M" ? "Male" : "Female"} ${id[1]}`,
  accent: "American",
  gender: id[0] === "M" ? "Male" : "Female",
}));

// Pocket TTS clones one of the reference clips its archive ships. Its French
// clip (hibiki) is left out: the assistant speaks English only.
export const POCKET_VOICES: VoiceOption[] = [
  { id: "bria", name: "Bria", accent: "American", gender: "Female" },
  { id: "loona", name: "Loona", accent: "American", gender: "Female" },
];
// Kitten TTS Nano's eight voices, in the agent's speaker-id order.
export const KITTEN_VOICES: VoiceOption[] = ([
  ["jasper", "Male"], ["bella", "Female"], ["bruno", "Male"], ["luna", "Female"],
  ["hugo", "Male"], ["rosie", "Female"], ["leo", "Male"], ["kiki", "Female"],
] as const).map(([id, gender]) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), accent: "American", gender }));

export const TTS_ENGINES: { id: TtsEngine; name: string; voices: VoiceOption[]; defaultVoice: string; native?: boolean; note?: string }[] = [
  { id: "kokoro", name: "Kokoro — natural, 28 voices (~82 MB)", voices: KOKORO_VOICES, defaultVoice: "af_heart" },
  { id: "supertonic", name: "Supertonic — fastest, 10 voices (~400 MB)", voices: SUPERTONIC_VOICES, defaultVoice: "M1" },
  // Cloned voices (Voice Studio): synthesis runs in the local agent service
  // (ZipVoice via sherpa-onnx); `voice` holds a profile id, and the runtime
  // falls back to Kokoro if the model/profile is missing.
  { id: "clone", name: "Your voice — cloned in Voice Studio (~208 MB)", voices: [], defaultVoice: "" },
  // Native engines: synthesized on the local agent and streamed as it goes, so
  // speech starts before the sentence is finished. Fall back to Kokoro if missing.
  { id: "pocket", name: "Pocket TTS, streams the fastest (~98 MB)", voices: POCKET_VOICES, defaultVoice: "bria", native: true,
    note: "Non-commercial use only (the sherpa-onnx package terms)" },
  { id: "kitten", name: "Kitten TTS Nano, lightest, 8 voices (~31 MB)", voices: KITTEN_VOICES, defaultVoice: "bella", native: true, note: "Apache 2.0" },
];
const engineOf = (id: TtsEngine) => TTS_ENGINES.find((e) => e.id === id)!;

/** The weights the in-browser model worker loads for `c`, as a cache tag. A
 *  native engine loads nothing there, so moving between native engines neither
 *  reloads the worker nor asks for a download. WASM always runs Whisper tiny. Pure. */
export function workerTag(c: PipelineConfig, tier: "webgpu" | "wasm"): string {
  const stt = isNativeStt(c.stt.engine) ? "native" : tier === "wasm" ? "tiny" : c.stt.whisperSize;
  return `${tier}:${stt}:${engineOf(c.tts.engine).native ? "native" : c.tts.engine}`;
}

/** Whether everything `tag` needs in the browser was already loaded under one of
 *  `loaded`, part by part and on the same tier: a switch to a native engine needs
 *  nothing new, and Smart-Turn comes with every load. Pure, O(loaded). */
export function tagCached(tag: string, loaded: string[]): boolean {
  const [tier, stt, tts] = tag.split(":");
  const same = loaded.map((t) => t.split(":")).filter((p) => p[0] === tier);
  return same.length > 0
    && (stt === "native" || same.some((p) => p[1] === stt))
    && (tts === "native" || same.some((p) => p[2] === tts));
}

/** What the in-browser worker downloads for `c`, in the words the UI uses:
 *  turn-taking always, speech and voice only where no native engine replaces
 *  them (a cloned voice keeps Kokoro as its fallback). Pure. */
export function browserModels(c: PipelineConfig): string[] {
  return [
    ...(isNativeStt(c.stt.engine) ? [] : ["speech"]),
    ...(engineOf(c.tts.engine).native ? [] : ["voice"]),
    "turn-taking",
  ];
}

const num = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const oneOf = <T extends string>(x: unknown, allowed: readonly T[], d: T): T => (allowed.includes(x as T) ? (x as T) : d);

/** Clamp every field into a safe range; unknown enums/voice fall back to defaults. Pure. */
export function clampPipelineConfig(c: PipelineConfig): PipelineConfig {
  const d = DEFAULT_PIPELINE_CONFIG;
  const engine = oneOf(c.tts.engine, TTS_ENGINE_IDS, d.tts.engine);
  const eng = engineOf(engine);
  return {
    stt: { engine: oneOf(c.stt.engine, STT_ENGINE_IDS, d.stt.engine), whisperSize: oneOf(c.stt.whisperSize, WHISPER_SIZE_IDS, d.stt.whisperSize) },
    tts: {
      engine,
      // The voice must belong to the selected engine; a stale/foreign id falls
      // back to that engine's default (e.g. after an engine switch). Clone
      // voices are profile ids (dynamic) — validated at synth time instead.
      voice: engine === "clone" || eng.voices.some((v) => v.id === c.tts.voice) ? c.tts.voice : eng.defaultVoice,
      speed: clamp(c.tts.speed, 0.5, 2),
    },
    turn: { engine: oneOf(c.turn.engine, ["smart-turn", "silence"], d.turn.engine), threshold: clamp(c.turn.threshold, 0, 1), holdMs: clamp(Math.round(num(c.turn.holdMs, d.turn.holdMs)), 1000, 8000) },
    vad: {
      model: oneOf(c.vad.model, VAD_MODEL_IDS, d.vad.model),
      speechThreshold: clamp(c.vad.speechThreshold, 0.1, 0.9),
      redemptionMs: clamp(Math.round(c.vad.redemptionMs), 200, 1500),
    },
  };
}

/** Merge an untrusted partial (parsed JSON) over the defaults, then clamp. Pure. */
export function mergePipelineConfig(partial: unknown): PipelineConfig {
  const p = (partial ?? {}) as Partial<{ [K in keyof PipelineConfig]: Partial<PipelineConfig[K]> }>;
  const d = DEFAULT_PIPELINE_CONFIG;
  return clampPipelineConfig({
    stt: { engine: oneOf(p.stt?.engine, STT_ENGINE_IDS, d.stt.engine), whisperSize: oneOf(p.stt?.whisperSize, WHISPER_SIZE_IDS, d.stt.whisperSize) },
    tts: { engine: oneOf(p.tts?.engine, TTS_ENGINE_IDS, d.tts.engine), voice: typeof p.tts?.voice === "string" ? p.tts.voice : d.tts.voice, speed: num(p.tts?.speed, d.tts.speed) },
    turn: { engine: oneOf(p.turn?.engine, ["smart-turn", "silence"], d.turn.engine), threshold: num(p.turn?.threshold, d.turn.threshold), holdMs: num(p.turn?.holdMs, d.turn.holdMs) },
    vad: { model: oneOf(p.vad?.model, VAD_MODEL_IDS, d.vad.model), speechThreshold: num(p.vad?.speechThreshold, d.vad.speechThreshold), redemptionMs: num(p.vad?.redemptionMs, d.vad.redemptionMs) },
  });
}

const KEY = "openlive-pipeline-v1";

export function loadPipelineConfig(): PipelineConfig {
  if (typeof window === "undefined") return DEFAULT_PIPELINE_CONFIG;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? mergePipelineConfig(JSON.parse(raw)) : DEFAULT_PIPELINE_CONFIG;
  } catch { return DEFAULT_PIPELINE_CONFIG; }
}

// The Voice tab edits this config from three places at once (speed, engine,
// cloned voice). Each holds a copy in state; without a change signal one saving
// its stale copy would silently undo another's edit.
const listeners = new Set<(c: PipelineConfig) => void>();
export function onPipelineConfig(fn: (c: PipelineConfig) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function savePipelineConfig(c: PipelineConfig): PipelineConfig {
  const clamped = clampPipelineConfig(c);
  try { localStorage.setItem(KEY, JSON.stringify(clamped)); } catch { /* private mode / SSR */ }
  for (const fn of listeners) fn(clamped);
  return clamped;
}
