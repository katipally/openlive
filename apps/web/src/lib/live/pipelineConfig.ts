// Browser-only config for the voice pipeline (VAD · STT · turn · TTS).
// Lives in localStorage because the renderer drives the whole pipeline: the
// in-browser models run here, and the native engines are stateless calls to
// the local agent, so there's nothing to persist server-side. Read fresh on
// each TTS/turn call so a settings change applies to
// the next spoken sentence with no restart; VAD knobs are baked into MicVAD at
// construction, so they apply on the next session start.

import { LANGUAGE_CODES, type LanguageCode } from "@openlive/shared";
import type { LexiconEntry } from "@openlive/shared/speech/lexicon";

export type WhisperSize = "tiny" | "base" | "small" | "large-v3-turbo";
export const WHISPER_SIZE_IDS: readonly WhisperSize[] = ["tiny", "base", "small", "large-v3-turbo"];
export type VadModel = "v6" | "v5";
export const VAD_MODEL_IDS: readonly VadModel[] = ["v6", "v5"];
export type TurnEngine = "smart-turn" | "silence";
export type Stage = "stt" | "tts";

/** An engine and the variant of it in use. `variants` remembers the last
 *  variant picked per family, so switching back to a family restores it. */
export interface StageChoice { family: string; variant: string; variants: Record<string, string> }

export interface PipelineConfig {
  language: LanguageCode;                                        // what the user speaks, and what every stage (and the reply) follows
  stt: StageChoice & { whisperSize: WhisperSize };               // STT engine; Whisper's size (applies on reload)
  tts: StageChoice & { voice: string; speed: number };           // TTS engine + voice id ("" = the engine's own pick) + speaking rate
  turn: { engine: TurnEngine; threshold: number; holdMs: number }; // Smart-Turn (semantic) vs silence timeout; sigmoid cutoff (0..1); max mid-thought hold before auto-send
  vad: { model: VadModel; speechThreshold: number; redemptionMs: number }; // Silero weights + sensitivity + trailing silence before a turn ends
  pronunciations: LexiconEntry[];                                // the user's dictionary: how the voice says a word or name
  allowRestricted: boolean;                                      // the user's OK to pick models under a restricted license (`restricted`)
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  language: "en",
  stt: { family: "whisper", variant: "whisper", variants: { whisper: "whisper" }, whisperSize: "base" },
  tts: { family: "kokoro", variant: "kokoro", variants: { kokoro: "kokoro" }, voice: "af_heart", speed: 1 },
  turn: { engine: "smart-turn", threshold: 0.5, holdMs: 4000 },
  vad: { model: "v6", speechThreshold: 0.5, redemptionMs: 550 },
  pronunciations: [],
  allowRestricted: false,
};

/** The languages a session can run in, named in English and in their own script. */
export const CURATED_LANGUAGES: { code: LanguageCode; name: string; native: string }[] = [
  { code: "en", name: "English", native: "English" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "fr", name: "French", native: "Français" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "it", name: "Italian", native: "Italiano" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "zh", name: "Chinese (Mandarin)", native: "中文" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "ko", name: "Korean", native: "한국어" },
];

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

/** `accent` groups the voices: an English accent, or a language for a catalog voice. */
export interface VoiceOption { id: string; name: string; accent: string; gender: "Female" | "Male" }

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
// a style is a speaker, not a language, so each reads every language Supertonic does.
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

// ── engine families ──────────────────────────────────────────────────────────
// Whisper, Kokoro, Supertonic run in the browser (one variant each, its id the
// family's); the rest run on the local agent, which lists the same families
// with sizes, licenses, voices and install state (GET /api/voice/engines). The
// native rows below mirror services/agent/src/voice/native-models.ts, cut to
// the curated languages, so a config validates with the agent offline;
// services/agent/src/voice/web-catalog.test.ts keeps the two in step.

/** `restricted`: its license is outside MIT, Apache, BSD and CC BY (engineMenu.ts
 *  licenseTag), so it is picked only once the user allows it. */
