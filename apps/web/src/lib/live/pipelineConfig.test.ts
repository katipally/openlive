// Guards the untrusted-config merge/clamp, the saved-shape migration and the
// language rules: the only non-trivial logic here.
import assert from "node:assert";
import { test, vi } from "vitest";
import { LANGUAGE_CODES } from "@openlive/shared";
import {
  mergePipelineConfig, clampPipelineConfig, PRONUNCIATION_LIMITS, workerTag, tagCached, browserModels, DEFAULT_PIPELINE_CONFIG, KOKORO_VOICES, SUPERTONIC_VOICES,
  STT_FAMILIES, TTS_FAMILIES, CURATED_LANGUAGES, LANGUAGE_DEFAULTS, languageSupport, pickCompatible, chooseFamily, chooseVariant,
  defaultVariant, whisperCheckpoint, whisperMaxTokens, browserTtsFallback, familyInfo, variantInfo, isRestricted, loadPipelineConfig, savePipelineConfig,
  type PipelineConfig,
} from "./pipelineConfig.ts";

/** The defaults with restricted-license models allowed, for tests that pick one. */
const OPEN: PipelineConfig = { ...DEFAULT_PIPELINE_CONFIG, allowRestricted: true };

test("empty / garbage input → defaults", () => {
  assert.deepEqual(mergePipelineConfig({}), DEFAULT_PIPELINE_CONFIG);
  assert.deepEqual(mergePipelineConfig(null), DEFAULT_PIPELINE_CONFIG);
  assert.deepEqual(mergePipelineConfig("nonsense"), DEFAULT_PIPELINE_CONFIG);
});

test("partial input keeps given fields, fills the rest from defaults", () => {
  const m = mergePipelineConfig({ tts: { voice: "am_onyx" }, stt: { whisperSize: "small" } });
  assert.equal(m.tts.voice, "am_onyx");
  assert.equal(m.tts.speed, DEFAULT_PIPELINE_CONFIG.tts.speed);
  assert.equal(m.stt.whisperSize, "small");
  assert.equal(m.turn.engine, "smart-turn");
  assert.equal(m.language, "en");
});

test("unknown enum/voice values fall back to defaults", () => {
  assert.equal(mergePipelineConfig({ tts: { voice: "zz_bogus" } }).tts.voice, "af_heart");
  assert.equal(mergePipelineConfig({ stt: { whisperSize: "gigantic" } }).stt.whisperSize, "base");
  assert.equal(mergePipelineConfig({ turn: { engine: "telepathy" } }).turn.engine, "smart-turn");
  assert.equal(mergePipelineConfig({ language: "tlh" }).language, "en");
  assert.equal(mergePipelineConfig({ language: "ja" }).language, "ja");
});

const full = (over: object) => ({ stt: { whisperSize: "base" }, tts: { voice: "af_heart", speed: 1 }, turn: { engine: "smart-turn", threshold: 0.5, holdMs: 4000 }, vad: { speechThreshold: 0.5, redemptionMs: 550 }, ...over }) as unknown as PipelineConfig;

test("out-of-range numbers clamp", () => {
  assert.equal(clampPipelineConfig(full({ tts: { voice: "af_heart", speed: 99 } })).tts.speed, 2);
  assert.equal(clampPipelineConfig(full({ turn: { engine: "smart-turn", threshold: -5, holdMs: 4000 } })).turn.threshold, 0);
  assert.equal(clampPipelineConfig(full({ vad: { speechThreshold: 5, redemptionMs: 550 } })).vad.speechThreshold, 0.9);
  assert.equal(clampPipelineConfig(full({ vad: { speechThreshold: 0.5, redemptionMs: 99999 } })).vad.redemptionMs, 1500);
});

