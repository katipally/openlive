import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// DATA_DIR is resolved when @openlive/db loads, so point it at a temp dir first.
let dir: string;
let m: typeof import("./native-models.js");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ol-native-"));
  process.env.OPENLIVE_DATA_DIR = dir;
  // Engines as a build from before variants left them on disk.
  for (const f of ["parakeet/tokens.txt", "kitten.part/stale", "pocket/old.txt", "pocket-int8/new.txt"]) {
    mkdirSync(dirname(join(dir, "models", f)), { recursive: true });
    writeFileSync(join(dir, "models", f), "x");
  }
  vi.resetModules();
  m = await import("./native-models.js");
});
afterAll(() => {
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("native engine catalog", () => {
  it("gives every variant a unique id, a pinned URL, a size, files, languages and a license", () => {
    const ids = m.NATIVE_ENGINES.flatMap((e) => [e.id, e.legacyId ?? []].flat());
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of m.NATIVE_ENGINES) {
      expect(e.sizeBytes).toBeGreaterThan(1_000_000);
      expect(e.files.length).toBeGreaterThan(0);
      expect(e.languages.length).toBeGreaterThan(0);
      for (const l of e.languages) expect(l).toMatch(/^[a-z]{2}$/);
      expect(e.license).toBeTruthy();
      // An onnxruntime engine's files come one by one from a Hugging Face revision.
      if (m.onOrt(e)) { expect(e.url).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}$/); continue; }
      expect(e.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/(asr|tts)-models\/.+\.tar\.bz2$/);
      expect(e.url).toContain(`/${e.kind}-models/`);
      expect(e.files.some((f) => /^tokens\.txt$|^vocab\.json$/.test(f))).toBe(true);
    }
  });

  it("groups variants into families of one kind", () => {
    expect(m.NATIVE_FAMILIES.map((f) => f.id)).toEqual(["nemotron", "nemotron-3.5", "parakeet", "moonshine", "canary", "pocket", "kitten", "piper", "kokoro-native", "supertonic", "matcha"]);
    // Supertonic is the browser's voice, run here; not a pick of its own.
    expect(m.NATIVE_FAMILIES.filter((f) => f.browser).map((f) => [f.id, f.browser])).toEqual([["supertonic", "supertonic"]]);
    for (const f of m.NATIVE_FAMILIES) {
      expect(f.variants.length).toBeGreaterThan(0);
      for (const v of f.variants) expect([v.family, v.kind]).toEqual([f.id, f.kind]);
    }
  });

  it("streams only on the Nemotron variants, each with its chunk latency", () => {
    const streaming = m.NATIVE_ENGINES.filter((e) => e.streaming);
    expect(streaming.map((e) => e.family)).toEqual([...Array(4).fill("nemotron"), ...Array(5).fill("nemotron-3.5")]);
    expect(streaming.map((e) => e.latencyMs)).toEqual([80, 160, 560, 1120, 80, 160, 320, 560, 1120]);
    expect(streaming.every((e) => e.type === "online-transducer" && e.kind === "asr")).toBe(true);
  });

  it("maps every pre-variant engine id to the variant it downloaded", () => {
    const legacy = Object.fromEntries(m.NATIVE_ENGINES.filter((e) => e.legacyId).map((e) => [e.legacyId, e.id]));
    expect(legacy).toEqual({
      nemotron: "nemotron-en-160ms-int8", parakeet: "parakeet-0.6b-v2-int8", moonshine: "moonshine-base-en-int8", pocket: "pocket-int8", kitten: "kitten-nano-int8",
    });
    expect(m.nativeEngine("nemotron")!.url).toContain("nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25");
    expect(m.nativeEngine("kitten")!.url).toContain("kitten-nano-en-v0_8-int8");
  });

  it("gives every TTS voice a language the variant lists, and every language a voice", () => {
    // A voice without a language speaks every one of the variant's.
    for (const e of m.NATIVE_ENGINES.filter((x) => x.kind === "tts")) {
      expect(new Set(e.voices!.flatMap((v) => v.lang ?? e.languages))).toEqual(new Set(e.languages));
    }
    const kokoro = m.nativeEngine("kokoro-multi-v1_0-int8")!;
    expect(kokoro.languages).toEqual(["en", "es", "fr", "hi", "it", "pt", "zh"]);
    expect(kokoro.voices!.find((v) => v.id === "pf_dora")!.sid).toBe(42);
    expect(kokoro.voices!.find((v) => v.id === "ef_dora")).toMatchObject({ lang: "es", espeak: "es", gender: "female", sid: 28 });
    expect(kokoro.voices!.at(-1)).toMatchObject({ id: "zm_yunyang", sid: 52 });
  });

  it("covers every curated language with a streaming ASR and a TTS variant", () => {
    for (const lang of ["en", "es", "fr", "de", "it", "pt", "hi", "zh", "ja", "ko"]) {
      expect(m.NATIVE_ENGINES.some((e) => e.streaming && e.languages.includes(lang))).toBe(true);
      if (lang !== "ko" && lang !== "ja") expect(m.NATIVE_ENGINES.some((e) => e.kind === "tts" && e.languages.includes(lang))).toBe(true);
    }
  });

  it("names the Piper model file after the archive's voice and tier", () => {
    const p = m.nativeEngine("piper-en_US-lessac-medium-int8")!;
    expect(p.url).toMatch(/\/tts-models\/vits-piper-en_US-lessac-medium-int8\.tar\.bz2$/);
    expect(p.files).toEqual(["en_US-lessac-medium.onnx", "tokens.txt", "espeak-ng-data/phontab"]);
    expect(m.nativeEngine("piper-zh_CN-huayan-medium")!.url).toMatch(/vits-piper-zh_CN-huayan-medium\.tar\.bz2$/);
    expect(m.nativeEngine("piper-zh_CN-chaowen-medium-int8")!.files).toContain("lexicon.txt");
    const perLang = new Map<string, Set<string>>();
    for (const e of m.NATIVE_ENGINES.filter((x) => x.family === "piper")) {
      const speaker = e.id.split("-")[2]!;
      perLang.set(e.languages[0]!, (perLang.get(e.languages[0]!) ?? new Set()).add(speaker));
    }
    for (const [lang, speakers] of perLang) expect(speakers.size, lang).toBeLessThanOrEqual(lang === "en" ? 4 : 3);
  });

  it("gives every TTS engine unique voices that resolve to a speaker id, a shipped wav or a style file", () => {
    for (const e of m.NATIVE_ENGINES.filter((x) => x.kind === "tts")) {
      const ids = e.voices!.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const v of e.voices!) {
        expect(v.sid !== undefined || (v.wav !== undefined && e.files.includes(v.wav)) || (m.onOrt(e) && e.files.includes(`voice_styles/${v.id}.json`))).toBe(true);
      }
    }
    expect(m.nativeEngine("kitten")!.voices!.map((v) => v.sid)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("looks engines up by variant id or pre-variant id", () => {
    expect(m.nativeEngine("parakeet")?.id).toBe("parakeet-0.6b-v2-int8");
    expect(m.nativeEngine("parakeet-0.6b-v3-int8")?.kind).toBe("asr");
    expect(m.nativeEngine("nope")).toBeUndefined();
    expect(m.nativeEngine(undefined)).toBeUndefined();
  });

  it("reads a language code from a tag or any case, and nothing from blank", () => {
    expect(m.langCode("en-US")).toBe("en");
    expect(m.langCode(" PT_br ")).toBe("pt");
    expect(m.langCode("")).toBeNull();
    expect(m.langCode(undefined)).toBeNull();
  });
});

describe("sherpaConfig", () => {
  it("builds each model type from the variant's own file names", () => {
    const cfg = (id: string) => JSON.parse(JSON.stringify(m.sherpaConfig(m.nativeEngine(id)!, { provider: "cpu", numThreads: 2 })));
    const dir = (id: string) => m.engineDir(m.nativeEngine(id)!.id);
    expect(cfg("parakeet-0.6b-v2-fp16").modelConfig).toMatchObject({ modelType: "nemo_transducer", transducer: { encoder: join(dir("parakeet-0.6b-v2-fp16"), "encoder.fp16.onnx") } });
    expect(cfg("nemotron").modelConfig.transducer.joiner).toBe(join(dir("nemotron"), "joiner.int8.onnx"));
    expect(cfg("canary-180m-flash-int8").modelConfig.canary).toMatchObject({ srcLang: "en", tgtLang: "en", decoder: join(dir("canary-180m-flash-int8"), "decoder.int8.onnx") });
    expect(cfg("pocket-fp32").model.pocket.lmMain).toBe(join(dir("pocket-fp32"), "lm_main.onnx"));
    expect(cfg("kitten-mini-fp32").model.kitten.model).toBe(join(dir("kitten-mini-fp32"), "model.onnx"));
    expect(cfg("kokoro-multi-v1_0-int8").model.kokoro.lexicon).toBe(["lexicon-us-en.txt", "lexicon-zh.txt"].map((f) => join(dir("kokoro-multi-v1_0-int8"), f)).join(","));
    expect(cfg("kokoro-en-v0_19-int8").model.kokoro.lexicon).toBe("");
    expect(cfg("piper-de_DE-thorsten-high-int8")).toMatchObject({ ruleFsts: "", model: { vits: { lexicon: "", dataDir: join(dir("piper-de_DE-thorsten-high-int8"), "espeak-ng-data") } } });
    expect(cfg("piper-zh_CN-xiao_ya-medium-int8")).toMatchObject({ model: { vits: { dataDir: "", lexicon: join(dir("piper-zh_CN-xiao_ya-medium-int8"), "lexicon.txt") } } });
    expect(cfg("piper-zh_CN-xiao_ya-medium-int8").ruleFsts.split(",")).toHaveLength(3);
    expect(cfg("matcha-en-ljspeech").model.matcha.vocoder).toBe(join(dir("matcha-en-ljspeech"), "vocos-22khz-univ.onnx"));
    expect(cfg("supertonic-3")).toEqual({ dir: dir("supertonic-3"), provider: "cpu", numThreads: 2 });
  });

  it("runs every model type where accel.ts chose, on its thread count", () => {
    for (const e of m.NATIVE_ENGINES) {
      const cfg = m.sherpaConfig(e, { provider: "coreml", numThreads: 3 }) as { modelConfig?: object; model?: object };
      expect(cfg.modelConfig ?? cfg.model ?? cfg).toMatchObject({ provider: "coreml", numThreads: 3 });
    }
  });
});

describe("engines downloaded before variants existed", () => {
  it("move to their variant's dir once, and never over one already there", () => {
    const models = join(dir, "models");
    expect(existsSync(join(models, "parakeet-0.6b-v2-int8", "tokens.txt"))).toBe(true);
    expect(existsSync(join(models, "parakeet"))).toBe(false);
    expect(existsSync(join(models, "kitten.part"))).toBe(false);
    expect(existsSync(join(models, "pocket", "old.txt"))).toBe(true);
    expect(existsSync(join(models, "pocket-int8", "new.txt"))).toBe(true);
  });
});

describe("install state", () => {
  it("is installed only when every expected file exists", () => {
    const e = m.nativeEngine("moonshine")!;
    expect(m.engineInstalled(e)).toBe(false);
    expect(m.engineDiskBytes(e.id)).toBe(0);
    for (const f of e.files.slice(1)) { const p = join(m.engineDir(e.id), f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "xx"); }
    expect(m.engineInstalled(e)).toBe(false);
    writeFileSync(join(m.engineDir(e.id), e.files[0]!), "xx");
    expect(m.engineInstalled(e)).toBe(true);
    expect(m.engineDiskBytes(e.id)).toBe(2 * e.files.length);
    rmSync(m.engineDir(e.id), { recursive: true });
  });
});

describe("downloadEngine", () => {
  const e = () => m.nativeEngine("kitten")!;
  const leftovers = () => [m.engineDir(e().id), `${m.engineDir(e().id)}.part`].filter(existsSync);

  it("fails cleanly on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(m.downloadEngine(e(), () => {}, new AbortController().signal)).rejects.toThrow("HTTP 404");
    expect(leftovers()).toEqual([]);
  });

  it("fails cleanly when offline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(m.downloadEngine(e(), () => {}, new AbortController().signal)).rejects.toThrow("fetch failed");
    expect(leftovers()).toEqual([]);
  });

  it("clears a stale .part from a killed download and fails cleanly on a corrupt archive", async () => {
    mkdirSync(`${m.engineDir(e().id)}.part`, { recursive: true });
    writeFileSync(join(`${m.engineDir(e().id)}.part`, "stale"), "x");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))));
    let bytes = 0;
    await expect(m.downloadEngine(e(), (n) => { bytes += n; }, new AbortController().signal)).rejects.toThrow();
    expect(bytes).toBe(4);
    expect(leftovers()).toEqual([]);
  });
});