export interface EngineVariantInfo { id: string; languages: readonly LanguageCode[]; streaming?: boolean; legacy?: string; restricted?: true }
export interface EngineFamilyInfo {
  id: string;
  stage: Stage;
  name: string;
  native: boolean;
  /** The model's license, shown on its engine card (Piper's differs per voice). */
  note?: string;
  licenseUrl?: string;
  /** What a restricted variant's license limits, said before the user allows it. */
  restriction?: string;
  variants: EngineVariantInfo[];
  defaultVariant: string;
  /** A language whose default is not `defaultVariant` (Piper's voices are one language each). */
  byLanguage?: Partial<Record<LanguageCode, string>>;
  /** Voices known without the agent; a family without them lists its voices in the agent's catalog. */
  voices?: VoiceOption[];
  defaultVoice?: string;
  /** A browser engine the agent can also run on this computer, once downloaded there (models.ts agentCopy). */
  onAgent?: true;
}

const ALL = LANGUAGE_CODES;
const EN: readonly LanguageCode[] = ["en"];
const langs = (s: string) => s.split(" ") as LanguageCode[];
const variants = (ids: string, languages: readonly LanguageCode[], extra: Omit<EngineVariantInfo, "id" | "languages"> = {}) =>
  ids.split(" ").map((id) => ({ id, languages, ...extra }));
const one = (id: string, languages: readonly LanguageCode[]): EngineVariantInfo[] => [{ id, languages }];
const restrict = (vs: EngineVariantInfo[]): EngineVariantInfo[] => vs.map((v) => ({ ...v, restricted: true }));
const PIPER_IDS = "en_US-lessac-low-int8 en_US-lessac-medium-int8 en_US-lessac-high-int8 en_US-amy-low-int8 en_US-amy-medium-int8 "
  + "en_US-ryan-low-int8 en_US-ryan-medium-int8 en_US-ryan-high-int8 en_US-libritts_r-medium-int8 es_ES-davefx-medium-int8 "
  + "es_ES-sharvard-medium-int8 es_AR-daniela-high-int8 fr_FR-siwis-low-int8 fr_FR-siwis-medium-int8 fr_FR-tom-medium-int8 "
  + "fr_FR-upmc-medium-int8 de_DE-thorsten-low-int8 de_DE-thorsten-medium-int8 de_DE-thorsten-high-int8 de_DE-kerstin-low-int8 "
  + "de_DE-ramona-low-int8 it_IT-paola-medium-int8 it_IT-riccardo-x_low-int8 pt_BR-faber-medium-int8 pt_BR-cadu-medium-int8 "
  + "pt_PT-tugao-medium-int8 hi_IN-pratham-medium-int8 hi_IN-priyamvada-medium-int8 hi_IN-rohan-medium-int8 "
  + "zh_CN-chaowen-medium-int8 zh_CN-xiao_ya-medium-int8 zh_CN-huayan-medium";
// Voices whose own data is CC0, CC BY or BSD-style, whatever voice they were
// fine-tuned from; the rest are research-only, non-commercial, share-alike,
// AGPL or unknown (licenses in native-models.ts PIPER).
const PIPER_OPEN = new Set(["en_US-libritts_r", "es_ES-davefx", "es_ES-sharvard", "fr_FR-siwis", "de_DE-thorsten", "de_DE-kerstin",
  "de_DE-ramona", "it_IT-riccardo", "pt_BR-faber", "pt_BR-cadu", "pt_PT-tugao", "zh_CN-chaowen"]);
const KOKORO_MULTI = langs("en es fr hi it pt zh");