test("vad model: v6 by default and for old saved configs; v5 sticks; unknown falls back", () => {
  assert.equal(DEFAULT_PIPELINE_CONFIG.vad.model, "v6");
  assert.equal(mergePipelineConfig({ vad: { speechThreshold: 0.4, redemptionMs: 550 } }).vad.model, "v6");
  assert.equal(mergePipelineConfig({ vad: { model: "v5" } }).vad.model, "v5");
  assert.equal(mergePipelineConfig({ vad: { model: "v4" } }).vad.model, "v6");
  assert.equal(clampPipelineConfig(full({})).vad.model, "v6");
});

test("mid-thought hold clamps to 1–8 s; missing/garbage falls back to the default", () => {
  assert.equal(clampPipelineConfig(full({ turn: { engine: "smart-turn", threshold: 0.5, holdMs: 100 } })).turn.holdMs, 1000);
  assert.equal(clampPipelineConfig(full({ turn: { engine: "smart-turn", threshold: 0.5, holdMs: 60000 } })).turn.holdMs, 8000);
  assert.equal(clampPipelineConfig(full({ turn: { engine: "smart-turn", threshold: 0.5 } })).turn.holdMs, 4000);
  assert.equal(mergePipelineConfig({ turn: { holdMs: 2500 } }).turn.holdMs, 2500);
  assert.equal(mergePipelineConfig({}).turn.holdMs, 4000);
});

test("catalog integrity: 28 English voices, all with a valid accent/gender", () => {
  assert.equal(KOKORO_VOICES.length, 28);
  assert.ok(KOKORO_VOICES.every((v) => (v.accent === "American" || v.accent === "British") && (v.gender === "Female" || v.gender === "Male")));
});

// ── migration from every saved shape ───────────────────────────────────────

test("migration: every pre-variant STT engine lands on its variant, Whisper keeps its size", () => {
  const cases: [string, string, string][] = [
    ["whisper", "whisper", "whisper"],
    ["nemotron", "nemotron", "nemotron-en-160ms-int8"],
    ["parakeet", "parakeet", "parakeet-0.6b-v2-int8"],
    ["moonshine", "moonshine", "moonshine-base-en-int8"],
  ];
  for (const [engine, family, variant] of cases) {
    const m = mergePipelineConfig({ stt: { engine, whisperSize: "small" } });
    assert.deepEqual(m.stt, { family, variant, variants: { [family]: variant }, whisperSize: "small" }, engine);
  }
  // Saved before engines existed at all: Whisper, with its size.
  assert.deepEqual(mergePipelineConfig({ stt: { whisperSize: "small" } }).stt, { family: "whisper", variant: "whisper", variants: { whisper: "whisper" }, whisperSize: "small" });
  assert.equal(mergePipelineConfig({ stt: { engine: "deepgram" } }).stt.variant, "whisper");
  assert.equal(mergePipelineConfig({ stt: { engine: 7 } }).stt.variant, "whisper");
});

test("migration: every pre-variant TTS engine lands on its variant and keeps a voice it has", () => {
  const cases: [string, string, string, string, string][] = [
    // engine, saved voice, family, variant, voice
    ["kokoro", "am_onyx", "kokoro", "kokoro", "am_onyx"],
    ["supertonic", "F3", "supertonic", "supertonic", "F3"],
    ["clone", "profile-123", "clone", "clone", "profile-123"],
    ["pocket", "loona", "pocket", "pocket-int8", "loona"],
    ["kitten", "jasper", "kitten", "kitten-nano-int8", "jasper"],
  ];
  for (const [engine, voice, family, variant, want] of cases) {
    const m = mergePipelineConfig({ tts: { engine, voice, speed: 1.2 } });
    assert.deepEqual(m.tts, { family, variant, variants: { [family]: variant }, voice: want, speed: 1.2 }, engine);
  }
  // A voice the engine does not have snaps to its default; French Pocket voice is not offered.
  assert.equal(mergePipelineConfig({ tts: { engine: "supertonic", voice: "af_heart" } }).tts.voice, "M1");
  assert.equal(mergePipelineConfig({ tts: { engine: "kokoro", voice: "F3" } }).tts.voice, "af_heart");
  assert.equal(mergePipelineConfig({ tts: { engine: "pocket", voice: "hibiki" } }).tts.voice, "bria");
  assert.equal(mergePipelineConfig({ tts: { engine: "kitten", voice: "af_heart" } }).tts.voice, "bella");
  assert.equal(mergePipelineConfig({ tts: { engine: "bark" } }).tts.variant, "kokoro");
  assert.equal(SUPERTONIC_VOICES.length, 10);
});

