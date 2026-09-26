// Each voice engine as the app runs it, fed one text at a time. Native engines
// go through the agent's own worker (native-worker.ts: NaN guard, peak limit,
// runaway budget) with the catalog's sherpa config and the route's speakable();
// browser engines through the same classes and trimSilence/KEEP_S as
// models.worker.ts. Models download on first use into the cache dir and are
// checked against pinned SHA-256 sums on every run.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { KEEP_S, trimSilence } from "../../../packages/shared/src/speech/trim";
import { familyInfo } from "../../../apps/web/src/lib/live/pipelineConfig";
import type { WorkerEvent, WorkerRequest } from "../../../services/agent/src/voice/native-worker";

export interface Synth { sampleRate: number; say(text: string, whole: boolean): Promise<Float32Array>; close(): Promise<void> }
/** `tier`: pr runs on every voice PR, nightly on schedule, local only when
 *  named (its license keeps it out of CI). `slack` widens the drift allowance
 *  for an engine whose output moves between runs. `limits` raises a metric's
 *  absolute threshold (run.ts METRICS) for an engine whose one-go render is
 *  measurably unlike its sentences rendered apart. `renders` renders the
 *  corpus that many times at once, the metrics pooled over them, for an
 *  engine whose output moves between runs by more than a gate can absorb;
 *  `drift` then sets a metric's allowance past its (itself noisy) baseline. */
export interface Engine {
  id: string; license: string; tier: "pr" | "nightly" | "local"; slack: number; limits?: Record<string, number>; renders?: number; drift?: Record<string, number>;
  open(cache: string): Promise<Synth>;
}

/** VOICE_REGRESS_CACHE, else the OS cache dir: never the repo, never the app's data. */
export function cacheDir(): string {
  if (process.env.VOICE_REGRESS_CACHE) return process.env.VOICE_REGRESS_CACHE;
  const base = process.platform === "darwin" ? join(homedir(), "Library", "Caches")
    : process.platform === "win32" ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "openlive-voice-regress");
}

const sha256 = (path: string) => new Promise<string>((resolve, reject) => {
  const h = createHash("sha256");
  createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});

/** Every pinned file of `dir` matches its sum. A mismatch removes the dir, so
 *  the next run downloads it again. */
async function verify(dir: string, sums: Record<string, string>): Promise<void> {
  for (const [file, sum] of Object.entries(sums)) {
    const got = await sha256(join(dir, file));
    if (got !== sum) { rmSync(dir, { recursive: true, force: true }); throw new Error(`${join(dir, file)}: sha256 ${got}, expected ${sum}; removed, the next run downloads it again`); }
  }
}

/** `base`/<path> for each pinned file missing from `dir`, hashed as it streams in. */
async function fetchPinned(base: string, dir: string, sums: Record<string, string>): Promise<void> {
  for (const [file, sum] of Object.entries(sums)) {
    const dest = join(dir, file);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    const res = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`${base}/${file}: HTTP ${res.status}`);
    const h = createHash("sha256");
    await pipeline(Readable.fromWeb(res.body as never), new Transform({ transform(c, _, cb) { h.update(c); cb(null, c); } }), createWriteStream(`${dest}.part`));
    const got = h.digest("hex");
    if (got !== sum) { rmSync(`${dest}.part`); throw new Error(`${base}/${file}: sha256 ${got}, expected ${sum}`); }
    renameSync(`${dest}.part`, dest);
  }
}

