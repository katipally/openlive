// Browser-only config for the on-device voice pipeline (VAD · STT · turn · TTS).
// Lives in localStorage because the whole pipeline runs in the renderer — the
// agent server never touches VAD/STT/TTS, so there's nothing to persist
// server-side. Read fresh on each TTS/turn call so a settings change applies to
// the next spoken sentence with no restart; VAD knobs are baked into MicVAD at
// construction, so they apply on the next session start.

export type WhisperSize = "tiny" | "base" | "small" | "large-v3-turbo";
export const WHISPER_SIZE_IDS: readonly WhisperSize[] = ["tiny", "base", "small", "large-v3-turbo"];
export type TurnEngine = "smart-turn" | "silence";
export type TtsEngine = "kokoro" | "supertonic";
export const TTS_ENGINE_IDS: readonly TtsEngine[] = ["kokoro", "supertonic"];

export interface PipelineConfig {
  stt: { whisperSize: WhisperSize };                        // Whisper.en model size (applies on reload)
  tts: { engine: TtsEngine; voice: string; speed: number }; // TTS engine + voice id + speaking rate
  turn: { engine: TurnEngine; threshold: number; holdMs: number }; // Smart-Turn (semantic) vs silence timeout; sigmoid cutoff (0..1); max mid-thought hold before auto-send
  vad: { speechThreshold: number; redemptionMs: number };   // Silero sensitivity + trailing silence before a turn ends
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  stt: { whisperSize: "base" },
  tts: { engine: "kokoro", voice: "af_heart", speed: 1 },
  turn: { engine: "smart-turn", threshold: 0.5, holdMs: 4000 },
  vad: { speechThreshold: 0.5, redemptionMs: 550 },
};

// Menus for the Pipeline settings UI. STT engines beyond Whisper (Moonshine) and
// TTS engines beyond Kokoro (Piper/Kitten) are deferred: they need a new browser
// runtime/dep and a real device test before shipping — one registry+worker branch
// each. ponytail: don't add an engine the on-device load can't be verified to boot.
// Defaults are tuned for modest devices; the bigger models are opt-in for machines
// that can carry them (WebGPU only — WASM always runs tiny regardless).
export const WHISPER_SIZES: { id: WhisperSize; name: string }[] = [
  { id: "tiny", name: "Tiny — fastest, least accurate (~120 MB)" },
  { id: "base", name: "Base — balanced, default (~290 MB)" },
  { id: "small", name: "Small — more accurate, heavier (~950 MB)" },
  { id: "large-v3-turbo", name: "Large v3 Turbo — best accuracy, multilingual (~1.6 GB)" },
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

export const TTS_ENGINES: { id: TtsEngine; name: string; voices: VoiceOption[]; defaultVoice: string }[] = [
  { id: "kokoro", name: "Kokoro — natural, 28 voices (~82 MB)", voices: KOKORO_VOICES, defaultVoice: "af_heart" },
  { id: "supertonic", name: "Supertonic — fastest, 10 voices (~400 MB)", voices: SUPERTONIC_VOICES, defaultVoice: "M1" },
];
const engineOf = (id: TtsEngine) => TTS_ENGINES.find((e) => e.id === id)!;

const num = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const oneOf = <T extends string>(x: unknown, allowed: readonly T[], d: T): T => (allowed.includes(x as T) ? (x as T) : d);

/** Clamp every field into a safe range; unknown enums/voice fall back to defaults. Pure. */
export function clampPipelineConfig(c: PipelineConfig): PipelineConfig {
  const d = DEFAULT_PIPELINE_CONFIG;
  const engine = oneOf(c.tts.engine, TTS_ENGINE_IDS, d.tts.engine);
  const eng = engineOf(engine);
  return {
    stt: { whisperSize: oneOf(c.stt.whisperSize, WHISPER_SIZE_IDS, d.stt.whisperSize) },
    tts: {
      engine,
      // The voice must belong to the selected engine; a stale/foreign id falls
      // back to that engine's default (e.g. after an engine switch).
      voice: eng.voices.some((v) => v.id === c.tts.voice) ? c.tts.voice : eng.defaultVoice,
      speed: clamp(c.tts.speed, 0.5, 2),
    },
    turn: { engine: oneOf(c.turn.engine, ["smart-turn", "silence"], d.turn.engine), threshold: clamp(c.turn.threshold, 0, 1), holdMs: clamp(Math.round(num(c.turn.holdMs, d.turn.holdMs)), 1000, 8000) },
    vad: {
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
    stt: { whisperSize: oneOf(p.stt?.whisperSize, WHISPER_SIZE_IDS, d.stt.whisperSize) },
    tts: { engine: oneOf(p.tts?.engine, TTS_ENGINE_IDS, d.tts.engine), voice: typeof p.tts?.voice === "string" ? p.tts.voice : d.tts.voice, speed: num(p.tts?.speed, d.tts.speed) },
    turn: { engine: oneOf(p.turn?.engine, ["smart-turn", "silence"], d.turn.engine), threshold: num(p.turn?.threshold, d.turn.threshold), holdMs: num(p.turn?.holdMs, d.turn.holdMs) },
    vad: { speechThreshold: num(p.vad?.speechThreshold, d.vad.speechThreshold), redemptionMs: num(p.vad?.redemptionMs, d.vad.redemptionMs) },
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

export function savePipelineConfig(c: PipelineConfig): PipelineConfig {
  const clamped = clampPipelineConfig(c);
  try { localStorage.setItem(KEY, JSON.stringify(clamped)); } catch { /* private mode / SSR */ }
  return clamped;
}
