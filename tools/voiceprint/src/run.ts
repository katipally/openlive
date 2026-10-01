// Voiceprint eval: how well each speaker embedding model tells the enrolled
// user from everyone else, at the windows the live gate decides on.
//   tsx src/run.ts [--models id,id] [--per 12] [--frr 0.01] [--json <file>]
// Users: the 40 LibriSpeech test-clean speakers (CC BY 4.0), each enrolled on
// ~15 s of their own clean reading, then tested on other utterances. Others:
// the other 39 speakers and the agent's own voices (the native TTS engines,
// rendered through the agent's worker). Every test utterance is also heard
// through a narrow quiet mic, an overdriven one, an echoey room, 4-talker
// babble, pink noise, and all of room, babble and mic at once (audio.ts).
// Embeddings go through the agent's worker (native-worker.ts "embed"), as the
// app computes them. Data and models download into the OS cache dir.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { cosine, fold, informative } from "../../../packages/shared/src/speech/voiceprint";
import type { WorkerEvent, WorkerRequest } from "../../../services/agent/src/voice/native-worker";
import { probeDevice, threadsFor } from "../../../services/agent/src/voice/device";
import { band, clip, mix, pink, rng, room, scale, windowOf } from "./audio";
import { eer, far, frr, quantile, thresholdAtFrr } from "./metrics";

const { values: args } = parseArgs({ options: { models: { type: "string" }, per: { type: "string" }, json: { type: "string" }, frr: { type: "string" } } });

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models";
// Every model sherpa-onnx publishes for English or multilingual speakers
// under a permissive license, with its sha256 (2026-09-26). Left out: the two
// 512-dim CAM++ exports (3dspeaker_speech_campplus_sv_en_voxceleb_16k,
// wespeaker_en_voxceleb_CAM++_LM), whose embedding of an utterance and of the
// same utterance 1 s later scored 0.56 and 0.37 on sherpa-onnx-node 1.13.8,
// and wespeaker_en_voxceleb_resnet34_LM (sha256 e9848563...), 36% EER on the
// whole utterances here where the others ran 0.8-3.8%: the WeSpeaker exports
// do not seem to get the features they were trained on through sherpa.
const MODELS: Record<string, { file: string; license: string; sha: string }> = {
  "campplus-zh-en": { file: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced", license: "Apache-2.0", sha: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2" },
  "eres2net-en": { file: "3dspeaker_speech_eres2net_sv_en_voxceleb_16k", license: "Apache-2.0", sha: "c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5" },
  "titanet-small": { file: "nemo_en_titanet_small", license: "CC-BY-4.0", sha: "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e" },
  "titanet-large": { file: "nemo_en_titanet_large", license: "CC-BY-4.0", sha: "d51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77" },
};
const LIBRISPEECH = "https://www.openslr.org/resources/12/test-clean.tar.gz";
const ENROLL_S = 15;
const PER = Number(args.per ?? 12); // test utterances per speaker
// Seconds of speech from its onset: a barge-in's first half second and second,
// a short turn, a longer one, and the whole utterance.
const WINDOWS = [0.5, 1, 2, 4, Infinity] as const;
const FRR_TARGET = Number(args.frr ?? 0.01);
const SR = 16000;
// The native voices the agent speaks with, a few per engine, from the voice-regress cache.
const TTS_VOICES: Record<string, string[]> = {
  "kokoro-multi-v1_0": ["af_heart", "af_bella", "am_adam", "am_michael", "bf_emma", "bm_george", "ef_dora", "ff_siwis", "hf_alpha", "if_sara", "pm_alex", "zf_xiaobei"],
  "kitten-nano-int8": ["jasper", "bella", "luna", "leo"],
  "piper-en_US-lessac-medium-int8": ["lessac"],
  "piper-en_US-ryan-medium-int8": ["ryan"],
  "piper-en_US-libritts_r-medium-int8": ["3922", "8699"],
  "matcha-en-ljspeech": ["ljspeech"],
};
const SENTENCES = [
  "Sure, I can help with that. Let me take a look at the file first.",
  "The build finished without errors, and all of the tests passed.",
  "I found three places where the function is called. Do you want me to update all of them?",
  "That's a good question. The short answer is yes, but there is a catch.",
  "Here is what I changed: the timeout is now thirty seconds instead of ten.",
  "I'm not sure what you mean. Could you say that again?",
];

