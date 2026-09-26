import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extract } from "tar";
import unbzip2 from "unbzip2-stream";
import { DATA_DIR } from "@openlive/db";
import { SAMPLE_RATE } from "./pcm.js";
import type { Accel } from "./accel.js";

// Native speech engines the user can pick in place of the in-browser models:
// families of variants, each variant one prebuilt sherpa-onnx archive,
// downloaded on demand into DATA_DIR/models/<variant id>. Asset names and sizes
// verified 2026-09-24 against the k2-fsa/sherpa-onnx `asr-models`,
// `tts-models` and `vocoder-models` release assets; languages from each
// model's card (the archive README where it has one).

export type EngineKind = "asr" | "tts";
/** How sherpa builds and runs a variant: sherpaConfig below, native-worker.ts.
 *  "supertonic" runs on onnxruntime-node instead (onOrt). */
export type ModelType = "online-transducer" | "nemo-transducer" | "moonshine" | "canary" | "pocket" | "kitten" | "kokoro" | "vits" | "matcha" | "supertonic";
export type Quality = "fastest" | "fast" | "balanced" | "best";
/** `lang` is ISO 639-1; `espeak` is the phonemizer voice a kokoro speaker reads with. */
export interface EngineVoice { id: string; name: string; lang?: string; gender?: "female" | "male"; sid?: number; wav?: string; espeak?: string }
/** One downloadable variant. */
export interface NativeEngine {
  id: string;
  family: string;
  kind: EngineKind;
  type: ModelType;
  name: string;
  url: string; // a .tar.bz2 archive, or the base URL `files` are fetched from one by one
  vocoder?: string; // a second download that lands next to the archive's files
  sizeBytes: number; // download bytes (archive plus vocoder), the progress total
  quality: Quality;
  languages: string[]; // ISO 639-1
  streaming?: boolean;
  latencyMs?: number; // streaming chunk size
  license: string;
  files: string[]; // relative to the engine dir; all present = installed
  voices?: EngineVoice[];
  legacyId?: string; // the engine id saved before variants existed
}
/** `browser`: the in-browser engine this family runs on this computer, as the
 *  same model and voices, rather than a choice of its own (models.ts ttsStream). */
export interface EngineFamily { id: string; kind: EngineKind; name: string; variants: NativeEngine[]; browser?: string }

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const asr = (name: string) => `${RELEASES}/asr-models/${name}.tar.bz2`;
const tts = (name: string) => `${RELEASES}/tts-models/${name}.tar.bz2`;
const TRANSDUCER_INT8 = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
const ESPEAK = "espeak-ng-data/phontab";
const CHUNK_QUALITY: Record<number, Quality> = { 80: "fastest", 160: "fast", 320: "balanced", 560: "balanced", 1120: "best" };

type VariantSpec = Omit<NativeEngine, "family" | "kind">;
const family = (id: string, kind: EngineKind, name: string, variants: VariantSpec[], browser?: string): EngineFamily =>
  ({ id, kind, name, variants: variants.map((v) => ({ ...v, family: id, kind })), browser });

// Transcription-ready and broad-coverage locales of nvidia/nemotron-3.5-asr-streaming-0.6b;
// its adaptation-ready ones need fine-tuning first.
const NEMOTRON_35_LANGS = ["en", "es", "fr", "it", "pt", "nl", "de", "tr", "ru", "ar", "hi", "ja", "ko", "vi", "uk",
  "pl", "sv", "cs", "nb", "da", "bg", "fi", "hr", "sk", "zh", "hu", "ro", "et"];
const PARAKEET_V3_LANGS = ["bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt",
  "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk"];

const nemotronEn = (ms: number, sizeBytes: number, legacyId?: string): VariantSpec => ({
  id: `nemotron-en-${ms}ms-int8`, type: "online-transducer", name: `Nemotron Streaming 0.6B, ${ms} ms`, streaming: true, latencyMs: ms,
  url: asr(`sherpa-onnx-nemotron-speech-streaming-en-0.6b-${ms}ms-int8-2026-04-25`), sizeBytes,
  quality: CHUNK_QUALITY[ms]!, languages: ["en"], license: "NVIDIA Open Model License", files: TRANSDUCER_INT8, legacyId,
});
const nemotron35 = (ms: number, sizeBytes: number): VariantSpec => ({
  id: `nemotron-3.5-${ms}ms-int8`, type: "online-transducer", name: `Nemotron 3.5 Streaming 0.6B, ${ms} ms`, streaming: true, latencyMs: ms,
  url: asr(`sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-${ms}ms-int8-2026-06-11`), sizeBytes,
  quality: CHUNK_QUALITY[ms]!, languages: NEMOTRON_35_LANGS, license: "OpenMDW-1.1", files: TRANSDUCER_INT8,
});

