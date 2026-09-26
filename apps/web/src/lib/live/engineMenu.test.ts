import { describe, expect, test } from "vitest";
import { engineName, languageLabel, languagesNote, licenseTag, missingEngines, switchNotice, variantGroups, voiceMenu } from "./engineMenu";
import { TTS_FAMILIES, pickCompatible, chooseVariant, DEFAULT_PIPELINE_CONFIG } from "./pipelineConfig";

describe("language names", () => {
  test("English stays plain; others lead with their own name", () => {
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel("es")).toBe("Español (Spanish)");
    expect(languageLabel("ja")).toBe("日本語 (Japanese)");
    expect(languageLabel("zh")).toBe("中文 (Chinese, Mandarin)");
  });
  test("a greyed engine names the curated languages it speaks, in the picker's order", () => {
    expect(languagesNote(["en"])).toBe("English only");
    expect(languagesNote(["en", "es", "de", "fr"])).toBe("English, Spanish, French, German");
    expect(languagesNote(["nl", "en", "es", "fr", "de", "it", "pt", "hi", "zh", "ja", "ko", "ru"])).toBe("All 10 languages");
  });
});

test("restrictive and unknown licenses are flagged, the rest pass through", () => {
  expect(licenseTag("CC BY-NC-SA 4.0").kind).toBe("restricted");
  expect(licenseTag("CC-BY-4.0; the ONNX export is for non-commercial use (archive README)")).toEqual({ label: "Non-commercial", kind: "restricted" });
  expect(licenseTag("non-commercial (Data Baker BZNSYP)").label).toBe("Non-commercial");
  expect(licenseTag("AGPLv3")).toEqual({ label: "AGPLv3", kind: "restricted" });
  expect(licenseTag("unknown (MODEL_CARD)").kind).toBe("unknown");
  expect(licenseTag("see huggingface.co/datasets/paolapersico1/Voice-Dataset-Italian").kind).toBe("unknown");
  expect(licenseTag("CC0")).toEqual({ label: "CC0", kind: "open" });
  // Open only when the license is on the list and nothing in it restricts use;
  // a fine-tuned voice by its own data's license.
  expect(licenseTag("CC0; fine-tuned from lessac")).toEqual({ label: "CC0; fine-tuned from lessac", kind: "open" });
  expect(licenseTag("CC BY-SA 4.0; fine-tuned from lessac")).toEqual({ label: "Share-alike", kind: "restricted" });
  expect(licenseTag("IITM IndicTTS license; fine-tuned from lessac").kind).toBe("restricted");
  for (const open of ["MIT", "Apache-2.0", "CC-BY-4.0", "CC BY 3.0", "BSD-3-Clause style (M-AILABS)", "OpenMDW-1.1", "OpenRAIL-M", "NVIDIA Open Model License"]) expect(licenseTag(open).kind).toBe("open");
});

describe("Model menu groups", () => {
  const piper = TTS_FAMILIES.find((f) => f.id === "piper")!.variants;
  test("Piper's 32 voices group by language, the session's first, none lost", () => {
    const groups = variantGroups(piper, "de");
    expect(groups.map((g) => g.lang)).toEqual(["de", "en", "es", "fr", "it", "pt", "hi", "zh"]);
    expect(groups[0]!.variants.every((v) => v.id.startsWith("piper-de_DE"))).toBe(true);
    expect(groups.flatMap((g) => g.variants)).toHaveLength(piper.length);
  });
  test("a family of one language, or of multilingual variants, stays one flat list", () => {
    const kitten = TTS_FAMILIES.find((f) => f.id === "kitten")!.variants;
    expect(variantGroups(kitten, "en")).toEqual([{ variants: kitten }]);
    const kokoro = TTS_FAMILIES.find((f) => f.id === "kokoro-native")!.variants;
    expect(variantGroups(kokoro, "es")).toEqual([{ variants: kokoro }]);
    expect(variantGroups([], "en")).toEqual([{ variants: [] }]);
  });
});