const cache = process.env.VOICEPRINT_CACHE ?? join(
  process.platform === "darwin" ? join(homedir(), "Library", "Caches")
    : process.platform === "win32" ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "openlive-voiceprint");
const regressCache = join(cache, "..", "openlive-voice-regress");
mkdirSync(join(cache, "models"), { recursive: true });

function download(url: string, dest: string) {
  const r = spawnSync("curl", ["-sSLf", "-o", `${dest}.part`, url], { stdio: "inherit" });
  if (r.status) throw new Error(`${url}: curl exited ${r.status}`);
  renameSync(`${dest}.part`, dest);
}
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Any audio file, or raw Float32 at `rate`, as 16 kHz mono Float32 (ffmpeg). */
function decode(input: string | { pcm: Float32Array; rate: number }): Float32Array {
  const src = typeof input === "string" ? ["-i", input] : ["-f", "f32le", "-ar", String(input.rate), "-ac", "1", "-i", "pipe:0"];
  const out = execFileSync("ffmpeg", ["-v", "error", ...src, "-f", "f32le", "-ac", "1", "-ar", String(SR), "pipe:1"],
    { input: typeof input === "string" ? undefined : Buffer.from(input.pcm.buffer, input.pcm.byteOffset, input.pcm.byteLength), maxBuffer: 1 << 30 });
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4).slice();
}
const concat = (xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((n, x) => n + x.length, 0)); xs.reduce((at, x) => (o.set(x, at), at + x.length), 0); return o; };

// ── data ─────────────────────────────────────────────────────────────────────
const ls = join(cache, "LibriSpeech", "test-clean");
if (!existsSync(ls)) {
  console.log("downloading LibriSpeech test-clean (347 MB)...");
  download(LIBRISPEECH, join(cache, "test-clean.tar.gz"));
  execFileSync("tar", ["xzf", join(cache, "test-clean.tar.gz"), "-C", cache]);
}
interface Item { spk: number; audio: Float32Array; tts?: string }
const speakers = readdirSync(ls).filter((d) => /^\d+$/.test(d)).sort();
const enroll: Float32Array[][] = [];
const tests: Item[] = [];
speakers.forEach((spk, si) => {
  const files = readdirSync(join(ls, spk)).sort().flatMap((ch) => readdirSync(join(ls, spk, ch)).filter((f) => f.endsWith(".flac")).sort().map((f) => join(ls, spk, ch, f)));
  const mine: Float32Array[] = [];
  let i = 0, secs = 0;
  for (; i < files.length && secs < ENROLL_S; i++) { const a = decode(files[i]!); mine.push(a); secs += a.length / SR; }
  enroll.push(mine);
  for (let n = 0; i < files.length && n < PER; i++) {
    const a = decode(files[i]!);
    if (a.length >= 2 * SR) { tests.push({ spk: si, audio: a }); n++; }
  }
});
console.log(`${speakers.length} speakers, ${tests.length} test utterances`);

// ── the agent's voices, as others ────────────────────────────────────────────
const ttsDir = join(cache, "tts");
mkdirSync(ttsDir, { recursive: true });
process.env.OPENLIVE_HOME = join(regressCache, "sherpa");
const m = await import("../../../services/agent/src/voice/native-models");
const worker = new Worker(new URL("../../../services/agent/src/voice/native-worker.ts", import.meta.url));
let nextId = 0;
function call<T>(req: WorkerRequest, pick: (ev: WorkerEvent, done: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const on = (ev: WorkerEvent) => {
      if (ev.id !== (req as { id: number }).id) return;
      const done = (v: T) => { worker.off("message", on); resolve(v); };
      if (ev.type === "error") { worker.off("message", on); reject(new Error(ev.message)); } else pick(ev, done);
    };
    worker.on("message", on);
    worker.postMessage(req);
  });
}
for (const [variant, voices] of Object.entries(TTS_VOICES)) {
  const e = m.nativeEngine(variant)!;
  if (!m.engineInstalled(e)) { console.log(`skipping ${variant}: not in ${process.env.OPENLIVE_HOME} (pnpm voice:regress downloads it)`); continue; }
  for (const id of voices) {
    const v = e.voices!.find((x) => x.id === id)!;
    for (const [si, text] of SENTENCES.entries()) {
      const file = join(ttsDir, `${variant}-${id}-${si}.f32`);
      if (!existsSync(file)) {
        let rate = 0;
        const parts: Float32Array[] = [];
        await call<void>({ op: "tts", id: ++nextId, engine: e.id, type: e.type, provider: "cpu", config: m.sherpaConfig(e, { provider: "cpu", numThreads: 2 }),
          text, speed: 1, sid: v.sid, espeak: v.espeak, voice: v.id, lang: "en" }, (ev, done) => {
          if (ev.type === "start") rate = ev.sampleRate;
          else if (ev.type === "chunk") parts.push(ev.samples);
          else if (ev.type === "done") done();
        });
        const pcm = decode({ pcm: concat(parts), rate });
        writeFileSync(file, Buffer.from(pcm.buffer));
      }
      const b = readFileSync(file);
      tests.push({ spk: -1, audio: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice(), tts: `${variant}/${id}` });
    }
    worker.postMessage({ op: "unload", engine: e.id } satisfies WorkerRequest);
  }
}
console.log(`${tests.filter((t) => t.tts).length} utterances in the agent's voices`);