// Speaker ids follow voices.bin row order (sherpa-onnx scripts/kitten-tts/v0_8,
// the same rows for nano, micro and mini); names are KittenML's voice_aliases.
const KITTEN_VOICES: EngineVoice[] = (["jasper:m", "bella:f", "bruno:m", "luna:f", "hugo:m", "rosie:f", "leo:m", "kiki:f"] as const)
  .map((s, sid) => {
    const [id, g] = s.split(":") as [string, string];
    return { id, name: id[0]!.toUpperCase() + id.slice(1), lang: "en", gender: g === "f" ? "female" : "male", sid };
  });
const kitten = (size: string, build: string, sizeBytes: number, quality: Quality, model: string, legacyId?: string): VariantSpec => ({
  id: `kitten-${size}-${build}`, type: "kitten", name: `Kitten TTS ${size[0]!.toUpperCase()}${size.slice(1)}`,
  url: tts(`kitten-${size}-en-v0_8${build === "int8" ? "-int8" : ""}`), sizeBytes, quality, languages: ["en"], license: "Apache-2.0",
  files: [model, "voices.bin", "tokens.txt", ESPEAK], voices: KITTEN_VOICES, legacyId,
});

// Clones the voice of a reference clip on every call; the archive ships three.
const POCKET_WAVS = ["test_wavs/bria.wav", "test_wavs/loona.wav", "test_wavs/sample_fr_hibiki_crepes.wav"];
const POCKET_VOICES: EngineVoice[] = [
  { id: "bria", name: "Bria", lang: "en", wav: POCKET_WAVS[0] },
  { id: "loona", name: "Loona", lang: "en", wav: POCKET_WAVS[1] },
  { id: "hibiki", name: "Hibiki", lang: "en", wav: POCKET_WAVS[2] },
];
const POCKET_LICENSE = "CC-BY-4.0; the ONNX export is for non-commercial use (archive README)";

// Kokoro speaker ids follow voices.bin row order (sherpa-onnx scripts/kokoro/*/generate_voices_bin.py);
// the name's first letter is the language, its second the gender. The espeak
// names are voice files of the archive's espeak-ng-data: "en" is British
// English there, and "en-gb" or "fr-fr" fail to load (measured 2026-09-24).
const KOKORO_LANG: Record<string, [lang: string, espeak: string]> = {
  a: ["en", "en-us"], b: ["en", "en"], e: ["es", "es"], f: ["fr", "fr"], h: ["hi", "hi"], i: ["it", "it"], j: ["ja", "ja"], p: ["pt", "pt-br"], z: ["zh", "cmn"],
};
const kokoroVoices = (names: string): EngineVoice[] => names.split(" ").map((id, sid) => {
  const [lang, espeak] = KOKORO_LANG[id[0]!]!;
  const name = id.slice(3) || id;
  return { id, name: name[0]!.toUpperCase() + name.slice(1), lang, espeak, gender: id[1] === "f" ? "female" : "male", sid };
});
// Its Japanese voices are left out: espeak-ng reads kanji poorly, and a kanji
// sentence came back 48% right through Nemotron 3.5 (measured 2026-09-24).
const KOKORO_V1_VOICES = kokoroVoices("af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky "
  + "am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa bf_alice bf_emma bf_isabella bf_lily "
  + "bm_daniel bm_fable bm_george bm_lewis ef_dora em_alex ff_siwis hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola "
  + "jf_alpha jf_gongitsune jf_nezumi jf_tebukuro jm_kumo pf_dora pm_alex pm_santa zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi "
  + "zm_yunjian zm_yunxi zm_yunxia zm_yunyang").filter((v) => v.lang !== "ja");

// Every voice speaks every language: it is a style, the language a tag on the text.
const SUPERTONIC_VOICES: EngineVoice[] = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]
  .map((id) => ({ id, name: id, gender: id[0] === "F" ? "female" : "male" }));