test("the voice menu keeps the language's voices, with accents and genders where known", () => {
  const voices = [
    { id: "af_heart", name: "Heart", lang: "en", gender: "female" as const },
    { id: "bm_george", name: "George", lang: "en", gender: "male" as const },
    { id: "ef_dora", name: "Dora", lang: "es", gender: "female" as const },
    { id: "3922", name: "3922", lang: "en" },
    { id: "any", name: "Any" },
  ];
  expect(voiceMenu(voices, "en")).toEqual([
    { id: "af_heart", name: "Heart", group: "American", gender: "Female" },
    { id: "bm_george", name: "George", group: "British", gender: "Male" },
    { id: "3922", name: "3922", group: "English", gender: undefined },
    { id: "any", name: "Any", group: "Voices", gender: undefined },
  ]);
  expect(voiceMenu(voices, "es").map((v) => [v.id, v.group])).toEqual([["ef_dora", "Spanish"], ["any", "Voices"]]);
  expect(voiceMenu([], "ko")).toEqual([]);
});

describe("switch notice", () => {
  const catalog = [{ family: "parakeet", variants: [{ id: "parakeet-0.6b-v3-int8", name: "Parakeet TDT 0.6B v3 (25 languages)", installed: false }] }];
  test("names each swap in the agent's words, and what needs a download", () => {
    const moonshine = chooseVariant(DEFAULT_PIPELINE_CONFIG, "stt", "moonshine-base-en-int8");
    const { changes, unsupported } = pickCompatible(moonshine, "es", [...catalog, { variants: [{ id: "moonshine-base-en-int8", installed: true }] }]);
    const lines = switchNotice("es", changes, unsupported, (id) => engineName(id, [...catalog, { variants: [{ id: "moonshine-base-en-int8", name: "Moonshine Base" }] }]));
    expect(lines).toEqual([
      { text: "Speech-to-text switched from Moonshine Base to Whisper for Spanish.", download: undefined },
      { text: "Text-to-speech switched from Kokoro to Supertonic for Spanish.", download: undefined },
    ]);
  });
  test("a download and an uncovered stage each get their line", () => {
    const lines = switchNotice("zh", [{ stage: "stt", from: "whisper", to: "parakeet-0.6b-v3-int8", needsDownload: true }], ["tts"], (id) => engineName(id, catalog));
    expect(lines).toEqual([
      { text: "Speech-to-text switched from Whisper to Parakeet TDT 0.6B v3 (25 languages) for Chinese (Mandarin). It needs a one-time download.", download: "parakeet-0.6b-v3-int8" },
      { text: "No text-to-speech engine speaks Chinese (Mandarin) yet." },
    ]);
    expect(switchNotice("es", [], [], String)).toEqual([]);
  });
  test("a name falls back to the family (with the variant when it has several), then the id", () => {
    expect(engineName("canary-180m-flash-int8")).toBe("Canary");
    expect(engineName("piper-zh_CN-chaowen-medium-int8")).toBe("Piper zh_CN-chaowen-medium-int8");
    expect(engineName("nope")).toBe("nope");
  });
});

test("missingEngines: a selected native engine the agent has not downloaded, with what speaks instead", () => {
  const matcha = chooseVariant(DEFAULT_PIPELINE_CONFIG, "tts", "matcha-en-ljspeech");
  const catalog = (installed: boolean) => [{ variants: [{ id: "matcha-en-ljspeech", installed }, { id: "nemotron-3.5-160ms-int8", installed }] }];
  expect(missingEngines(matcha, catalog(false))).toEqual([{ stage: "tts", id: "matcha-en-ljspeech", standIn: "Kokoro" }]);
  expect(missingEngines(matcha, catalog(true))).toEqual([]);
  expect(missingEngines(matcha, undefined)).toEqual([]); // the agent not heard from: nothing to claim
  expect(missingEngines(matcha, [])).toEqual([]);        // not listed at all: nothing to offer
  const both = chooseVariant({ ...matcha, language: "zh" }, "stt", "nemotron-3.5-160ms-int8");
  expect(missingEngines(both, catalog(false))).toEqual([
    { stage: "stt", id: "nemotron-3.5-160ms-int8", standIn: "Whisper" },
    { stage: "tts", id: "matcha-en-ljspeech", standIn: null },
  ]);
  expect(missingEngines(DEFAULT_PIPELINE_CONFIG, catalog(false))).toEqual([]); // browser engines download in the browser
});