test("pronunciations: trimmed, capped, defaulted; an entry with no word is dropped", () => {
  const long = "x".repeat(500);
  const cfg = mergePipelineConfig({ pronunciations: [
    { from: "  Nginx ", to: " engine x ", lang: "en", matchCase: true, wholeWord: false },
    { from: "Kai", to: "Kye" }, { from: "   ", to: "gone" }, { from: long, to: long, lang: "xx" }, "junk", null,
  ] });
  assert.deepEqual(cfg.pronunciations, [
    { from: "Nginx", to: "engine x", lang: "en", matchCase: true, wholeWord: false },
    { from: "Kai", to: "Kye", lang: "", matchCase: false, wholeWord: true },
    { from: long.slice(0, PRONUNCIATION_LIMITS.from), to: long.slice(0, PRONUNCIATION_LIMITS.to), lang: "", matchCase: false, wholeWord: true },
  ]);
  assert.deepEqual(mergePipelineConfig(JSON.parse(JSON.stringify(cfg))), cfg);
  assert.equal(mergePipelineConfig({ pronunciations: Array.from({ length: 5000 }, (_, i) => ({ from: `w${i}`, to: "x" })) }).pronunciations.length, PRONUNCIATION_LIMITS.entries);
  assert.deepEqual(mergePipelineConfig({ pronunciations: "nope" }).pronunciations, []);
});

test("the new shape round-trips; a stale variant or family falls back to the family default", () => {
  const cfg = mergePipelineConfig({
    language: "es",
    stt: { family: "nemotron-3.5", variant: "nemotron-3.5-560ms-int8", variants: { parakeet: "parakeet-0.6b-v3-int8", bogus: "x", moonshine: "parakeet-110m-int8" } },
    tts: { family: "piper", variant: "piper-es_ES-sharvard-medium-int8", voice: "f", speed: 1 },
  });
  assert.deepEqual(mergePipelineConfig(JSON.parse(JSON.stringify(cfg))), cfg);
  assert.deepEqual(cfg.stt.variants, { parakeet: "parakeet-0.6b-v3-int8", "nemotron-3.5": "nemotron-3.5-560ms-int8" }); // foreign picks dropped
  assert.equal(cfg.tts.voice, "f"); // a catalog voice is checked at synth time
  // A variant id from the other stage, or none at all: the family's default in the language.
  assert.equal(mergePipelineConfig({ language: "es", stt: { family: "parakeet", variant: "kokoro" } }).stt.variant, "parakeet-0.6b-v3-int8");
  assert.equal(mergePipelineConfig({ stt: { family: "parakeet", variant: "parakeet-9b" } }).stt.variant, "parakeet-0.6b-v2-int8");
  assert.equal(mergePipelineConfig({ tts: { family: "kokoro-native" } }).tts.variant, "kokoro-multi-v1_0");
  // A pre-variant id in `variant` still resolves.
  assert.equal(mergePipelineConfig({ tts: { family: "kitten", variant: "kitten" } }).tts.variant, "kitten-nano-int8");
});

// ── families, choosing, languages ────────────────────────────────────────────