// Piper voices, int8 builds (the fp32 archives are 3x the download for the
// same voice); at most three speakers per language. Speakers of a
// multi-speaker model are its speaker_id_map rows. Licenses are the MODEL_CARD's
// dataset license, the one a voice is judged by; the voice it was fine-tuned
// from is named for information (checked 2026-09-25 against rhasspy/piper-voices).
type PiperTier = "x_low" | "low" | "medium" | "high";
const PIPER_QUALITY: Record<PiperTier, Quality> = { x_low: "fastest", low: "fast", medium: "balanced", high: "best" };
interface PiperVoice {
  voice: string; // <locale>-<name>
  license: string;
  tiers: Partial<Record<PiperTier, number>>; // archive bytes
  gender?: "female" | "male";
  speakers?: Array<[name: string, gender?: "female" | "male"]>;
  fp32?: true; // no int8 build is published
  pinyin?: true; // phonemized from a lexicon, not espeak
}
const PIPER: PiperVoice[] = [
  { voice: "en_US-lessac", gender: "female", license: "Blizzard 2013 Lessac research-only license", tiers: { low: 21_070_568, medium: 20_969_179, high: 35_022_847 } },
  { voice: "en_US-amy", gender: "female", license: "unknown (MODEL_CARD: see Mimic 3 voices); fine-tuned from lessac", tiers: { low: 21_099_246, medium: 21_028_122 } },
  { voice: "en_US-ryan", gender: "male", license: "CC BY-NC-SA 4.0", tiers: { low: 21_212_659, medium: 21_083_446, high: 34_473_341 } },
  { voice: "en_US-libritts_r", license: "CC BY 4.0; fine-tuned from lessac", tiers: { medium: 23_398_348 }, speakers: [["3922"], ["8699"], ["4535"], ["6701"]] },
  { voice: "es_ES-davefx", gender: "male", license: "CC0; fine-tuned from lessac", tiers: { medium: 21_171_632 } },
  { voice: "es_ES-sharvard", license: "CC BY 3.0; fine-tuned from lessac", tiers: { medium: 23_477_120 }, speakers: [["M", "male"], ["F", "female"]] },
  { voice: "es_AR-daniela", gender: "female", license: "CC BY-SA 4.0; fine-tuned from lessac", tiers: { high: 35_069_782 } },
  { voice: "fr_FR-siwis", gender: "female", license: "CC BY 4.0; fine-tuned from lessac", tiers: { low: 13_317_962, medium: 20_914_888 } },
  { voice: "fr_FR-tom", gender: "male", license: "AGPLv3", tiers: { medium: 21_019_617 } },
  { voice: "fr_FR-upmc", license: "CC BY-SA 4.0; fine-tuned from lessac", tiers: { medium: 22_588_190 }, speakers: [["jessica", "female"], ["pierre", "male"]] },
  { voice: "de_DE-thorsten", gender: "male", license: "CC0; fine-tuned from lessac", tiers: { low: 21_292_232, medium: 20_949_833, high: 35_066_527 } },
  { voice: "de_DE-kerstin", gender: "female", license: "CC0; fine-tuned from ryan", tiers: { low: 21_174_728 } },
  { voice: "de_DE-ramona", gender: "female", license: "BSD-3-Clause style (M-AILABS)", tiers: { low: 21_199_380 } },
  { voice: "it_IT-paola", gender: "female", license: "unknown (see huggingface.co/datasets/paolapersico1/Voice-Dataset-Italian); fine-tuned from lessac", tiers: { medium: 21_143_212 } },
  { voice: "it_IT-riccardo", gender: "male", license: "BSD-3-Clause style (M-AILABS)", tiers: { x_low: 13_329_285 } },
  { voice: "pt_BR-faber", license: "CC0; fine-tuned from lessac", tiers: { medium: 21_336_772 } },
  { voice: "pt_BR-cadu", license: "CC0; fine-tuned from lessac", tiers: { medium: 21_135_464 } },
  { voice: "pt_PT-tugao", license: "CC0; fine-tuned from lessac", tiers: { medium: 21_253_211 } },
  { voice: "hi_IN-pratham", gender: "male", license: "CC BY-NC-SA 4.0", tiers: { medium: 20_987_965 } },
  { voice: "hi_IN-priyamvada", gender: "female", license: "CC BY-NC-SA 4.0", tiers: { medium: 21_097_319 } },
  { voice: "hi_IN-rohan", gender: "male", license: "IITM IndicTTS license; fine-tuned from lessac", tiers: { medium: 21_064_499 } },
  { voice: "zh_CN-chaowen", license: "CC0; fine-tuned from xiao_ya", tiers: { medium: 14_011_298 }, pinyin: true },
  { voice: "zh_CN-xiao_ya", gender: "female", license: "non-commercial (Data Baker BZNSYP)", tiers: { medium: 14_016_124 }, pinyin: true },
  { voice: "zh_CN-huayan", gender: "female", license: "unknown (MODEL_CARD); fine-tuned from lessac", tiers: { medium: 67_255_926 }, fp32: true },
];
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const piperVariants = (p: PiperVoice): VariantSpec[] => Object.entries(p.tiers).map(([tier, sizeBytes]) => {
  const [locale, speaker] = p.voice.split("-") as [string, string];
  const archive = `vits-piper-${p.voice}-${tier}${p.fp32 ? "" : "-int8"}`;
  const lang = locale.slice(0, 2);
  const voices: EngineVoice[] = p.speakers
    ? p.speakers.map(([name, gender], sid) => ({ id: name.toLowerCase(), name: cap(name), lang, gender, sid }))
    : [{ id: speaker, name: cap(speaker.replace("_", " ")), lang, gender: p.gender, sid: 0 }];
  return {
    id: archive.replace("vits-", ""), type: "vits", name: `${cap(speaker.replace("_", " "))} (${locale.replace("_", "-")}), ${tier.replace("_", " ")}`,
    url: tts(archive), sizeBytes, quality: PIPER_QUALITY[tier as PiperTier], languages: [lang], license: p.license, voices,
    files: [`${p.voice}-${tier}.onnx`, "tokens.txt", ...(p.pinyin ? ["lexicon.txt", "date.fst", "number.fst", "phone.fst"] : [ESPEAK])],
  };
});