/** A native (sherpa-onnx) variant of the agent's catalog, by id, with the sums of its files. */
function native(id: string, variant: string, family: string, license: string, tier: Engine["tier"], slack: number, sums: Record<string, string>, limits?: Engine["limits"]): Engine {
  return {
    id, license, tier, slack, limits,
    async open(cache) {
      // The agent's catalog places engines under DATA_DIR, read once when @openlive/db loads.
      process.env.OPENLIVE_DATA_DIR = join(cache, "sherpa");
      const m = await import("../../../services/agent/src/voice/native-models");
      const e = m.nativeEngine(variant)!;
      if (!m.engineInstalled(e)) await m.downloadEngine(e, () => {}, AbortSignal.timeout(15 * 60_000));
      await verify(m.engineDir(e.id), sums);
      const named = familyInfo("tts", family)?.defaultVoice;
      const voice = e.voices!.find((v) => v.id === named) ?? e.voices!.find((v) => v.lang === "en")!; // routes.ts nativeTts
      // One thread on every machine, so runs differ only by the model's own noise.
      const config = m.sherpaConfig(e, { provider: "cpu", numThreads: 1 });
      const worker = new Worker(new URL("../../../services/agent/src/voice/native-worker.ts", import.meta.url));
      let next = 0, sampleRate = 0;
      const run = (text: string, whole: boolean) => new Promise<Float32Array[]>((resolve, reject) => {
        const id = ++next, parts: Float32Array[] = [];
        const on = (ev: WorkerEvent) => {
          if (ev.id !== id) return;
          if (ev.type === "start") sampleRate = ev.sampleRate;
          else if (ev.type === "chunk") parts.push(ev.samples);
          else if (ev.type === "done" || ev.type === "error") {
            worker.off("message", on);
            if (ev.type === "done") resolve(parts); else reject(new Error(ev.message));
          }
        };
        worker.on("message", on);
        // The one-go reference is its own handle that keeps the reply in one piece
        // (sherpa splits at every sentence under the catalog's maxNumSentences 1).
        // Kitten ignores the setting and always splits, so its reference is
        // sherpa's own sentence split: it guards where the chunker cuts.
        worker.postMessage({
          op: "tts", id, engine: whole ? `${e.id}#whole` : e.id, type: e.type, provider: "cpu",
          config: whole ? { ...config, maxNumSentences: 1000 } : config,
          text: m.speakable(text), speed: 1, sid: voice.sid, espeak: voice.espeak, voice: voice.id, lang: "en",
        } satisfies WorkerRequest);
      });
      return {
        get sampleRate() { return sampleRate; },
        say: async (text, whole) => {
          const parts = await run(text, whole);
          const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
          parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
          return out;
        },
        close: async () => { await worker.terminate(); },
      };
    },
  };
}

const webRequire = createRequire(new URL("../../../apps/web/package.json", import.meta.url));

// In-browser Kokoro (models.worker.ts ensureKokoro): the q8 build the WASM tier loads.
const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_REV = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const kokoroJs: Engine = {
  id: "kokoro-js", license: "Apache-2.0", tier: "pr", slack: 1,
  // One render of a whole reply carries its pitch down across the sentences;
  // each sentence rendered alone starts over (measured 2026-09-25: 1.66 st
  // mean pitch step off one-go, 55% of joins rough). Drift still guards it.
  limits: { f0JumpSt: 2.2, roughJoins: 0.7 },
  async open(cache) {
    const dir = join(cache, "hf", KOKORO_REPO);
    const sums = {
      "config.json": "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
      "tokenizer.json": "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
      "tokenizer_config.json": "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
      "onnx/model_quantized.onnx": "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
    };
    await fetchPinned(`https://huggingface.co/${KOKORO_REPO}/resolve/${KOKORO_REV}`, dir, sums);
    await verify(dir, sums);
    // kokoro-js and the transformers.js copy it loads, resolved as the web app resolves them.
    const kokoroPath = webRequire.resolve("kokoro-js");
    const { env } = createRequire(kokoroPath)("@huggingface/transformers");
    env.localModelPath = join(cache, "hf");
    env.allowRemoteModels = false;
    const { KokoroTTS } = webRequire("kokoro-js");
    const tts = await KokoroTTS.from_pretrained(KOKORO_REPO, { dtype: "q8", device: "cpu" });
    const voice = familyInfo("tts", "kokoro")!.defaultVoice!;
    let sampleRate = 24000;
    return {
      get sampleRate() { return sampleRate; },
      say: async (text) => {
        const a = await tts.generate(text, { voice, speed: 1 });
        sampleRate = a.sampling_rate;
        return trimSilence(a.audio, sampleRate, ...KEEP_S.kokoro);
      },
      close: async () => {},
    };
  },
};

// Supertonic (models.worker.ts ensureSupertonic) on onnxruntime-web, as in the
// browser. Its fetches go through the Cache API, stood in for here by the
// pinned files on disk, so the app's class loads them unchanged.
const SUPERTONIC_REPO = "https://huggingface.co/Supertone/supertonic-3/resolve";
const SUPERTONIC_REV = "3cadd1ee6394adea1bd021217a0e650ede09a323";
// As kokoro-js, more so (measured 2026-09-25: 3.7 st pitch steps, 2.5 st
// start pitch, 83% of joins rough).
const SUPERTONIC_LIMITS = { f0JumpSt: 4.5, startPitchSt: 3, roughJoins: 0.95 };
const SUPERTONIC_SUMS: Record<string, string> = {
  "onnx/duration_predictor.onnx": "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db",
  "onnx/text_encoder.onnx": "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff",
  "onnx/vector_estimator.onnx": "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c",
  "onnx/vocoder.onnx": "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba",
  "onnx/tts.json": "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09",
  "onnx/unicode_indexer.json": "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f",
  "voice_styles/M1.json": "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b", // familyInfo("tts", "supertonic").defaultVoice
};
const supertonic: Engine = {
  id: "supertonic", license: "OpenRAIL-M", tier: "local", slack: 1, limits: SUPERTONIC_LIMITS,
  async open(cache) {
    const dir = join(cache, "supertonic", SUPERTONIC_REV);
    const voice = familyInfo("tts", "supertonic")!.defaultVoice!;
    const sums = SUPERTONIC_SUMS;
    await fetchPinned(`${SUPERTONIC_REPO}/${SUPERTONIC_REV}`, dir, sums);
    await verify(dir, sums);
    const file = (url: string) => join(dir, url.split("/resolve/main/")[1] ?? "");
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({ match: async (url: string) => (existsSync(file(url)) ? new Response(readFileSync(file(url))) : undefined), put: async () => {} }),
    };
    const { loadSupertonic } = await import("../../../apps/web/src/lib/live/supertonic");
    const s = await loadSupertonic("wasm");
    return {
      sampleRate: s.sampleRate,
      say: async (text) => trimSilence(await s.synthesize(text, voice, 1, "en"), s.sampleRate, ...KEEP_S.supertonic),
      close: async () => {},
    };
  },
};

