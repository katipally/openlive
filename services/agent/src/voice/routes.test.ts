import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Route validation for the native engines. The worker client is stubbed, so
// no model is ever loaded; DATA_DIR points at a temp dir before any import.
const transcribe = vi.fn(async (_e: unknown, s: Float32Array) => `samples:${s.length}`);
const speak = vi.fn((_e: unknown, _t: string, _v: unknown, _s: number, onChunk: (s: Float32Array) => void) => {
  const cancel = vi.fn();
  const started = Promise.resolve(24_000);
  const done = started.then(() => { onChunk(new Float32Array([0.5, -0.5])); onChunk(new Float32Array([0.25])); });
  return { started, done, cancel };
});
vi.mock("./native.js", () => ({ transcribe, speak, unloadNative: vi.fn() }));

let dir: string;
let app: import("hono").Hono;
let m: typeof import("./native-models.js");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ol-routes-"));
  process.env.OPENLIVE_DATA_DIR = dir;
  vi.resetModules();
  m = await import("./native-models.js");
  app = (await import("./routes.js")).voiceRoutes;
});
afterAll(() => {
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { transcribe.mockClear(); speak.mockClear(); });

const install = (id: string) => {
  const e = m.nativeEngine(id)!;
  for (const f of e.files) { const p = join(m.engineDir(e.id), f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ""); }
};
const stt = (engine: string, body: Uint8Array, lang = "") => app.request(`/stt?engine=${engine}${lang && `&lang=${lang}`}`, { method: "POST", body, headers: { "content-type": "application/octet-stream" } });
const tts = (body: object) => app.request("/tts", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("GET /engines", () => {
  type Variant = Record<string, unknown> & { id: string; voices?: object[] };
  const list = async () => await (await app.request("/engines")).json() as Array<{ family: string; kind: string; name: string; variants: Variant[] }>;

  it("lists every family with its variants, install state and public voice fields", async () => {
    const families = await list();
    expect(families.map((f) => f.family)).toEqual(m.NATIVE_FAMILIES.map((f) => f.id));
    const kitten = families.find((f) => f.family === "kitten")!;
    expect(kitten).toMatchObject({ kind: "tts", name: "Kitten TTS" });
    expect(kitten.variants[0]).toMatchObject({
      id: "kitten-nano-int8", legacyId: "kitten", quality: "fastest", languages: ["en"], streaming: false, license: "Apache-2.0",
      installed: false, downloading: false, bytes: 0, sizeBytes: 31_220_690,
    });
    expect(kitten.variants[0]!.voices![0]).toEqual({ id: "jasper", name: "Jasper", lang: "en", gender: "male" });
    const parakeet = families.find((f) => f.family === "parakeet")!.variants;
    expect(parakeet.find((v) => v.id === "parakeet-0.6b-v2-int8")!.voices).toBeUndefined();
    expect(families.find((f) => f.family === "nemotron-3.5")!.variants[1]).toMatchObject({ streaming: true, latencyMs: 160 });
  });

  it("shows an engine downloaded under its pre-variant id as installed", async () => {
    install("moonshine");
    const moonshine = (await list()).find((f) => f.family === "moonshine")!.variants.find((v) => v.legacyId === "moonshine")!;
    expect(moonshine).toMatchObject({ id: "moonshine-base-en-int8", installed: true });
    expect((await app.request("/engines/moonshine", { method: "DELETE" })).status).toBe(200);
  });
});

describe("engine management", () => {
  it("rejects unknown engines", async () => {
    expect((await app.request("/engines/nope/download", { method: "POST" })).status).toBe(400);
    expect((await app.request("/engines/nope", { method: "DELETE" })).status).toBe(400);
  });

  it("refuses to download an installed engine, and DELETE removes it", async () => {
    install("pocket");
    expect((await app.request("/engines/pocket/download", { method: "POST" })).status).toBe(409);
    expect((await app.request("/engines/pocket", { method: "DELETE" })).status).toBe(200);
    expect(m.engineInstalled(m.nativeEngine("pocket")!)).toBe(false);
  });
});

describe("POST /stt", () => {
  it("needs a known ASR engine", async () => {
    expect((await stt("nope", new Uint8Array(4))).status).toBe(400);
    expect((await stt("kitten", new Uint8Array(4))).status).toBe(400);
  });

  it("answers 409 when the engine is not downloaded", async () => {
    const res = await stt("moonshine", new Uint8Array(4));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "engine-not-installed" });
  });

  it("validates the PCM body once installed", async () => {
    install("parakeet");
    expect((await stt("parakeet", new Uint8Array(6))).status).toBe(400);
    expect((await stt("parakeet", new Uint8Array(60 * 16_000 * 4 + 4))).status).toBe(413);
    expect(await (await stt("parakeet", new Uint8Array(0))).json()).toEqual({ text: "" });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("transcribes up to exactly 60 s", async () => {
    install("parakeet");
    const res = await stt("parakeet", new Uint8Array(60 * 16_000 * 4));
    expect(await res.json()).toEqual({ text: `samples:${60 * 16_000}` });
  });
});

describe("POST /stt language", () => {
  it("refuses a language the engine does not speak, before the install check", async () => {
    const res = await stt("parakeet", new Uint8Array(4), "de");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "language-not-supported" });
    expect((await stt("canary-180m-flash-int8", new Uint8Array(4), "ja")).status).toBe(400);
  });

  it("hands the engine the language as a bare ISO code, and nothing when none is asked", async () => {
    install("canary-180m-flash-int8");
    await stt("canary-180m-flash-int8", new Uint8Array(4), "de-DE");
    expect(transcribe.mock.calls[0]![3]).toBe("de");
    await stt("canary-180m-flash-int8", new Uint8Array(4));
    expect(transcribe.mock.calls[1]![3]).toBeUndefined();
  });
});