test("catalog integrity: ids unique, every default exists and every static default voice exists", () => {
  const ids = [...STT_FAMILIES, ...TTS_FAMILIES].flatMap((f) => f.variants.map((v) => v.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const f of [...STT_FAMILIES, ...TTS_FAMILIES]) {
    assert.ok(f.variants.some((v) => v.id === f.defaultVariant), f.id);
    for (const id of Object.values(f.byLanguage ?? {})) assert.equal(variantInfo(id)?.family.id, f.id, id);
    if (f.voices) assert.ok(f.voices.some((v) => v.id === f.defaultVoice), f.id);
  }
  assert.deepEqual(CURATED_LANGUAGES.map((l) => l.code), [...LANGUAGE_CODES]);
  assert.match(familyInfo("tts", "pocket")!.note!, /non-commercial/i);
});

test("switching family back restores the variant last picked there", () => {
  let c = chooseVariant(OPEN, "stt", "nemotron-en-560ms-int8");
  c = chooseFamily(c, "stt", "whisper");
  assert.equal(c.stt.variant, "whisper");
  assert.equal(chooseFamily(c, "stt", "nemotron").stt.variant, "nemotron-en-560ms-int8");
  // Survives a save and a load.
  assert.equal(chooseFamily(mergePipelineConfig(JSON.parse(JSON.stringify(c))), "stt", "nemotron").stt.variant, "nemotron-en-560ms-int8");
  // A remembered variant that does not speak the language gives way to the default for it.
  assert.equal(chooseFamily({ ...chooseVariant(c, "stt", "parakeet-110m-int8"), language: "fr" }, "stt", "parakeet").stt.variant, "parakeet-0.6b-v3-int8");
});

test("choosing a TTS engine keeps a voice it has, else its default, else lets the agent pick", () => {
  const onyx = { ...OPEN, tts: { ...OPEN.tts, voice: "am_onyx" } };
  assert.equal(chooseFamily(onyx, "tts", "supertonic").tts.voice, "M1");
  assert.equal(chooseFamily(onyx, "tts", "kitten").tts.voice, "bella");
  assert.equal(chooseFamily(onyx, "tts", "piper").tts.voice, "");
  assert.equal(chooseFamily(onyx, "tts", "clone").tts.voice, "");
  const piper = { ...chooseVariant(onyx, "tts", "piper-en_US-libritts_r-medium-int8"), tts: { ...chooseVariant(onyx, "tts", "piper-en_US-libritts_r-medium-int8").tts, voice: "3922" } };
  assert.equal(chooseVariant(piper, "tts", "piper-en_US-libritts_r-medium-int8").tts.voice, "3922");
  assert.equal(chooseVariant(piper, "tts", "piper-en_US-amy-low-int8").tts.voice, "");
  // A variant of the wrong stage changes nothing.
  assert.equal(chooseVariant(onyx, "stt", "kokoro"), onyx);
});

test("languageSupport: by config, by variant, by family", () => {
  assert.deepEqual(languageSupport(DEFAULT_PIPELINE_CONFIG, "en"), { stt: true, tts: true });
  assert.deepEqual(languageSupport(DEFAULT_PIPELINE_CONFIG, "ja"), { stt: true, tts: false }); // Whisper speaks it, browser Kokoro does not
  assert.equal(languageSupport("parakeet-0.6b-v2-int8", "es"), false);
  assert.equal(languageSupport("parakeet", "es"), true); // v3 does
  assert.equal(languageSupport("supertonic", "ja"), true);
  assert.equal(languageSupport("supertonic", "zh"), false);
  assert.equal(languageSupport("clone", "zh"), true);
  assert.equal(languageSupport("kokoro-native", "ko"), false);
  assert.equal(languageSupport("nemotron", "de"), false);
  assert.equal(languageSupport("nemotron-3.5", "hi"), true);
  assert.equal(languageSupport("nothing", "en"), false);
});

test("every curated language has a recommended STT and TTS engine that speaks it", () => {
  for (const lang of LANGUAGE_CODES) {
    for (const stage of ["stt", "tts"] as const) assert.equal(languageSupport(LANGUAGE_DEFAULTS[lang][stage], lang), true, `${lang} ${stage}`);
  }
  assert.equal(browserTtsFallback("en"), "kokoro");
  assert.equal(browserTtsFallback("ko"), "supertonic");
  assert.equal(browserTtsFallback("zh"), null);
  assert.equal(defaultVariant(familyInfo("tts", "piper")!, "de"), "piper-de_DE-thorsten-medium-int8");
  assert.equal(defaultVariant(familyInfo("tts", "piper")!, "it"), "piper-it_IT-riccardo-x_low-int8"); // the open Italian voice
  assert.equal(defaultVariant(familyInfo("tts", "piper")!, "it", true), "piper-it_IT-paola-medium-int8");
  assert.equal(defaultVariant(familyInfo("tts", "piper")!, "en"), "piper-en_US-libritts_r-medium-int8"); // lessac is restricted
  assert.equal(defaultVariant(familyInfo("tts", "piper")!, "hi"), "piper-hi_IN-rohan-medium-int8"); // no open voice: the pick waits for the user's OK
  assert.equal(defaultVariant(familyInfo("tts", "piper")!, "ja"), "piper-en_US-lessac-medium-int8"); // nothing speaks it: the family default
});

test("pickCompatible: from the browser defaults, every curated language", () => {
  const want: Record<string, string> = {
    en: "kokoro", es: "supertonic", fr: "supertonic", de: "supertonic", it: "supertonic", pt: "supertonic", hi: "supertonic",
    zh: "kokoro-multi-v1_0", ja: "supertonic", ko: "supertonic",
  };
  for (const lang of LANGUAGE_CODES) {
    const { cfg, changes, unsupported } = pickCompatible(DEFAULT_PIPELINE_CONFIG, lang);
    assert.equal(cfg.language, lang);
    assert.equal(cfg.stt.variant, "whisper", lang); // Whisper's multilingual build speaks them all
    assert.equal(cfg.tts.variant, want[lang], lang);
    assert.deepEqual(unsupported, []);
    assert.deepEqual(changes.map((c) => c.stage), lang === "en" ? [] : ["tts"], lang);
    assert.deepEqual(languageSupport(cfg, lang), { stt: true, tts: true }, lang);
  }
});

test("pickCompatible: from native engines, every curated language, with and without the agent's catalog", () => {
  const native = chooseVariant(chooseVariant(OPEN, "stt", "parakeet-0.6b-v2-int8"), "tts", "pocket-int8");
  const offline: Record<string, [string, string]> = {
    en: ["parakeet-0.6b-v2-int8", "pocket-int8"],
    es: ["parakeet-0.6b-v3-int8", "kokoro-multi-v1_0"], fr: ["parakeet-0.6b-v3-int8", "kokoro-multi-v1_0"],
    de: ["parakeet-0.6b-v3-int8", "piper-de_DE-thorsten-medium-int8"], it: ["parakeet-0.6b-v3-int8", "kokoro-multi-v1_0"],
    pt: ["parakeet-0.6b-v3-int8", "kokoro-multi-v1_0"], hi: ["nemotron-3.5-160ms-int8", "kokoro-multi-v1_0"],
    zh: ["nemotron-3.5-160ms-int8", "kokoro-multi-v1_0"], ja: ["nemotron-3.5-160ms-int8", "supertonic"], ko: ["nemotron-3.5-160ms-int8", "supertonic"],
  };
  for (const lang of LANGUAGE_CODES) {
    const { cfg } = pickCompatible(native, lang);
    assert.deepEqual([cfg.stt.variant, cfg.tts.variant], offline[lang], lang);
  }
  // The catalog says only Pocket, Parakeet v2 and Nemotron 3.5 are downloaded:
  // downloaded engines first, then the browser, and a download only as a last resort.
  const catalog = [{ variants: [{ id: "parakeet-0.6b-v2-int8", installed: true }, { id: "parakeet-0.6b-v3-int8", installed: false }] },
    { variants: [{ id: "nemotron-3.5-160ms-int8", installed: true }, { id: "pocket-int8", installed: true }, { id: "kokoro-multi-v1_0", installed: false }] }];
  const es = pickCompatible(native, "es", catalog);
  assert.deepEqual([es.cfg.stt.variant, es.cfg.tts.variant], ["whisper", "supertonic"]);
  assert.deepEqual(es.changes, [
    { stage: "stt", from: "parakeet-0.6b-v2-int8", to: "whisper", needsDownload: false },
    { stage: "tts", from: "pocket-int8", to: "supertonic", needsDownload: false },
  ]);
  assert.equal(pickCompatible(native, "hi", catalog).cfg.stt.variant, "nemotron-3.5-160ms-int8");
  const zh = pickCompatible(native, "zh", catalog);
  assert.deepEqual(zh.changes.find((c) => c.stage === "tts"), { stage: "tts", from: "pocket-int8", to: "kokoro-multi-v1_0", needsDownload: true });
  // Staying in a family: Parakeet v2 → v3 when v3 is there.
  const withV3 = [{ variants: [{ id: "parakeet-0.6b-v3-int8", installed: true }] }];
  assert.equal(pickCompatible(native, "fr", withV3).cfg.stt.variant, "parakeet-0.6b-v3-int8");
});

// ── restricted licenses ──────────────────────────────────────────────────────

test("restricted: the audited catalog marks the non-open models and nothing a default leans on", () => {
  for (const id of ["pocket-int8", "clone", "piper-en_US-lessac-medium-int8", "piper-en_US-amy-medium-int8", "piper-es_AR-daniela-high-int8",
    "piper-fr_FR-tom-medium-int8", "piper-it_IT-paola-medium-int8", "piper-hi_IN-rohan-medium-int8", "piper-zh_CN-xiao_ya-medium-int8", "piper-zh_CN-huayan-medium"]) assert.ok(isRestricted(id), id);
  for (const id of ["supertonic", "kokoro", "whisper", "nemotron-en-160ms-int8", "nemotron-3.5-160ms-int8", "piper-de_DE-ramona-low-int8", "piper-de_DE-thorsten-medium-int8",
    "piper-de_DE-kerstin-low-int8", "piper-en_US-libritts_r-medium-int8", "piper-fr_FR-siwis-low-int8", "piper-zh_CN-chaowen-medium-int8", "kitten-nano-int8", "matcha-en-ljspeech"]) assert.equal(isRestricted(id), false, id);
  for (const f of [...STT_FAMILIES, ...TTS_FAMILIES]) if (f.variants.some((v) => v.restricted)) assert.ok(f.restriction && f.licenseUrl, f.id);
  assert.equal(isRestricted(DEFAULT_PIPELINE_CONFIG.stt.variant) || isRestricted(DEFAULT_PIPELINE_CONFIG.tts.variant), false);
  for (const lang of LANGUAGE_CODES) {
    for (const stage of ["stt", "tts"] as const) assert.equal(isRestricted(LANGUAGE_DEFAULTS[lang][stage]), false, `${lang} ${stage}`);
    assert.equal(isRestricted(browserTtsFallback(lang) ?? undefined), false, lang);
    // A family's default is open wherever an open variant speaks the language.
    for (const f of [...STT_FAMILIES, ...TTS_FAMILIES]) {
      if (f.variants.some((v) => !v.restricted && v.languages.includes(lang))) assert.equal(isRestricted(defaultVariant(f, lang)), false, `${f.id} ${lang}`);
    }
  }
});

test("restricted: never chosen without the user's OK, by a pick, a family switch or a language switch", () => {
  const d = DEFAULT_PIPELINE_CONFIG;
  assert.equal(chooseVariant(d, "tts", "pocket-int8"), d);
  assert.equal(chooseVariant(d, "tts", "clone"), d);
  assert.equal(chooseVariant(d, "tts", "piper-en_US-lessac-medium-int8"), d);
  const hi = { ...d, language: "hi" as const };
  assert.equal(chooseFamily(hi, "tts", "piper"), hi); // no open Hindi voice
  assert.equal(chooseFamily({ ...d, language: "it" }, "tts", "piper").tts.variant, "piper-it_IT-riccardo-x_low-int8");
  // A remembered restricted pick gives way to an open one once the OK is withdrawn.
  const remembered = { ...chooseVariant({ ...OPEN, language: "it" }, "tts", "piper-it_IT-paola-medium-int8"), allowRestricted: false };
  assert.equal(chooseFamily(chooseVariant(remembered, "tts", "kokoro-multi-v1_0"), "tts", "piper").tts.variant, "piper-it_IT-riccardo-x_low-int8");
  assert.equal(chooseVariant(OPEN, "tts", "pocket-int8").tts.variant, "pocket-int8");
  // Language switches from every engine, with and without the catalog, land on open engines only.
  const catalog = [...STT_FAMILIES, ...TTS_FAMILIES].map((f) => ({ variants: f.variants.map((v) => ({ id: v.id, installed: true })) }));
  for (const tts of TTS_FAMILIES.flatMap((f) => f.variants.map((v) => v.id))) {
    const from = { ...chooseVariant(OPEN, "tts", tts), allowRestricted: false };
    for (const lang of LANGUAGE_CODES) {
      for (const cat of [undefined, catalog]) {
        const { cfg, changes } = pickCompatible(from, lang, cat);
        for (const ch of changes) assert.equal(isRestricted(ch.to), false, `${tts} → ${lang}: ${ch.to}`);
        assert.ok(cfg.tts.variant === tts || !isRestricted(cfg.tts.variant), `${tts} → ${lang}`);
      }
    }
  }
});

test("restricted: an engine picked before the gate keeps working, and the OK persists", () => {
  const pocket = mergePipelineConfig({ tts: { engine: "pocket", voice: "loona" } });
  assert.equal(pocket.tts.variant, "pocket-int8");
  assert.equal(pocket.allowRestricted, false);
  assert.equal(pickCompatible(pocket, "en").cfg.tts.variant, "pocket-int8");
  assert.equal(mergePipelineConfig({ allowRestricted: "yes" }).allowRestricted, false);
  const store = new Map<string, string>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  try {
    savePipelineConfig(chooseVariant(OPEN, "tts", "piper-en_US-lessac-medium-int8"));
    const loaded = loadPipelineConfig();
    assert.equal(loaded.allowRestricted, true);
    assert.equal(loaded.tts.variant, "piper-en_US-lessac-medium-int8");
  } finally { vi.unstubAllGlobals(); }
});

test("pickCompatible leaves a config that already speaks the language alone", () => {
  const c = chooseVariant(chooseVariant(DEFAULT_PIPELINE_CONFIG, "stt", "nemotron-3.5-560ms-int8"), "tts", "kokoro-multi-v1_0");
  const r = pickCompatible(c, "zh");
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.cfg, { ...c, language: "zh" });
});