export const ENGINES: Engine[] = [
  // sherpa's native engines draw fresh noise on every call and expose no seed
  // (Piper and Matcha too): the same text renders a little differently each
  // time (measured 2026-09-25), hence the wider drift allowance.
  // Measured 2026-09-25 over 13 runs of one render: 1-3 rough joins of 29
  // (0.034-0.103), 2 runs past the 0.1 gate. Joins 5, 7, 9 and 10 were ever
  // rough (in 100%, 40%, 10% and 10% of runs), so three renders pooled pass
  // 0.13 but for about 1 run in 40,000 even if every other join turned rough
  // 1 time in 200; a pooled baseline lands anywhere in about 0.03-0.09, hence the
  // drift allowance that leaves 0.13 the gate. The old comma-cut first chunk
  // has 5 joins rough in every run, 5-6 of 30 in all (0.167-0.2), so it fails
  // 0.13 in every pooling.
  {
    ...native("kitten", "kitten-nano-int8", "kitten", "Apache-2.0", "pr", 1.5, {
      "model.int8.onnx": "0ba1e21eda9c8bcc4a70ada7e0d27fefc9ba775aaa037547248ec71f9a3d9b7d",
      "voices.bin": "d520519c4a3519d44fcfcd943ed0b1e3c5da5cee0eea501d922fac1a93cd24dc",
      "tokens.txt": "934a4188addc7665dd3410256bb622169242357fbb99d840d9351209b486dabb",
    }, { roughJoins: 0.13 }),
    renders: 3, drift: { roughJoins: 0.1 },
  },
  native("kokoro-native", "kokoro-multi-v1_0", "kokoro-native", "Apache-2.0", "nightly", 1.5, {
    "model.onnx": "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11",
    "voices.bin": "1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29",
    "tokens.txt": "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425",
  }),
  // The app's default Piper voice. Its dataset license (Blizzard 2013,
  // non-commercial) keeps it out of CI. Piper and Matcha start each
  // sentence rendered alone over, as kokoro-js does, and move more from run to
  // run than Kitten (measured 2026-09-25 over 3 runs: pitch steps 3.1-3.5
  // and 4.4-4.6 st off one-go, Matcha's loudness steps 4.2-4.7 dB).
  native("piper-lessac", "piper-en_US-lessac-medium-int8", "piper", "Blizzard 2013 Lessac", "local", 2.5, {
    "en_US-lessac-medium.onnx": "96a843df9c4da007e0fc224816cc6020fdc3482b47cb2684b8aab11fec8385ca",
    "tokens.txt": "87c8ef66eae5473ed0cc0366b3964c736ca6c5f676c979522ea31234e47430b9",
  }, { f0JumpSt: 4.5, loudJumpDb: 3.5, startPitchSt: 2.8, roughJoins: 1 }),
  native("matcha", "matcha-en-ljspeech", "matcha", "Apache-2.0", "nightly", 2, {
    "model-steps-3.onnx": "4d7771c0ec063ca74f2fa92ba0ecfe14f73fa3f61c236d9469b92e102d8e9574",
    "vocos-22khz-univ.onnx": "0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081",
    "tokens.txt": "bcb4a50830e9402112fe8cb57d53ae8523908868a5015f2040dde5f5fd231697",
  }, { f0JumpSt: 5.5, loudJumpDb: 6, startPitchSt: 3.5, roughJoins: 1 }),
  kokoroJs,
  supertonic,
  // The same Supertonic as the agent runs it on this computer (native-worker.ts,
  // onnxruntime-node): its metrics should match the browser's above.
  native("supertonic-agent", "supertonic-3", "supertonic", "OpenRAIL-M", "local", 1, SUPERTONIC_SUMS, SUPERTONIC_LIMITS),
];
