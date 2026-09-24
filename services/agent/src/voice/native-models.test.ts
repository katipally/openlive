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
  vi.resetModules();
  m = await import("./native-models.js");
});
afterAll(() => {
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("native engine catalog", () => {
  it("has the five engines with unique ids and sherpa release URLs", () => {
    expect(m.NATIVE_ENGINES.map((e) => `${e.kind}:${e.id}`)).toEqual(["asr:nemotron", "asr:parakeet", "asr:moonshine", "tts:pocket", "tts:kitten"]);
    for (const e of m.NATIVE_ENGINES) {
      expect(e.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/(asr|tts)-models\/.+\.tar\.bz2$/);
      expect(e.url).toContain(`/${e.kind}-models/`);
      expect(e.sizeBytes).toBeGreaterThan(0);
      expect(e.files.length).toBeGreaterThan(0);
    }
  });

  it("only nemotron streams", () => {
    expect(m.NATIVE_ENGINES.filter((e) => e.streaming).map((e) => e.id)).toEqual(["nemotron"]);
  });

  it("gives every TTS engine unique voices that resolve to a speaker id or a shipped wav", () => {
    for (const e of m.NATIVE_ENGINES.filter((x) => x.kind === "tts")) {
      const ids = e.voices!.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const v of e.voices!) {
        expect(v.sid !== undefined || (v.wav !== undefined && e.files.includes(v.wav))).toBe(true);
      }
    }
    expect(m.nativeEngine("kitten")!.voices!.map((v) => v.sid)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("looks engines up by id", () => {
    expect(m.nativeEngine("parakeet")?.kind).toBe("asr");
    expect(m.nativeEngine("nope")).toBeUndefined();
    expect(m.nativeEngine(undefined)).toBeUndefined();
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
  const leftovers = () => [m.engineDir("kitten"), `${m.engineDir("kitten")}.part`].filter(existsSync);

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
    mkdirSync(`${m.engineDir("kitten")}.part`, { recursive: true });
    writeFileSync(join(`${m.engineDir("kitten")}.part`, "stale"), "x");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))));
    let bytes = 0;
    await expect(m.downloadEngine(e(), (n) => { bytes += n; }, new AbortController().signal)).rejects.toThrow();
    expect(bytes).toBe(4);
    expect(leftovers()).toEqual([]);
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