// ── what the browser loads ────────────────────────────────────────────────

test("whisperCheckpoint: the English build for English, the multilingual build of the same size otherwise", () => {
  assert.equal(whisperCheckpoint("base", "en", "webgpu"), "onnx-community/whisper-base.en");
  assert.equal(whisperCheckpoint("base", "es", "webgpu"), "onnx-community/whisper-base");
  assert.equal(whisperCheckpoint("small", "ja", "webgpu"), "onnx-community/whisper-small");
  assert.equal(whisperCheckpoint("large-v3-turbo", "en", "webgpu"), "onnx-community/whisper-large-v3-turbo");
  assert.equal(whisperCheckpoint("large-v3-turbo", "zh", "webgpu"), "onnx-community/whisper-large-v3-turbo");
  assert.equal(whisperCheckpoint("small", "en", "wasm"), "onnx-community/whisper-tiny.en");
  assert.equal(whisperCheckpoint("small", "ko", "wasm"), "onnx-community/whisper-tiny");
});

test("whisperMaxTokens: a short clip cannot loop to Whisper's 448-token limit; real speech still fits", () => {
  // A 0.26 s partial of German barge-in speech decoded a repeated phrase for 7.6 s (measured 2026-09-24).
  assert.ok(whisperMaxTokens(4096) <= 32);
  // Hindi, the densest curated language: 58 tokens in 3.76 s (the whisper-base tokenizer).
  assert.ok(whisperMaxTokens(3.76 * 16000) >= 2 * 58);
  assert.equal(whisperMaxTokens(20 * 16000), 440);
});