describe("POST /stt cancellation", () => {
  it("hands the engine a signal that aborts when the client hangs up", async () => {
    install("parakeet");
    let seen: AbortSignal | undefined;
    transcribe.mockImplementationOnce((_e: unknown, _s: Float32Array, signal?: AbortSignal) => { seen = signal; return new Promise<string>(() => {}); });
    const hangUp = new AbortController();
    void app.request("/stt?engine=parakeet", { method: "POST", body: new Uint8Array(64), headers: { "content-type": "application/octet-stream" }, signal: hangUp.signal });
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);
    hangUp.abort();
    expect(seen!.aborted).toBe(true);
  });
});

describe("POST /tts (native)", () => {
  it("validates engine, text, and voice before the install check", async () => {
    expect((await tts({ engine: "nope", text: "hi" })).status).toBe(400);
    expect((await tts({ engine: "parakeet", text: "hi" })).status).toBe(400);
    expect((await tts({ engine: "kitten", text: "  " })).status).toBe(400);
    expect((await tts({ engine: "kitten", text: "x".repeat(5_001) })).status).toBe(413);
    expect((await tts({ engine: "kitten", text: "hi", voice: "nope" })).status).toBe(400);
    expect((await tts({ engine: "kitten", text: "hi", voice: "bella" })).status).toBe(409);
  });

  it("streams Float32 chunks with the sample rate header", async () => {
    install("kitten");
    const res = await tts({ engine: "kitten", text: "hello", voice: "luna", speed: 9 });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-sample-rate")).toBe("24000");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(new Float32Array(buf.buffer))).toEqual([0.5, -0.5, 0.25]);
    const [, text, voice, speed] = speak.mock.calls[0]!;
    expect([text, (voice as { sid: number }).sid, speed]).toEqual(["hello", 3, 2]);
  });

  it("defaults to the first voice", async () => {
    install("kitten");
    await (await tts({ engine: "kitten", text: "hello" })).arrayBuffer();
    expect((speak.mock.calls[0]![2] as { id: string }).id).toBe("jasper");
  });

  it("hands the engine speakable text, and answers silence when none is left", async () => {
    install("kitten");
    await (await tts({ engine: "kitten", text: "Done 🎉 { ok }" })).arrayBuffer();
    expect(speak.mock.calls[0]![1]).toBe("Done ok");
    const res = await tts({ engine: "kitten", text: "🎉" });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("cancels a synthesis whose client hangs up before its first audio", async () => {
    install("kitten");
    const cancel = vi.fn();
    speak.mockImplementationOnce(() => ({ started: new Promise<number>(() => {}), done: new Promise<void>(() => {}), cancel }));
    const hangUp = new AbortController();
    void app.request("/tts", { method: "POST", body: JSON.stringify({ engine: "kitten", text: "queued" }), headers: { "content-type": "application/json" }, signal: hangUp.signal });
    await vi.waitFor(() => expect(speak).toHaveBeenCalled());
    expect(cancel).not.toHaveBeenCalled();
    hangUp.abort();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses a language the engine does not speak", async () => {
    const res = await tts({ engine: "kitten", text: "hola", lang: "es" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "language-not-supported" });
    expect(speak).not.toHaveBeenCalled();
  });

  it("speaks the asked language with the named voice if it can, else with the first voice that can", async () => {
    install("kokoro-multi-v1_0-int8");
    const voiceFor = async (body: object) => {
      await (await tts({ engine: "kokoro-multi-v1_0-int8", text: "hola", ...body })).arrayBuffer();
      return (speak.mock.calls.at(-1)![2] as { id: string }).id;
    };
    expect(await voiceFor({ lang: "es" })).toBe("ef_dora");
    expect(await voiceFor({ lang: "es", voice: "em_alex" })).toBe("em_alex");
    expect(await voiceFor({ lang: "es", voice: "af_heart" })).toBe("ef_dora");
    expect(await voiceFor({ voice: "bf_emma" })).toBe("bf_emma");
    expect((await tts({ engine: "kokoro-multi-v1_0-int8", text: "hola", lang: "es", voice: "nope" })).status).toBe(400);
  });

  it("leaves the cloned-voice path on the same route unchanged", async () => {
    const res = await tts({ text: "hi", profileId: "x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "model-not-installed" });
    expect(speak).not.toHaveBeenCalled();
  });
});