export const STT_FAMILIES: EngineFamilyInfo[] = [
  { id: "whisper", stage: "stt", name: "Whisper", native: false, note: "Apache 2.0", variants: one("whisper", ALL), defaultVariant: "whisper" },
  {
    id: "nemotron", stage: "stt", name: "Nemotron Streaming", native: true, note: "NVIDIA Open Model License",
    licenseUrl: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
    variants: variants("nemotron-en-80ms-int8 nemotron-en-160ms-int8 nemotron-en-560ms-int8 nemotron-en-1120ms-int8", EN, { streaming: true })
      .map((v) => (v.id === "nemotron-en-160ms-int8" ? { ...v, legacy: "nemotron" } : v)),
    defaultVariant: "nemotron-en-160ms-int8",
  },
  {
    id: "nemotron-3.5", stage: "stt", name: "Nemotron 3.5 Streaming", native: true, note: "OpenMDW-1.1",
    variants: variants("nemotron-3.5-80ms-int8 nemotron-3.5-160ms-int8 nemotron-3.5-320ms-int8 nemotron-3.5-560ms-int8 nemotron-3.5-1120ms-int8", ALL, { streaming: true }),
    defaultVariant: "nemotron-3.5-160ms-int8",
  },
  {
    id: "parakeet", stage: "stt", name: "Parakeet TDT", native: true, note: "CC BY 4.0",
    variants: [
      { id: "parakeet-110m-int8", languages: EN },
      { id: "parakeet-0.6b-v2-int8", languages: EN, legacy: "parakeet" },
      { id: "parakeet-0.6b-v2-fp16", languages: EN },
      { id: "parakeet-0.6b-v3-int8", languages: langs("en es fr de it pt") },
    ],
    defaultVariant: "parakeet-0.6b-v2-int8",
  },
  {
    id: "moonshine", stage: "stt", name: "Moonshine", native: true, note: "MIT",
    variants: [{ id: "moonshine-tiny-en-int8", languages: EN }, { id: "moonshine-base-en-int8", languages: EN, legacy: "moonshine" }],
    defaultVariant: "moonshine-base-en-int8",
  },
  { id: "canary", stage: "stt", name: "Canary", native: true, note: "CC BY 4.0", variants: one("canary-180m-flash-int8", langs("en es de fr")), defaultVariant: "canary-180m-flash-int8" },
];

export const TTS_FAMILIES: EngineFamilyInfo[] = [
  { id: "kokoro", stage: "tts", name: "Kokoro", native: false, note: "Apache 2.0", variants: one("kokoro", EN), defaultVariant: "kokoro", voices: KOKORO_VOICES, defaultVoice: "af_heart" },
  // Verified 2026-09-24 against huggingface.co/Supertone/supertonic-3: 31
  // languages, Chinese not among them; the language rides as a tag (supertonic.ts).
  {
    id: "supertonic", stage: "tts", name: "Supertonic", native: false, variants: one("supertonic", langs("en es fr de it pt hi ja ko")),
    note: "OpenRAIL-M, with use restrictions", licenseUrl: "https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE",
    defaultVariant: "supertonic", voices: SUPERTONIC_VOICES, defaultVoice: "M1", onAgent: true,
  },
  // Cloned voices (Voice Studio): synthesis runs in the local agent service
  // (ZipVoice via sherpa-onnx, English and Chinese); `voice` holds a profile
  // id, and the runtime falls back to a browser voice if it is missing.
  // ZipVoice's code is Apache 2.0; its weights state no license (checked 2026-09-25).
  {
    id: "clone", stage: "tts", name: "Your voice", native: false, note: "ZipVoice, weights' license unstated", licenseUrl: "https://github.com/k2-fsa/ZipVoice",
    restriction: "ZipVoice's weights state no license, and it was trained on Emilia, which is for non-commercial use (CC BY-NC 4.0)",
    variants: restrict(one("clone", langs("en zh"))), defaultVariant: "clone", defaultVoice: "",
  },
  // Native engines: synthesized on the local agent and streamed as it goes, so
  // speech starts before the sentence is finished.
  {
    id: "pocket", stage: "tts", name: "Pocket TTS", native: true, note: "Non-commercial use only (the sherpa-onnx package terms)",
    licenseUrl: "https://huggingface.co/KevinAHM/pocket-tts-onnx/blob/main/onnx/LICENSE", restriction: "The ONNX export it runs is for non-commercial use only",
    variants: restrict([{ id: "pocket-int8", languages: EN, legacy: "pocket" }, { id: "pocket-fp32", languages: EN }]),
    defaultVariant: "pocket-int8", voices: POCKET_VOICES, defaultVoice: "bria",
  },
  {
    id: "kitten", stage: "tts", name: "Kitten TTS", native: true, note: "Apache 2.0",
    variants: [{ id: "kitten-nano-int8", languages: EN, legacy: "kitten" }, ...variants("kitten-micro-fp32 kitten-mini-fp32", EN)],
    defaultVariant: "kitten-nano-int8", voices: KITTEN_VOICES, defaultVoice: "bella",
  },
  {
    id: "piper", stage: "tts", name: "Piper", native: true, note: "License per voice, under Model", licenseUrl: "https://huggingface.co/rhasspy/piper-voices",
    restriction: "Some Piper voices were trained on research-only, non-commercial, share-alike or unknown-license data; each voice's terms are under Model",
    variants: PIPER_IDS.split(" ").map((v) => ({
      id: `piper-${v}`, languages: [v.slice(0, 2) as LanguageCode], ...(PIPER_OPEN.has(v.split("-", 2).join("-")) ? {} : { restricted: true as const }),
    })),
    defaultVariant: "piper-en_US-lessac-medium-int8",
    // Each language's pick; a restricted one (it, hi) waits for the user's OK.
    byLanguage: {
      es: "piper-es_ES-davefx-medium-int8", fr: "piper-fr_FR-siwis-medium-int8", de: "piper-de_DE-thorsten-medium-int8",
      it: "piper-it_IT-paola-medium-int8", pt: "piper-pt_BR-faber-medium-int8", hi: "piper-hi_IN-rohan-medium-int8", zh: "piper-zh_CN-chaowen-medium-int8",
    },
  },
  {
    // Default fp32: the int8 build returned all-NaN audio for short lines, and runs 2x slower (measured 2026-09-24, native-models.ts).
    id: "kokoro-native", stage: "tts", name: "Kokoro (CPU)", native: true, note: "Apache 2.0",
    variants: [{ id: "kokoro-en-v0_19-int8", languages: EN }, ...variants("kokoro-multi-v1_0-int8 kokoro-multi-v1_0", KOKORO_MULTI)],
    defaultVariant: "kokoro-multi-v1_0",
  },
  { id: "matcha", stage: "tts", name: "Matcha", native: true, note: "Apache 2.0", variants: one("matcha-en-ljspeech", EN), defaultVariant: "matcha-en-ljspeech" },
];