export const NATIVE_FAMILIES: EngineFamily[] = [
  family("nemotron", "asr", "Nemotron Streaming (English)", [
    nemotronEn(80, 463_945_379), nemotronEn(160, 463_945_198, "nemotron"), nemotronEn(560, 463_945_051), nemotronEn(1120, 463_945_058),
  ]),
  family("nemotron-3.5", "asr", "Nemotron 3.5 Streaming (multilingual)", [
    nemotron35(80, 475_274_007), nemotron35(160, 475_273_363), nemotron35(320, 475_272_949), nemotron35(560, 475_271_763), nemotron35(1120, 475_276_334),
  ]),
  family("parakeet", "asr", "Parakeet TDT", [
    {
      id: "parakeet-110m-int8", type: "nemo-transducer", name: "Parakeet TDT 110M", url: asr("sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8"),
      sizeBytes: 108_035_095, quality: "fast", languages: ["en"], license: "CC-BY-4.0", files: TRANSDUCER_INT8,
    },
    {
      id: "parakeet-0.6b-v2-int8", type: "nemo-transducer", name: "Parakeet TDT 0.6B v2", url: asr("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"),
      sizeBytes: 482_468_385, quality: "balanced", languages: ["en"], license: "CC-BY-4.0", files: TRANSDUCER_INT8, legacyId: "parakeet",
    },
    {
      id: "parakeet-0.6b-v2-fp16", type: "nemo-transducer", name: "Parakeet TDT 0.6B v2 (fp16)", url: asr("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-fp16"),
      sizeBytes: 1_120_982_957, quality: "best", languages: ["en"], license: "CC-BY-4.0",
      files: ["encoder.fp16.onnx", "decoder.fp16.onnx", "joiner.fp16.onnx", "tokens.txt"],
    },
    {
      // Detects the language itself; there is no option to pin one.
      id: "parakeet-0.6b-v3-int8", type: "nemo-transducer", name: "Parakeet TDT 0.6B v3 (25 languages)", url: asr("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"),
      sizeBytes: 487_170_055, quality: "balanced", languages: PARAKEET_V3_LANGS, license: "CC-BY-4.0", files: TRANSDUCER_INT8,
    },
  ]),
  family("moonshine", "asr", "Moonshine", [
    {
      id: "moonshine-tiny-en-int8", type: "moonshine", name: "Moonshine Tiny", url: asr("sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27"),
      sizeBytes: 29_858_559, quality: "fastest", languages: ["en"], license: "MIT", files: ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"],
    },
    {
      id: "moonshine-base-en-int8", type: "moonshine", name: "Moonshine Base", url: asr("sherpa-onnx-moonshine-base-en-quantized-2026-02-27"),
      sizeBytes: 111_266_225, quality: "fast", languages: ["en"], license: "MIT", files: ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"],
      legacyId: "moonshine",
    },
  ]),
  family("canary", "asr", "Canary", [
    {
      id: "canary-180m-flash-int8", type: "canary", name: "Canary 180M Flash", url: asr("sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8"),
      sizeBytes: 153_692_328, quality: "fast", languages: ["en", "es", "de", "fr"], license: "CC-BY-4.0",
      files: ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
    },
  ]),
  family("pocket", "tts", "Pocket TTS", [
    {
      id: "pocket-int8", type: "pocket", name: "Pocket TTS", url: tts("sherpa-onnx-pocket-tts-int8-2026-01-26"), sizeBytes: 98_336_520,
      quality: "fast", languages: ["en"], license: POCKET_LICENSE, voices: POCKET_VOICES, legacyId: "pocket",
      files: ["lm_flow.int8.onnx", "lm_main.int8.onnx", "encoder.onnx", "decoder.int8.onnx", "text_conditioner.onnx", "vocab.json", "token_scores.json", ...POCKET_WAVS],
    },
    {
      id: "pocket-fp32", type: "pocket", name: "Pocket TTS (fp32)", url: tts("sherpa-onnx-pocket-tts-2026-01-26"), sizeBytes: 168_148_625,
      quality: "best", languages: ["en"], license: POCKET_LICENSE, voices: POCKET_VOICES,
      files: ["lm_flow.onnx", "lm_main.onnx", "encoder.onnx", "decoder.onnx", "text_conditioner.onnx", "vocab.json", "token_scores.json", ...POCKET_WAVS],
    },
  ]),
  family("kitten", "tts", "Kitten TTS", [
    kitten("nano", "int8", 31_220_690, "fastest", "model.int8.onnx", "kitten"),
    kitten("micro", "fp32", 44_423_643, "fast", "model.onnx"),
    kitten("mini", "fp32", 67_547_594, "balanced", "model.onnx"),
  ]),
  family("piper", "tts", "Piper", PIPER.flatMap(piperVariants)),
  family("kokoro-native", "tts", "Kokoro (CPU)", [
    {
      id: "kokoro-en-v0_19-int8", type: "kokoro", name: "Kokoro v0.19 (English)", url: tts("kokoro-int8-en-v0_19"), sizeBytes: 103_248_205,
      quality: "balanced", languages: ["en"], license: "Apache-2.0", files: ["model.int8.onnx", "voices.bin", "tokens.txt", ESPEAK],
      voices: kokoroVoices("af af_bella af_nicole af_sarah af_sky am_adam am_michael bf_emma bf_isabella bm_george bm_lewis"),
    },
    {
      // Measured 2026-09-24: returns all-NaN audio for 17 of 144 short sentences
      // ("Hola.", "Hi." on am_adam); the fp32 build below returned none.
      id: "kokoro-multi-v1_0-int8", type: "kokoro", name: "Kokoro v1.0 (multilingual)", url: tts("kokoro-int8-multi-lang-v1_0"), sizeBytes: 132_303_094,
      quality: "balanced", languages: [...new Set(KOKORO_V1_VOICES.map((v) => v.lang!))], license: "Apache-2.0",
      files: ["model.int8.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-zh.txt", ESPEAK], voices: KOKORO_V1_VOICES,
    },
    {
      id: "kokoro-multi-v1_0", type: "kokoro", name: "Kokoro v1.0 (multilingual, fp32)", url: tts("kokoro-multi-lang-v1_0"), sizeBytes: 349_906_910,
      quality: "best", languages: [...new Set(KOKORO_V1_VOICES.map((v) => v.lang!))], license: "Apache-2.0",
      files: ["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-zh.txt", ESPEAK], voices: KOKORO_V1_VOICES,
    },
  ]),
  // The browser's Supertonic (apps/web/src/lib/live/supertonic.ts) from the same
  // Hugging Face repo, pinned to the revision tools/voice-regress checks.
  // Sizes verified 2026-09-25 against the repo tree at that revision.
  family("supertonic", "tts", "Supertonic", [
    {
      id: "supertonic-3", type: "supertonic", name: "Supertonic 3", url: "https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323",
      sizeBytes: 401_276_744, quality: "balanced", languages: ["en", "es", "fr", "de", "it", "pt", "hi", "ja", "ko"], license: "OpenRAIL-M",
      files: [...["duration_predictor.onnx", "text_encoder.onnx", "vector_estimator.onnx", "vocoder.onnx", "tts.json", "unicode_indexer.json"].map((f) => `onnx/${f}`),
        ...SUPERTONIC_VOICES.map((v) => `voice_styles/${v.id}.json`)],
      voices: SUPERTONIC_VOICES,
    },
  ], "supertonic"),
  family("matcha", "tts", "Matcha", [
    {
      id: "matcha-en-ljspeech", type: "matcha", name: "Matcha LJSpeech", url: tts("matcha-icefall-en_US-ljspeech"),
      vocoder: `${RELEASES}/vocoder-models/vocos-22khz-univ.onnx`,
      sizeBytes: 76_741_121 + 53_884_024, quality: "fast", languages: ["en"], license: "Apache-2.0 (icefall); LJSpeech is public domain",
      files: ["model-steps-3.onnx", "tokens.txt", ESPEAK, "vocos-22khz-univ.onnx"], voices: [{ id: "ljspeech", name: "Linda", lang: "en", gender: "female", sid: 0 }],
    },
  ]),
];