test("workerTag: moving between native engines keeps the warm worker; browser weights change it", () => {
  const cfg = (stt: string, tts: string, whisperSize = "base", language = "en") => mergePipelineConfig({ language, stt: { engine: stt, whisperSize }, tts: { engine: tts } });
  // Unchanged for English, so an existing cached flag still matches.
  assert.equal(workerTag(cfg("whisper", "kokoro"), "webgpu"), "webgpu:base:kokoro");
  assert.equal(workerTag(cfg("whisper", "kokoro", "small"), "wasm"), "wasm:tiny:kokoro");
  assert.equal(workerTag(cfg("whisper", "kokoro", "large-v3-turbo"), "webgpu"), "webgpu:large-v3-turbo:kokoro");
  assert.equal(workerTag(cfg("parakeet", "pocket"), "webgpu"), workerTag(cfg("nemotron", "kitten"), "webgpu"));
  assert.equal(workerTag(cfg("moonshine", "kitten", "small"), "webgpu"), "webgpu:native:native");
  assert.notEqual(workerTag(cfg("parakeet", "kitten"), "webgpu"), workerTag(cfg("parakeet", "kokoro"), "webgpu"));
  assert.notEqual(workerTag(cfg("parakeet", "clone"), "webgpu"), workerTag(cfg("parakeet", "pocket"), "webgpu"));
  // The multilingual build is another download; large-v3-turbo is the same one in every language.
  assert.equal(workerTag(cfg("whisper", "supertonic", "base", "es"), "webgpu"), "webgpu:base-ml:supertonic");
  assert.equal(workerTag(cfg("whisper", "supertonic", "small", "ja"), "wasm"), "wasm:tiny-ml:supertonic");
  assert.equal(workerTag(cfg("whisper", "kokoro", "large-v3-turbo", "ko"), "webgpu"), "webgpu:large-v3-turbo:kokoro");
  // A browser voice the agent runs loads nothing in the browser either.
  assert.equal(workerTag(cfg("whisper", "supertonic"), "webgpu", true), "webgpu:base:native");
  assert.equal(tagCached("webgpu:base-ml:supertonic", ["webgpu:base:supertonic"]), false);
});