const FAMILIES: Record<Stage, EngineFamilyInfo[]> = { stt: STT_FAMILIES, tts: TTS_FAMILIES };
// Variant id (and a pre-variant engine id) → its family and entry. O(variants), once.
const VARIANTS = new Map<string, { family: EngineFamilyInfo; variant: EngineVariantInfo }>();
for (const family of [...STT_FAMILIES, ...TTS_FAMILIES]) {
  for (const variant of family.variants) for (const id of [variant.id, variant.legacy]) if (id) VARIANTS.set(id, { family, variant });
}

/** A variant, by its id or the engine id a config saved before variants existed. */
export const variantInfo = (id: string | undefined) => (id ? VARIANTS.get(id) : undefined);
export const familyInfo = (stage: Stage, id: string | undefined) => FAMILIES[stage].find((f) => f.id === id);
/** Runs on the local agent (the browser loads nothing for it). */
export const isNativeVariant = (id: string | undefined) => !!variantInfo(id)?.family.native;
const speaks = (id: string | undefined, lang: LanguageCode) => !!variantInfo(id)?.variant.languages.includes(lang);
export const isRestricted = (id: string | undefined) => !!variantInfo(id)?.variant.restricted;
/** Whether `c` may switch to `id`: open, or restricted and the user allowed those. */
export const permitted = (c: Pick<PipelineConfig, "allowRestricted">, id: string) => c.allowRestricted || !isRestricted(id);

/** The variant a family starts on in `lang`: its language pick, else its
 *  default, else the first variant that speaks `lang`, each only when
 *  unrestricted or `allowRestricted`; else a restricted one that speaks it,
 *  else its default. Only a pick the user confirms reaches a restricted one
 *  (chooseVariant). Pure, O(variants). */
export function defaultVariant(family: EngineFamilyInfo, lang: LanguageCode, allowRestricted = false): string {
  const picks = [family.byLanguage?.[lang], family.defaultVariant, ...family.variants.map((v) => v.id)].filter((id): id is string => !!id && speaks(id, lang));
  return picks.find((id) => permitted({ allowRestricted }, id)) ?? picks[0] ?? family.defaultVariant;
}

/** The variant a click on `family` switches to: the one last picked there if
 *  it speaks the session language and is permitted, else its default for it. Pure. */
export function familyVariant(c: PipelineConfig, stage: Stage, family: EngineFamilyInfo): string {
  const last = c[stage].variants[family.id];
  return last && speaks(last, c.language) && permitted(c, last) ? last : defaultVariant(family, c.language, c.allowRestricted);
}

/** Whether `lang` can be spoken: for a config, per stage; for a variant id, by
 *  that variant; for a family id, by any of its variants. Pure. */