export const NATIVE_ENGINES: NativeEngine[] = NATIVE_FAMILIES.flatMap((f) => f.variants);

/** Text as the native voices should get it. Measured 2026-09-24: kitten
 *  (espeak-ng) reads emoji and code symbols out by name ("party popper"), and
 *  pocket runs on for 10-45 s far more often on a line like "if (x != null) { y++ }". */
export const speakable = (text: string) => text
  .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}‍️⃣]/gu, " ")
  .replace(/[<>!=]=+|=>|[{}[\]<>|\\^~`_*]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const byId = new Map<string, NativeEngine>();
for (const e of NATIVE_ENGINES) for (const id of [e.id, e.legacyId]) if (id) byId.set(id, e);
/** A variant by its id, or by the engine id a config saved before variants existed. */
export const nativeEngine = (id: string | undefined): NativeEngine | undefined => (id ? byId.get(id) : undefined);

/** "en-US" and "EN" read as "en". Null when absent, so the engine picks. */
export const langCode = (lang: string | undefined | null) => lang?.trim() ? lang.trim().toLowerCase().split(/[-_]/)[0]! : null;

export const engineDir = (id: string) => resolve(DATA_DIR, "models", id);

// Engines downloaded before variants existed live under their old id: move
// them to the variant's dir once, so nothing downloads twice.
for (const e of NATIVE_ENGINES) {
  if (!e.legacyId) continue;
  rmSync(`${engineDir(e.legacyId)}.part`, { recursive: true, force: true });
  if (existsSync(engineDir(e.legacyId)) && !existsSync(engineDir(e.id))) {
    try { renameSync(engineDir(e.legacyId), engineDir(e.id)); } catch { /* left in place; the variant shows as not downloaded */ }
  }
}

/** Runs on onnxruntime-node rather than sherpa-onnx (device.ts probes each runtime's providers). */
export const onOrt = (e: NativeEngine) => e.type === "supertonic";

export const engineInstalled = (e: NativeEngine) => e.files.every((f) => existsSync(join(engineDir(e.id), f)));

/** O(files under the dir). */
export function engineDiskBytes(id: string): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else { try { total += statSync(p).size; } catch { /* racing a delete */ } }
    }
  };
  try { walk(engineDir(id)); } catch { /* not installed */ }
  return total;
}

/** The sherpa-onnx-node config for a variant, as native-worker.ts creates it.
 *  File roles come from the variant's file list, so a build with other file
 *  names (fp16, int8) needs no code. `accel` is where it runs (accel.ts). */
export function sherpaConfig(e: NativeEngine, { provider, numThreads }: Accel): object {
  const dir = engineDir(e.id);
  const f = (re: RegExp) => { const name = e.files.find((x) => re.test(x)); return name ? join(dir, name) : ""; };
  const all = (re: RegExp) => e.files.filter((x) => re.test(x)).map((x) => join(dir, x)).join(",");
  const tokens = f(/^tokens\.txt$/);
  const dataDir = e.files.includes(ESPEAK) ? join(dir, "espeak-ng-data") : "";
  const transducer = { encoder: f(/^encoder/), decoder: f(/^decoder/), joiner: f(/^joiner/) };
  const featConfig = { sampleRate: SAMPLE_RATE, featureDim: 80 };
  switch (e.type) {
    case "online-transducer": return {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
      modelConfig: { transducer, tokens, numThreads, provider },
      // Endpoints only bound how much audio one stream holds: the text is
      // committed and the stream reset, and "end" still decides the final.
      enableEndpoint: true, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20,
    };
    case "nemo-transducer": return { featConfig, modelConfig: { transducer, tokens, modelType: "nemo_transducer", numThreads, provider } };
    case "moonshine": return { featConfig, modelConfig: { moonshine: { encoder: f(/^encoder_model/), mergedDecoder: f(/^decoder_model_merged/) }, tokens, numThreads, provider } };
    // The worker switches srcLang/tgtLang per request (setConfig), as the upstream nodejs example does.
    case "canary": return { featConfig, modelConfig: { canary: { encoder: f(/^encoder/), decoder: f(/^decoder/), srcLang: "en", tgtLang: "en", usePnc: 1 }, tokens, numThreads, provider } };
    case "pocket": return {
      model: {
        pocket: {
          lmFlow: f(/^lm_flow/), lmMain: f(/^lm_main/), encoder: f(/^encoder/), decoder: f(/^decoder/), textConditioner: f(/^text_conditioner/),
          vocabJson: f(/^vocab\.json$/), tokenScoresJson: f(/^token_scores\.json$/), voiceEmbeddingCacheCapacity: 8,
        },
        numThreads, provider,
      },
      maxNumSentences: 1,
    };
    case "kitten": return { model: { kitten: { model: f(/^model/), voices: f(/^voices/), tokens, dataDir }, numThreads, provider }, maxNumSentences: 1 };
    case "kokoro": return { model: { kokoro: { model: f(/^model/), voices: f(/^voices/), tokens, dataDir, lexicon: all(/^lexicon-/) }, numThreads, provider }, maxNumSentences: 1 };
    case "vits": return { model: { vits: { model: f(/\.onnx$/), tokens, dataDir, lexicon: f(/^lexicon\.txt$/) }, numThreads, provider }, ruleFsts: all(/\.fst$/), maxNumSentences: 1 };
    case "matcha": return { model: { matcha: { acousticModel: f(/^model/), vocoder: f(/^vocos/), tokens, dataDir }, numThreads, provider }, maxNumSentences: 1 };
    // Not sherpa's: native-worker.ts loads it on onnxruntime-node.
    case "supertonic": return { dir, numThreads, provider };
  }
}

/** Stream the archive (and a vocoder, if any), or each file of a variant that
 *  has no archive, into <id>.part and rename it into place only once every
 *  expected file is there, so a failed, aborted, or killed download never
 *  leaves a half-installed engine (a stale .part is wiped by the next try). */
export async function downloadEngine(e: NativeEngine, onBytes: (n: number) => void, signal: AbortSignal): Promise<void> {
  const dir = engineDir(e.id);
  const part = `${dir}.part`;
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  const get = async (url: string) => {
    const res = await fetch(url, { redirect: "follow", signal });
    if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
    const counted = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctrl) { onBytes(chunk.byteLength); ctrl.enqueue(chunk); } });
    return Readable.fromWeb(res.body.pipeThrough(counted) as never);
  };
  try {
    // Some archives list their entries as "./<dir>/<file>", which strip: 1 alone would leave one level deep.
    if (!e.url.endsWith(".tar.bz2")) {
      for (const f of e.files) {
        mkdirSync(dirname(join(part, f)), { recursive: true });
        await pipeline(await get(`${e.url}/${f}`), createWriteStream(join(part, f)), { signal });
      }
    } else await pipeline(await get(e.url), unbzip2(), extract({ cwd: part, strip: 1, onReadEntry: (entry) => { entry.path = entry.path.replace(/^\.\//, ""); } }), { signal });
    if (e.vocoder) await pipeline(await get(e.vocoder), createWriteStream(join(part, e.vocoder.split("/").pop()!)), { signal });
    const missing = e.files.filter((f) => !existsSync(join(part, f)));
    if (missing.length) throw new Error(`archive is missing ${missing.join(", ")}`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(part, dir);
  } catch (err) {
    rmSync(part, { recursive: true, force: true });
    throw err;
  }
}
