// Browser-only config for the on-device voice pipeline (VAD · STT · turn · TTS).
// Lives in localStorage because the whole pipeline runs in the renderer — the
// agent server never touches VAD/STT/TTS, so there's nothing to persist
// server-side. Read fresh on each TTS/turn call so a settings change applies to
// the next spoken sentence with no restart; VAD knobs are baked into MicVAD at
// construction, so they apply on the next session start.

export type WhisperSize = "tiny" | "base" | "small";
export type TurnEngine = "smart-turn" | "silence";

export interface PipelineConfig {
  stt: { whisperSize: WhisperSize };                        // Whisper.en model size (applies on reload)
  tts: { voice: string; speed: number };                    // Kokoro voice id + speaking rate
  turn: { engine: TurnEngine; threshold: number };          // Smart-Turn (semantic) vs silence timeout; sigmoid cutoff (0..1)
  vad: { speechThreshold: number; redemptionMs: number };   // Silero sensitivity + trailing silence before a turn ends
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  stt: { whisperSize: "base" },
  tts: { voice: "af_heart", speed: 1 },
  turn: { engine: "smart-turn", threshold: 0.5 },
  vad: { speechThreshold: 0.5, redemptionMs: 550 },
};

// Menus for the Pipeline settings UI. STT engines beyond Whisper (Moonshine) and
// TTS engines beyond Kokoro (Piper/Kitten) are deferred: they need a new browser
// runtime/dep and a real device test before shipping — one registry+worker branch
// each. ponytail: don't add an engine the on-device load can't be verified to boot.
export const WHISPER_SIZES: { id: WhisperSize; name: string }[] = [
  { id: "tiny", name: "Tiny — fastest, least accurate" },
  { id: "base", name: "Base — balanced (default)" },
  { id: "small", name: "Small — most accurate, heaviest" },
];
export const TURN_ENGINES: { id: TurnEngine; name: string }[] = [
  { id: "smart-turn", name: "Smart-Turn v3 — semantic end-of-turn" },
  { id: "silence", name: "Silence timeout — VAD only, no model" },
];

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

const num = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const oneOf = <T extends string>(x: unknown, allowed: readonly T[], d: T): T => (allowed.includes(x as T) ? (x as T) : d);

/** Clamp every field into a safe range; unknown enums/voice fall back to defaults. Pure. */
export function clampPipelineConfig(c: PipelineConfig): PipelineConfig {
  const d = DEFAULT_PIPELINE_CONFIG;
  return {
    stt: { whisperSize: oneOf(c.stt.whisperSize, ["tiny", "base", "small"], d.stt.whisperSize) },
    tts: {
      voice: KOKORO_VOICES.some((v) => v.id === c.tts.voice) ? c.tts.voice : d.tts.voice,
      speed: clamp(c.tts.speed, 0.5, 2),
    },
    turn: { engine: oneOf(c.turn.engine, ["smart-turn", "silence"], d.turn.engine), threshold: clamp(c.turn.threshold, 0, 1) },
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
    stt: { whisperSize: oneOf(p.stt?.whisperSize, ["tiny", "base", "small"], d.stt.whisperSize) },
    tts: { voice: typeof p.tts?.voice === "string" ? p.tts.voice : d.tts.voice, speed: num(p.tts?.speed, d.tts.speed) },
    turn: { engine: oneOf(p.turn?.engine, ["smart-turn", "silence"], d.turn.engine), threshold: num(p.turn?.threshold, d.turn.threshold) },
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