export function languageSupport(target: PipelineConfig, lang: LanguageCode): { stt: boolean; tts: boolean };
export function languageSupport(target: string, lang: LanguageCode): boolean;
export function languageSupport(target: PipelineConfig | string, lang: LanguageCode): boolean | { stt: boolean; tts: boolean } {
  if (typeof target !== "string") return { stt: speaks(target.stt.variant, lang), tts: speaks(target.tts.variant, lang) };
  const family = familyInfo("stt", target) ?? familyInfo("tts", target);
  return family ? family.variants.some((v) => v.languages.includes(lang)) : speaks(target, lang);
}

/** The recommended engines per language: fast and good, on the agent where a
 *  native engine does it better than the browser, and never a restricted one.
 *  Kokoro in the browser is English only, and nothing speaks Japanese or
 *  Korean but Supertonic. */
export const LANGUAGE_DEFAULTS: Record<LanguageCode, Record<Stage, string>> = {
  en: { stt: "parakeet-0.6b-v2-int8", tts: "kokoro" },
  es: { stt: "parakeet-0.6b-v3-int8", tts: "kokoro-multi-v1_0" },
  fr: { stt: "parakeet-0.6b-v3-int8", tts: "kokoro-multi-v1_0" },
  de: { stt: "parakeet-0.6b-v3-int8", tts: "piper-de_DE-thorsten-medium-int8" },
  it: { stt: "parakeet-0.6b-v3-int8", tts: "kokoro-multi-v1_0" },
  pt: { stt: "parakeet-0.6b-v3-int8", tts: "kokoro-multi-v1_0" },
  hi: { stt: "nemotron-3.5-160ms-int8", tts: "kokoro-multi-v1_0" },
  zh: { stt: "nemotron-3.5-160ms-int8", tts: "kokoro-multi-v1_0" },
  ja: { stt: "nemotron-3.5-160ms-int8", tts: "supertonic" },
  ko: { stt: "nemotron-3.5-160ms-int8", tts: "supertonic" },
};

/** The in-browser voice that stands in for a failed native or cloned one in
 *  `lang`, or null when none speaks it. Pure. */
export const browserTtsFallback = (lang: LanguageCode): string | null => ["kokoro", "supertonic"].find((id) => speaks(id, lang)) ?? null;

/** Make `variant` the stage's engine, remembering it for its family. A voice
 *  that the new engine does not have gives way to its default (a native engine
 *  without a static list: "", the agent picks one that speaks the language).
 *  A restricted variant the user has not allowed changes nothing. Pure. */
export function chooseVariant(c: PipelineConfig, stage: Stage, variant: string): PipelineConfig {
  const hit = variantInfo(variant);
  if (hit?.family.stage !== stage || !permitted(c, hit.variant.id)) return c;
  const { family } = hit;
  const id = hit.variant.id;
  const variants = { ...c[stage].variants, [family.id]: id };
  if (stage === "stt") return { ...c, stt: { ...c.stt, family: family.id, variant: id, variants } };
  const keep = family.voices ? family.voices.some((v) => v.id === c.tts.voice) : family.id === c.tts.family && id === c.tts.variant;
  return { ...c, tts: { ...c.tts, family: family.id, variant: id, variants, voice: keep ? c.tts.voice : family.defaultVoice ?? "" } };
}

/** Switch the stage to `family`, on familyVariant. Pure. */
export function chooseFamily(c: PipelineConfig, stage: Stage, family: string): PipelineConfig {
  const f = familyInfo(stage, family);
  return f ? chooseVariant(c, stage, familyVariant(c, stage, f)) : c;
}

/** What the agent says about its engines, as far as picking one needs. */
export type NativeCatalog = readonly { variants: readonly { id: string; installed: boolean }[] }[];
export interface EngineChange { stage: Stage; from: string; to: string; needsDownload: boolean }

/**
 * `c` switched to `lang`, with any engine that cannot speak it swapped for one
 * that can, and what was swapped (for the notice). The user's place is kept:
 * another variant of the same family first, then (from a browser engine) the
 * browser, or (from a native one) the language's recommended engine, then the
 * other; with the agent's `catalog`, only downloaded native engines, and a
 * download only when nothing downloaded speaks it (`needsDownload`); a
 * restricted engine only when the user allowed those.
 * `unsupported` names a stage nothing can do in `lang`. O(variants).
 */