test("browserModels: only what the worker downloads for the selected engines", () => {
  const cfg = (stt: string, tts: string) => mergePipelineConfig({ stt: { engine: stt }, tts: { engine: tts } });
  assert.deepEqual(browserModels(cfg("whisper", "kokoro")), ["speech", "voice", "turn-taking"]);
  assert.deepEqual(browserModels(cfg("parakeet", "pocket")), ["turn-taking"]);
  assert.deepEqual(browserModels(cfg("nemotron", "supertonic")), ["voice", "turn-taking"]);
  assert.deepEqual(browserModels(cfg("whisper", "kitten")), ["speech", "turn-taking"]);
  assert.deepEqual(browserModels(cfg("moonshine", "clone")), ["voice", "turn-taking"]); // a browser voice stays as the clone's fallback
});

test("a config counts as cached when every part it downloads was loaded before, on the same tier", () => {
  // Moving to native engines needs only Smart-Turn, which every load brought.
  assert.equal(tagCached("webgpu:native:native", ["webgpu:base:kokoro"]), true);
  assert.equal(tagCached("webgpu:base:native", ["webgpu:native:native", "webgpu:base:supertonic"]), true);
  assert.equal(tagCached("webgpu:small:kokoro", ["webgpu:base:kokoro"]), false);
  assert.equal(tagCached("webgpu:base:supertonic", ["webgpu:base:kokoro"]), false);
  assert.equal(tagCached("wasm:native:native", ["webgpu:base:kokoro"]), false);
  assert.equal(tagCached("webgpu:native:native", []), false);
});