// ── conditions ───────────────────────────────────────────────────────────────
/** 4 other speakers talking over each other, from the test set, never the item's own. */
function babble(item: Item, rand: () => number): Float32Array {
  const out = new Float32Array(item.audio.length);
  for (let k = 0; k < 4; k++) {
    let o: Item;
    do o = tests[Math.floor(rand() * tests.length)]!; while (o.spk === item.spk || o.tts);
    const at = Math.floor(rand() * o.audio.length);
    for (let i = 0; i < out.length; i++) out[i]! += o.audio[(at + i) % o.audio.length]!;
  }
  return out;
}
const CONDITIONS: Record<string, (x: Float32Array, item: Item, rand: () => number) => Float32Array> = {
  clean: (x) => x,
  "quiet narrow mic": (x) => scale(band(x), 0.05),
  "overdriven mic": (x) => clip(scale(x, 8)),
  "echoey room": (x) => room(x),
  "babble 5 dB": (x, it, r) => mix(x, babble(it, r), 5),
  "pink noise 5 dB": (x, _, r) => mix(x, pink(x.length, r), 5),
  "room+babble+mic": (x, it, r) => scale(band(mix(room(x), babble(it, r), 10)), 0.1),
};
const conds = Object.keys(CONDITIONS);

// ── scoring ──────────────────────────────────────────────────────────────────
const device = await probeDevice();
const numThreads = threadsFor(device);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`.padStart(6);
const report: Record<string, unknown> = {};
const summary: string[] = [];
for (const id of args.models?.split(",") ?? Object.keys(MODELS)) {
  const spec = MODELS[id];
  if (!spec) throw new Error(`unknown model ${id}; one of ${Object.keys(MODELS).join(", ")}`);
  const path = join(cache, "models", `${spec.file}.onnx`);
  if (!existsSync(path)) download(`${RELEASE}/${spec.file}.onnx`, path);
  if (sha256(path) !== spec.sha) throw new Error(`${path}: sha256 mismatch`);
  const ref = { engine: id, type: "speaker" as const, provider: "cpu" as const, config: { model: path, numThreads, provider: "cpu", debug: 0 } };
  const ms: Record<string, number[]> = {};
  let blank = 0; // embeddings that say nothing (informative()): the app gives no verdict on them
  const embed = async (x: Float32Array, timed?: string) => {
    const t0 = performance.now();
    const e = await call<Float32Array>({ op: "embed", id: ++nextId, ...ref, samples: x }, (ev, done) => { if (ev.type === "embedding") done(ev.embedding); });
    if (timed) (ms[timed] ??= []).push(performance.now() - t0);
    if (!informative(e)) blank++;
    return e;
  };
  await embed(new Float32Array(SR)); // load
  const prints: number[][] = [];
  for (const utts of enroll) {
    let p = { mean: [] as number[], n: 0 };
    for (const u of utts) p = { mean: fold(p, await embed(u)), n: p.n + 1 };
    prints.push(p.mean);
  }
  // scores[window][condition] = { tar, imp, tts }
  const scores = WINDOWS.map(() => conds.map(() => ({ tar: [] as number[], imp: [] as number[], tts: [] as number[] })));
  for (const [ci, c] of conds.entries()) {
    for (const [ti, t] of tests.entries()) {
      const x = CONDITIONS[c]!(t.audio, t, rng(ci * 100_003 + ti)); // made here, not held: all of them would take ~2 GB
      for (const [wi, w] of WINDOWS.entries()) {
        const e = await embed(windowOf(x, w), String(w));
        const s = scores[wi]![ci]!;
        prints.forEach((p, pi) => {
          const v = cosine(p, e);
          if (pi === t.spk) s.tar.push(v); else if (t.tts) s.tts.push(v); else s.imp.push(v);
        });
      }
    }
  }
  worker.postMessage({ op: "unload", engine: id } satisfies WorkerRequest);
  const pool = (wi: number, k: "tar" | "imp" | "tts") => scores[wi]!.flatMap((s) => s[k]);
  // Each window's operating point, pooled over every condition: the highest
  // threshold that blocks at most FRR_TARGET of the user's trials.
  console.log(`\n${id} (${spec.license}), ${numThreads} threads; thresholds block at most ${pct(FRR_TARGET).trim()} of the user's trials per window, pooled`);
  console.log(`${"window / condition".padEnd(28)}${"EER".padStart(7)}${"thresh".padStart(8)}${"FRR".padStart(7)}${"FAR".padStart(7)}${"FAR tts".padStart(8)}${"user p50".padStart(9)}`);
  const rows: Record<string, unknown> = {};
  for (const [wi, w] of WINDOWS.entries()) {
    const label = Number.isFinite(w) ? `${w} s` : "full";
    const t = thresholdAtFrr(pool(wi, "tar"), FRR_TARGET);
    const row = (tar: number[], imp: number[], tts: number[]) => ({ eer: eer(tar, [...imp, ...tts]).eer, threshold: t, frr: frr(tar, t), far: far(imp, t), farTts: far(tts, t), userMedian: quantile(tar, 0.5) });
    const line = (name: string, r: ReturnType<typeof row>) => `${name.padEnd(28)}${pct(r.eer)}${r.threshold.toFixed(3).padStart(8)}${pct(r.frr)}${pct(r.far)}${pct(r.farTts).padStart(8)}${r.userMedian.toFixed(3).padStart(8)}`;
    const all = row(pool(wi, "tar"), pool(wi, "imp"), pool(wi, "tts"));
    const conditions = Object.fromEntries(conds.map((c, ci) => [c, row(scores[wi]![ci]!.tar, scores[wi]![ci]!.imp, scores[wi]![ci]!.tts)]));
    rows[label] = { ...all, conditions };
    console.log(line(label, all));
    for (const [c, r] of Object.entries(conditions)) console.log(`  ${line(c, r).slice(0, 26)}${line(c, r).slice(28)}`);
    summary.push(`${`${id} ${label}`.padEnd(30)}${line("", all).slice(28)}${(ms[String(w)] ? quantile(ms[String(w)]!, 0.95) : NaN).toFixed(1).padStart(8)}`);
  }
  const lat = Object.fromEntries(Object.entries(ms).map(([w, xs]) => [w, { p50: quantile(xs, 0.5), p95: quantile(xs, 0.95) }]));
  console.log(`extraction ms (worker round trip, p50/p95): ${Object.entries(lat).map(([w, l]) => `${w === "Infinity" ? "full" : `${w} s`} ${l.p50.toFixed(1)}/${l.p95.toFixed(1)}`).join(", ")}; zero or non-finite embeddings: ${blank}`);
  report[id] = { license: spec.license, windows: rows, latencyMs: lat, blank };
}
console.log(`\n${"model window".padEnd(30)}${"EER".padStart(7)}${"thresh".padStart(8)}${"FRR".padStart(7)}${"FAR".padStart(7)}${"FAR tts".padStart(8)}${"user p50".padStart(9)}${"p95 ms".padStart(8)}`);
for (const s of summary) console.log(s);
if (args.json) writeFileSync(args.json, JSON.stringify({ date: new Date().toISOString(), device: device.cpu, numThreads, speakers: speakers.length, tests: tests.length, report }, null, 2));
await worker.terminate();