export function pickCompatible(c: PipelineConfig, lang: LanguageCode, catalog?: NativeCatalog): { cfg: PipelineConfig; changes: EngineChange[]; unsupported: Stage[] } {
  const installed = catalog && new Set(catalog.flatMap((f) => f.variants.filter((v) => v.installed).map((v) => v.id)));
  const ready = (id: string) => !installed || !isNativeVariant(id) || installed.has(id);
  let cfg: PipelineConfig = { ...c, language: lang };
  const changes: EngineChange[] = [];
  const unsupported: Stage[] = [];
  for (const stage of ["stt", "tts"] as const) {
    const cur = c[stage].variant;
    if (speaks(cur, lang)) continue;
    const family = familyInfo(stage, c[stage].family);
    const browser = stage === "stt" ? "whisper" : browserTtsFallback(lang);
    const recommended = LANGUAGE_DEFAULTS[lang][stage];
    const candidates = [
      ...(family ? [defaultVariant(family, lang, c.allowRestricted), ...family.variants.map((v) => v.id)] : []),
      ...(isNativeVariant(cur) ? [recommended, browser] : [browser, recommended]),
      ...FAMILIES[stage].filter((f) => f.native).flatMap((f) => f.variants.map((v) => v.id)),
    ].filter((id): id is string => !!id && speaks(id, lang) && permitted(c, id));
    const to = candidates.find(ready) ?? candidates[0];
    if (!to) { unsupported.push(stage); continue; }
    cfg = chooseVariant(cfg, stage, to);
    changes.push({ stage, from: cur, to, needsDownload: !ready(to) });
  }
  return { cfg, changes, unsupported };
}

/** The Whisper build for `size` in `lang`: English-only below large (more
 *  accurate on English), the multilingual build of the same size for any other
 *  language; large-v3-turbo is multilingual only. WASM always runs tiny. Pure. */
export function whisperCheckpoint(size: WhisperSize, lang: LanguageCode, tier: "webgpu" | "wasm"): string {
  const s = tier === "wasm" ? "tiny" : size;
  return `onnx-community/whisper-${s}${lang === "en" && s !== "large-v3-turbo" ? ".en" : ""}`;
}

/** The most tokens Whisper may decode from `samples` of 16 kHz audio: 16 plus
 *  32 a second, about twice the densest curated language (Hindi, measured 15
 *  a second), under the model's 448-token window. A hallucination loop on a
 *  short clip otherwise runs to that window and holds the worker for seconds. Pure. */
export const whisperMaxTokens = (samples: number): number => Math.min(440, Math.ceil(16 + (32 * samples) / 16000));

/** The weights the in-browser model worker loads for `c`, as a cache tag. A
 *  native engine loads nothing there, so moving between native engines neither
 *  reloads the worker nor asks for a download; nor does a browser voice the
 *  agent runs on this computer (`ttsOnAgent`, models.ts agentCopy). A
 *  multilingual Whisper build is another download from the English one, so it
 *  tags as "<size>-ml". Pure. */