describe("downloadEngine, file by file", () => {
  const e = () => m.nativeEngine("supertonic-3")!;

  it("fetches every file of a variant without an archive from its pinned revision, then moves them into place", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { urls.push(url); return new Response(new Uint8Array([1, 2, 3])); }));
    let bytes = 0;
    await m.downloadEngine(e(), (n) => { bytes += n; }, new AbortController().signal);
    expect(urls).toEqual(e().files.map((f) => `${e().url}/${f}`));
    expect(bytes).toBe(3 * e().files.length);
    expect(m.engineInstalled(e())).toBe(true);
    expect(existsSync(`${m.engineDir(e().id)}.part`)).toBe(false);
    rmSync(m.engineDir(e().id), { recursive: true });
  });

  it("leaves nothing behind when one file fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("vocoder.onnx") ? new Response("", { status: 503 }) : new Response(new Uint8Array([1])))));
    await expect(m.downloadEngine(e(), () => {}, new AbortController().signal)).rejects.toThrow("HTTP 503");
    expect([m.engineDir(e().id), `${m.engineDir(e().id)}.part`].filter(existsSync)).toEqual([]);
  });
});

describe("speakable", () => {
  it("drops emoji and code symbols the native voices would read out by name", () => {
    expect(m.speakable("Nice work 🎉 that fixed it ✅ and 👍🏽 👨‍👩‍👧 🇺🇸 1️⃣")).toBe("Nice work that fixed it and 1");
    expect(m.speakable("Run const x = a => b; then if (x != null) { y++ } done.")).toBe("Run const x = a b; then if (x null) y++ done.");
    expect(m.speakable("my_file `code` <tag> a|b c\\d x^2 ~ok *bold* [1]")).toBe("my file code tag a b c d x 2 ok bold 1");
  });

  it("keeps prose, numbers and the symbols that read naturally", () => {
    const prose = "It costs $5.99, about 50% & more: 2 + 2 = 4, email me @user. Wow! Café naïve, v0.2.4 (really)?";
    expect(m.speakable(prose)).toBe(prose);
    expect(m.speakable("🎉 ✅")).toBe("");
  });
});