export function workerTag(c: PipelineConfig, tier: "webgpu" | "wasm", ttsOnAgent = false): string {
  const ck = whisperCheckpoint(c.stt.whisperSize, c.language, tier).replace("onnx-community/whisper-", "");
  const whisper = ck.endsWith(".en") || ck === "large-v3-turbo" ? ck.replace(".en", "") : `${ck}-ml`;
  return `${tier}:${isNativeVariant(c.stt.variant) ? "native" : whisper}:${isNativeVariant(c.tts.variant) || ttsOnAgent ? "native" : c.tts.family}`;
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
 *  them (a cloned voice keeps a browser voice as its fallback). Pure. */
export function browserModels(c: PipelineConfig): string[] {
  return [
    ...(isNativeVariant(c.stt.variant) ? [] : ["speech"]),
    ...(isNativeVariant(c.tts.variant) ? [] : ["voice"]),
    "turn-taking",
  ];
}

const num = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const oneOf = <T extends string>(x: unknown, allowed: readonly T[], d: T): T => (allowed.includes(x as T) ? (x as T) : d);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

// Caps keep a pasted or corrupted list from filling localStorage; a thousand
// entries compile in well under a millisecond.
export const PRONUNCIATION_LIMITS = { entries: 1000, from: 100, to: 200 } as const;
/** Saved dictionary entries, each trimmed and capped; one without a word is dropped. O(entries). */
function pronunciations(x: unknown): LexiconEntry[] {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return (Array.isArray(x) ? x : []).slice(0, PRONUNCIATION_LIMITS.entries).map(obj).map((e) => ({
    from: str(e.from, PRONUNCIATION_LIMITS.from), to: str(e.to, PRONUNCIATION_LIMITS.to),
    lang: oneOf(e.lang, ["", ...LANGUAGE_CODES], ""), matchCase: e.matchCase === true, wholeWord: e.wholeWord !== false,
  })).filter((e) => e.from);
}

/** A stage's engine from anything saved: the variant (or a pre-variant engine
 *  id in `engine`, the shape before variants), else the family on its
 *  remembered or default variant, else the stage default. Remembered picks
 *  that name no variant of their family are dropped. O(variants). */
function stageChoice(stage: Stage, raw: Record<string, unknown>, lang: LanguageCode): StageChoice {
  const remembered = Object.fromEntries(Object.entries(obj(raw.variants)).flatMap(([fam, id]) => {
    const hit = typeof id === "string" ? variantInfo(id) : undefined;
    return hit?.family.id === fam && hit.family.stage === stage ? [[fam, hit.variant.id] as const] : [];
  }));
  const saved = [raw.variant, raw.engine].map((x) => variantInfo(typeof x === "string" ? x : undefined)).find((h) => h?.family.stage === stage);
  const family = saved?.family ?? familyInfo(stage, typeof raw.family === "string" ? raw.family : undefined) ?? familyInfo(stage, DEFAULT_PIPELINE_CONFIG[stage].family)!;
  const variant = saved?.variant.id ?? remembered[family.id] ?? defaultVariant(family, lang);
  return { family: family.id, variant, variants: { ...remembered, [family.id]: variant } };
}

/** Merge an untrusted value (parsed JSON, any saved shape) over the defaults and
 *  clamp every field into range; unknown enums, engines and voices fall back to
 *  defaults. Configs saved before variants existed (`stt.engine`,
 *  `tts.engine`) migrate here. Pure. */
export function mergePipelineConfig(partial: unknown): PipelineConfig {
  const p = obj(partial);
  const [stt, tts, turn, vad] = [p.stt, p.tts, p.turn, p.vad].map(obj) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  const d = DEFAULT_PIPELINE_CONFIG;
  const language = oneOf(p.language, LANGUAGE_CODES, d.language);
  const ttsChoice = stageChoice("tts", tts, language);
  const family = familyInfo("tts", ttsChoice.family)!;
  const voice = typeof tts.voice === "string" ? tts.voice : d.tts.voice;
  return {
    language,
    stt: { ...stageChoice("stt", stt, language), whisperSize: oneOf(stt.whisperSize, WHISPER_SIZE_IDS, d.stt.whisperSize) },
    tts: {
      ...ttsChoice,
      // The voice must belong to the selected engine; a stale/foreign id falls
      // back to that engine's default (e.g. after an engine switch). Clone
      // voices are profile ids and a native engine without a static list names
      // its voices in the agent's catalog: both are checked at synth time instead.
      voice: !family.voices || family.voices.some((v) => v.id === voice) ? voice : family.defaultVoice!,
      speed: clamp(num(tts.speed, d.tts.speed), 0.5, 2),
    },
    turn: {
      engine: oneOf(turn.engine, ["smart-turn", "silence"], d.turn.engine),
      threshold: clamp(num(turn.threshold, d.turn.threshold), 0, 1),
      holdMs: clamp(Math.round(num(turn.holdMs, d.turn.holdMs)), 1000, 8000),
    },
    vad: {
      model: oneOf(vad.model, VAD_MODEL_IDS, d.vad.model),
      speechThreshold: clamp(num(vad.speechThreshold, d.vad.speechThreshold), 0.1, 0.9),
      redemptionMs: clamp(Math.round(num(vad.redemptionMs, d.vad.redemptionMs)), 200, 1500),
    },
    pronunciations: pronunciations(p.pronunciations),
    allowRestricted: p.allowRestricted === true,
  };
}

/** Clamp a typed config the same way (it may hold a stale engine or voice). Pure. */
export const clampPipelineConfig = (c: PipelineConfig): PipelineConfig => mergePipelineConfig(c);

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
