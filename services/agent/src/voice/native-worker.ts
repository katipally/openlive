import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parentPort } from "node:worker_threads";
import { SAMPLE_RATE, fitSilence, limitPeak, splitAtPauses } from "./pcm.js";
import type { ModelType } from "./native-models.js";
import type { Provider } from "./device.js";
import { Supertonic, type Ort } from "@openlive/shared/speech/supertonic";
import { KEEP_S, trimSilence } from "@openlive/shared/speech/trim";
import { tokenOnsets } from "@openlive/shared/speech/timing";

// Worker thread that owns every native speech engine handle (native.ts spawns
// one for ASR and one for TTS). sherpa's streaming decode() is synchronous, so
// running it here keeps the agent's event loop, and its live sockets, free.
// A benchmark runs this same file as a short-lived child process instead, so a
// provider that crashes natively takes down only that child.
// Supertonic runs here too, on onnxruntime-node rather than sherpa, through
// the synthesis the browser runs (@openlive/shared/speech/supertonic), and so
// does the side talk check's sentence embedding model (addressee.ts).
// Every sherpa call that returns audio passes enableExternalBuffer false:
// Electron's V8 memory cage rejects external buffers ("External buffers are
// not allowed"), which only shows up in the packed app, not under plain Node.

type Wave = { samples: Float32Array; sampleRate: number };
type Stream = { acceptWaveform(w: Wave): void; inputFinished(): void; setOption(key: string, value: string): void };
// `timestamps`: each token's start (s), empty from an engine that times none;
// a streaming one counts from `start_time`, where its last reset left it.
type Result = { text: string; tokens: string[]; timestamps: number[]; start_time?: number };
type Online = { createStream(): Stream; isReady(s: Stream): boolean; decode(s: Stream): void; isEndpoint(s: Stream): boolean; reset(s: Stream): void; getResult(s: Stream): Result };
type Offline = { config: { modelConfig: { canary?: { srcLang: string; tgtLang: string } } }; setConfig(cfg: unknown): void; createStream(): Stream; decodeAsync(s: Stream): Promise<Result> };
type Tts = { sampleRate: number; generateAsync(req: unknown): Promise<Wave> };
type Extractor = { createStream(): Stream; compute(s: Stream, enableExternalBuffer: boolean): Float32Array };
type Sherpa = {
  OnlineRecognizer: new (cfg: unknown) => Online;
  OfflineRecognizer: { createAsync(cfg: unknown): Promise<Offline> };
  OfflineTts: { createAsync(cfg: unknown): Promise<Tts> };
  SpeakerEmbeddingExtractor: new (cfg: unknown) => Extractor;
  GenerationConfig: new (o: Record<string, unknown>) => unknown;
  readWave(path: string, enableExternalBuffer?: boolean): Wave;
};

/** A variant to load: its id keys the loaded handle; config is native-models.ts
 *  sherpaConfig, and `provider` the execution provider it names (accel.ts).
 *  `chunkMs`: a streaming model's chunk (native-models.ts latencyMs). */
export interface ModelRef { engine: string; type: ModelType; config: object; provider?: Provider; chunkMs?: number }
export type WorkerRequest =
  | ({ op: "stt"; id: number; samples: Float32Array; lang?: string } & ModelRef)
  // `voice` and `lang` are what a Supertonic render is told; sherpa's take `sid` and `espeak`.
  | ({ op: "tts"; id: number; text: string; speed: number; sid?: number; wav?: string; espeak?: string; voice?: string; lang?: string } & ModelRef)
  | ({ op: "open"; id: number; lang?: string } & ModelRef)
  // One speaker embedding of `samples` (voiceprint.ts), or one sentence embedding of `text` (addressee.ts).
  | ({ op: "embed"; id: number; samples?: Float32Array; text?: string } & ModelRef)
  // A fresh handle timed on a fixed input (accel.ts): `samples` for ASR, `text` for TTS and the addressee model.
  | ({ op: "bench"; id: number; samples?: Float32Array; text?: string; sid?: number; wav?: string; espeak?: string; voice?: string } & ModelRef)
  | { op: "audio"; id: number; samples: Float32Array }
  | { op: "end" | "reset" | "close"; id: number }
  | { op: "cancel"; id: number }
  | { op: "unload"; engine: string };

/** `at`: each captionWords(text) word's onset, ms from the first sample sent;
 *  absent when the engine times no tokens (moonshine, canary). */
export type Heard = { text: string; at?: number[] };
export type WorkerEvent =
  | { id: number; type: "done"; text?: string; at?: number[] }
  | { id: number; type: "start"; sampleRate: number }
  | { id: number; type: "chunk"; samples: Float32Array }
  | { id: number; type: "ready" | "closed" }
  | { id: number; type: "partial" | "final"; text: string; at?: number[] }
  | { id: number; type: "bench"; loadMs: number; warmMs: number; firstMs: number; rtf: number }
  | { id: number; type: "embedding"; embedding: Float32Array }
  | { id: number; type: "error"; message: string };

const IDLE_UNLOAD_MS = 5 * 60_000; // a loaded engine holds hundreds of MB
// Per worker, so per kind: Parakeet 0.6B v3 and Nemotron 3.5 loaded together
// held 3.3 GB resident (measured 2026-09-24).
const MAX_LOADED = 2;
// Half the slowest speaking rate measured per voice (pocket 16, kitten 10 chars/s):
// a synthesis running past 2 s plus this pace is a runaway, not speech.
const MIN_CHARS_PER_SEC: Record<string, number> = { pocket: 8, kitten: 5 };
// Model types that reach full scale (pcm.ts limitPeak). Measured 2026-09-24:
// kitten peaks at 1.08, piper es_ES-davefx at 0.994; kokoro, pocket and the
// other Piper voices stay under 0.84. Matcha clipped on 2 of the 14
// tools/voice-regress replies (measured 2026-09-25).
const PEAK_LIMITED = new Set<ModelType>(["kitten", "vits", "matcha"]);
// Seconds of silence kept before and after each sentence of these model
// types. Rendered apart, a Piper sentence ends with next to no silence or with
// a -55 dB hiss, by voice, so back to back they joined 17-186 ms apart where
// one render pauses 66-86 ms (measured 2026-09-25, tools/voice-regress, lessac,
// amy, ryan); fitted, they join 68-91 ms apart. Matcha: 107 ms vs 110 but
// uneven, 87 ms off per join, now 68.
const SENTENCE_EDGE_S: Partial<Record<ModelType, [lead: number, tail: number]>> = { vits: [0.01, 0.05], matcha: [0.01, 0.05] };
// sherpa decodes a nemotron chunk only once its whole window is buffered: the
// chunk plus 90 ms of pre-encode cache (the encoder's window_size metadata,
// e.g. 17 frames for 80 ms). So the audio's last partial chunk needs a chunk of
// silence behind it, plus this margin for the model to emit its last word; with
// the old fixed 0.5 s, 1120 ms variants dropped it ("...ten minutes" for "...ten
// minutes, please"). Nemotron 3.5 80 ms still cut "Sure" to "Su" at 0.38 s past
// the audio and not at 0.5 s (measured 2026-09-26), so the shortest chunk keeps
// the 0.5 s it had.
const TAIL_MARGIN_S = 0.42;
// A lone short word ("Sure") is often held back until well after it ends: the
// en models emitted it 1.3-1.8 s later, and an empty result gets that much more
// silence before it stands (measured 2026-09-26). A lone "No" the en models
// never emit, nor "Yeah" the 80 ms one; Nemotron 3.5 does.
const TAIL_MAX_S = 2;
const tailS = (chunkMs = 160) => chunkMs / 1000 + TAIL_MARGIN_S;
const silence = (s: number) => new Float32Array(Math.round(SAMPLE_RATE * s));
// Measured 2026-09-24: speech starting at sample 0 loses its first word on
// nemotron ("Hello there" -> "There"); 0.3 s of leading silence recovers it.
const LEAD_PADDING = new Float32Array(SAMPLE_RATE * 0.3);
const LEAD_MS = (1000 * LEAD_PADDING.length) / SAMPLE_RATE;

/** A streaming result's text and word onsets, from the start of the audio after
 *  LEAD_PADDING. An onset lands where the model emitted the word, which for a
 *  held-back word is in the tail padding and for the widest chunks can be
 *  before the audio starts, so each is kept within the `endMs` of audio heard. */
function streamed(res: Result, endMs = Infinity): Heard {
  const text = res.text.trim();
  const at = tokenOnsets(text, res.tokens, res.timestamps, 1000 * (res.start_time ?? 0) - LEAD_MS);
  return { text, at: at?.map((t) => Math.min(Math.max(t, 0), Math.round(endMs))) };
}

/** Ends a stream's input: a chunk's worth of silence and the margin, then as
 *  much again while `heard` is false, up to TAIL_MAX_S in all. Each step
 *  decodes what is ready. O(tail chunks). */
function finish(r: Online, s: Stream, chunkMs: number | undefined, heard: () => boolean) {
  const step = tailS(chunkMs);
  let fed = 0;
  do {
    s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: silence(step) });
    fed += step;
    while (r.isReady(s)) r.decode(s);
  } while (!heard() && fed + step <= TAIL_MAX_S);
  s.inputFinished();
  while (r.isReady(s)) r.decode(s);
}

/** `lang` pins a multilingual Nemotron to one language; English-only models ignore it. */
function freshStream(r: Online, lang?: string): Stream {
  const s = r.createStream();
  if (lang) s.setOption("language", lang);
  s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: LEAD_PADDING });
  return s;
}

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
const post = (e: WorkerEvent, transfer: ArrayBuffer[] = []) => (parentPort ? parentPort.postMessage(e, transfer) : process.send!(e));
// As a child process: the agent is gone (even SIGKILLed), so this benchmark is moot.
if (!parentPort) process.on("disconnect", () => process.exit());

// onnxruntime-node's names for the providers that differ from device.ts's.
const ORT_EP: Partial<Record<Provider, string>> = { directml: "dml" };

/** Loaded on first use, so a platform without its binary still runs sherpa's engines. */
function supertonic({ dir, provider, numThreads }: { dir: string; provider: Provider; numThreads: number }): Promise<Supertonic> {
  const ort = createRequire(import.meta.url)("onnxruntime-node") as Ort;
  return Supertonic.load(ort, { json: async (f) => JSON.parse(await readFile(join(dir, f), "utf8")), model: async (f) => join(dir, f) },
    { executionProviders: [ORT_EP[provider] ?? provider], intraOpNumThreads: numThreads, interOpNumThreads: 1, logSeverityLevel: 3 });
}

// Longer sentences are cut here: their start says who they are for, and the
// encoder's cost grows with the square of their length.
const MAX_TOKENS = 128;
type OrtTensor = { data: Float32Array };
type OrtSession = { run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>> };
type Sentences = (text: string) => Promise<Float32Array>;

/** The addressee model: the mean of its token states at unit length, the
 *  pooling it was trained with. Loaded on first use, like Supertonic. O(tokens^2 x d). */
async function sentences({ dir, provider, numThreads }: { dir: string; provider: Provider; numThreads: number }): Promise<Sentences> {
  const ort = createRequire(import.meta.url)("onnxruntime-node") as {
    Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
    InferenceSession: { create(path: string, opts: object): Promise<OrtSession> };
  };
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const json = async (f: string) => JSON.parse(await readFile(join(dir, f), "utf8")) as object;
  const tok = new Tokenizer(await json("tokenizer.json"), await json("tokenizer_config.json"));
  const session = await ort.InferenceSession.create(join(dir, "onnx/model_quantized.onnx"),
    { executionProviders: [ORT_EP[provider] ?? provider], intraOpNumThreads: numThreads, interOpNumThreads: 1, logSeverityLevel: 3 });
  return async (text) => {
    const ids = tok.encode(text).ids.slice(0, MAX_TOKENS), n = ids.length;
    const tensor = (a: number[]) => new ort.Tensor("int64", BigInt64Array.from(a, BigInt), [1, n]);
    const h = (await session.run({ input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)) })).last_hidden_state!.data;
    const d = h.length / n, e = new Float32Array(d);
    for (let t = 0; t < n; t++) for (let i = 0; i < d; i++) e[i]! += h[t * d + i]!;
    const norm = Math.hypot(...e) || 1;
    return e.map((x) => x / norm);
  };
}

async function create(op: WorkerRequest["op"], m: ModelRef): Promise<unknown> {
  if (m.type === "supertonic") return supertonic(m.config as Parameters<typeof supertonic>[0]);
  if (m.type === "addressee") return sentences(m.config as Parameters<typeof sentences>[0]);
  if (m.type === "speaker") return new sherpa.SpeakerEmbeddingExtractor(m.config);
  if (op === "tts") return sherpa.OfflineTts.createAsync(m.config);
  return m.type === "online-transducer" ? new sherpa.OnlineRecognizer(m.config) : sherpa.OfflineRecognizer.createAsync(m.config);
}

interface Loaded { handle: unknown; queue: Promise<unknown>; users: number; timer?: ReturnType<typeof setTimeout>; waves: Map<string, Wave> }
// Map order is recency order (a hit moves its entry to the end), so the first
// key without a live streaming session is the least recently used.
const loaded = new Map<string, Promise<Loaded>>();

// A dropped handle frees its native memory only once V8 collects it, and a JS
// heap this small seldom does: a dropped Parakeet 0.6B v3 held 650 MB until a
// forced gc() (measured 2026-09-24). Node exposes gc() only behind this flag.
const gc = (() => {
  try { setFlagsFromString("--expose-gc"); return runInNewContext("gc") as () => void; } catch { return () => {}; }
})();

/** Its idle timer would keep the handle reachable; the collection is deferred
 *  so the handle is off the stack by then. */
function drop(engine: string) {
  void loaded.get(engine)?.then((l) => clearTimeout(l.timer), () => {});
  loaded.delete(engine);
  setTimeout(gc);
}

/** Drops least recently used handles until one more fits. A handle still
 *  finishing a job lives until that job ends. O(loaded x sessions), both tiny. */
function makeRoom() {
  for (const engine of loaded.keys()) {
    if (loaded.size < MAX_LOADED) return;
    if (![...sessions.values()].some((ss) => ss.engine === engine)) drop(engine);
  }
}

function load(op: WorkerRequest["op"], m: ModelRef): Promise<Loaded> {
  let p = loaded.get(m.engine);
  if (p) loaded.delete(m.engine);
  else {
    makeRoom();
    const t = Date.now();
    p = create(op, m).then((handle) => {
      console.error(`[voice] ${m.engine} loaded in ${Date.now() - t}ms`);
      return { handle, queue: Promise.resolve(), users: 0, waves: new Map() };
    });
    p.catch(() => { if (loaded.get(m.engine) === p) loaded.delete(m.engine); });
  }
  loaded.set(m.engine, p);
  return p.then((l) => { touch(m.engine, l); return l; });
}

// Dropping the handle is enough: the addon frees native memory on GC.
function touch(engine: string, l: Loaded) {
  clearTimeout(l.timer);
  l.timer = setTimeout(() => {
    if (l.users) return touch(engine, l);
    // Only if still current: an unloaded handle's sessions keep touching it.
    void loaded.get(engine)?.then((cur) => { if (cur === l) drop(engine); }, () => {});
  }, IDLE_UNLOAD_MS);
}

/** One job at a time per engine handle. */
function serialize<T>(l: Loaded, job: () => Promise<T>): Promise<T> {
  const run = l.queue.then(job);
  l.queue = run.catch(() => {});
  return run;
}

async function transcribe(req: Extract<WorkerRequest, { op: "stt" }>): Promise<Heard> {
  const l = await load(req.op, req);
  return serialize(l, async () => {
    if (cancelled.has(req.id)) return { text: "" };
    if (req.type === "online-transducer") {
      const r = l.handle as Online;
      const s = freshStream(r, req.lang);
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: req.samples });
      finish(r, s, req.chunkMs, () => !!r.getResult(s).text.trim());
      return streamed(r.getResult(s), (1000 * req.samples.length) / SAMPLE_RATE);
    }
    const r = l.handle as Offline;
    const canary = r.config.modelConfig.canary;
    const lang = req.lang ?? "en";
    // Transcribes, not translates: the output language is the spoken one.
    if (canary && canary.srcLang !== lang) { canary.srcLang = canary.tgtLang = lang; r.setConfig(r.config); }
    const texts: string[] = [];
    let at: number[] | undefined = [];
    // Canary skipped two sentences of a 38 s clip (measured 2026-09-24); the
    // 8 s windows moonshine needs (pcm.ts) keep it whole.
    for (const samples of req.type === "moonshine" || req.type === "canary" ? splitAtPauses(req.samples) : [req.samples]) {
      if (cancelled.has(req.id)) break;
      const s = r.createStream();
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      const res = await r.decodeAsync(s), text = res.text.trim();
      texts.push(text);
      const piece = tokenOnsets(text, res.tokens, res.timestamps, (1000 * (samples.byteOffset - req.samples.byteOffset)) / samples.BYTES_PER_ELEMENT / SAMPLE_RATE);
      if (piece) at?.push(...piece); else at = undefined;
    }
    return { text: texts.filter(Boolean).join(" "), at };
  });
}

const cancelled = new Set<number>();

const embedding = (x: Extractor, samples: Float32Array) => {
  const s = x.createStream();
  s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  s.inputFinished();
  return x.compute(s, false);
};

async function embed(req: Extract<WorkerRequest, { op: "embed" }>): Promise<Float32Array> {
  const l = await load(req.op, req);
  return serialize(l, async () => req.type === "addressee" ? (l.handle as Sentences)(req.text!) : embedding(l.handle as Extractor, req.samples!));
}

type VoiceReq = { speed: number; sid?: number; wav?: string; espeak?: string };
/** A pocket voice clones its reference clip, read once per handle; the others pick a speaker. */
function generationConfig(v: VoiceReq, waves: Map<string, Wave>): Record<string, unknown> {
  if (!v.wav) return { sid: v.sid ?? 0, speed: v.speed, ...(v.espeak && { extra: { lang: v.espeak } }) };
  let ref = waves.get(v.wav);
  if (!ref) waves.set(v.wav, ref = sherpa.readWave(v.wav, false));
  // numSteps and the 12 s reference cap are the upstream pocket example's values.
  return { speed: v.speed, referenceAudio: ref.samples, referenceSampleRate: ref.sampleRate, numSteps: 5, extra: { max_reference_audio_len: 12 } };
}

async function speak(req: Extract<WorkerRequest, { op: "tts" }>): Promise<void> {
  const l = await load(req.op, req);
  await serialize(l, async () => {
    if (cancelled.has(req.id)) return;
    if (req.type === "supertonic") {
      // One render per sentence, cut as the browser worker cuts it (models.worker.ts).
      const s = l.handle as Supertonic;
      post({ id: req.id, type: "start", sampleRate: s.sampleRate });
      const wav = trimSilence(await s.synthesize(req.text, req.voice!, req.speed, req.lang ?? "en"), s.sampleRate, ...KEEP_S.supertonic);
      if (!cancelled.has(req.id)) post({ id: req.id, type: "chunk", samples: wav }, [wav.buffer as ArrayBuffer]);
      return;
    }
    const tts = l.handle as Tts;
    post({ id: req.id, type: "start", sampleRate: tts.sampleRate });
    // Pocket now and then babbles on for 3-10x its text, plain prose included
    // (measured 2026-09-24), and the chain would play all of it.
    let budget = (tts.sampleRate * (2 + req.text.length / (MIN_CHARS_PER_SEC[req.type] ?? 5))) / req.speed;
    await tts.generateAsync({
      text: req.text,
      enableExternalBuffer: false,
      generationConfig: new sherpa.GenerationConfig(generationConfig(req, l.waves)),
      onProgress: ({ samples }: { samples: Float32Array }) => {
        if (cancelled.has(req.id)) return 0;
        // kokoro-multi int8 now and then returns all-NaN audio (native-models.ts): play silence, not NaN.
        if (samples.some(Number.isNaN)) samples.fill(0);
        // Each progress call is one sentence (sherpaConfig's maxNumSentences 1).
        const edge = SENTENCE_EDGE_S[req.type];
        if (edge) samples = fitSilence(samples, tts.sampleRate, ...edge);
        post({ id: req.id, type: "chunk", samples: PEAK_LIMITED.has(req.type) ? limitPeak(samples) : samples });
        return (budget -= samples.length) > 0 ? 1 : 0;
      },
    });
  });
}

// ── benchmarks (accel.ts) ────────────────────────────────────────────────────
const BENCH_RUNS = 3; // steady-state runs after the warm-up one; the median is kept
const WORDS_PER_S = 2.5; // 150 words a minute, conversational speech

/** Load time, the first (warm-up) run, then the median of BENCH_RUNS: first
 *  audio chunk or clip transcribed (firstMs), and wall time over audio length (rtf). */
async function bench(req: Extract<WorkerRequest, { op: "bench" }>): Promise<Extract<WorkerEvent, { type: "bench" }>> {
  let t = performance.now();
  const handle = await create(req.text === undefined ? "stt" : "tts", req);
  const loadMs = performance.now() - t;
  const waves = new Map<string, Wave>();
  const once = async () => {
    const t0 = performance.now();
    let first: number | undefined, audioSec: number;
    if (req.type === "speaker") {
      embedding(handle as Extractor, req.samples!);
      audioSec = req.samples!.length / SAMPLE_RATE;
    } else if (req.type === "addressee") {
      await (handle as Sentences)(req.text!);
      audioSec = req.text!.split(/\s+/).length / WORDS_PER_S; // how long the sentence takes to say
    } else if (req.type === "supertonic") {
      const s = handle as Supertonic;
      audioSec = (await s.synthesize(req.text!, req.voice!)).length / s.sampleRate;
    } else if (req.text !== undefined) {
      const tts = handle as Tts;
      let n = 0;
      await tts.generateAsync({
        text: req.text, enableExternalBuffer: false, generationConfig: new sherpa.GenerationConfig(generationConfig({ ...req, speed: 1 }, waves)),
        onProgress: ({ samples }: { samples: Float32Array }) => { first ??= performance.now() - t0; n += samples.length; return 1; },
      });
      audioSec = n / tts.sampleRate;
    } else if (req.type === "online-transducer") {
      const r = handle as Online, s = freshStream(r);
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: req.samples! });
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: silence(tailS(req.chunkMs)) });
      s.inputFinished();
      while (r.isReady(s)) { r.decode(s); first ??= performance.now() - t0; }
      audioSec = req.samples!.length / SAMPLE_RATE;
    } else {
      const s = (handle as Offline).createStream();
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: req.samples! });
      await (handle as Offline).decodeAsync(s);
      audioSec = req.samples!.length / SAMPLE_RATE;
    }
    const total = performance.now() - t0;
    return { first: first ?? total, rtf: total / 1000 / audioSec };
  };
  t = performance.now();
  await once();
  const warmMs = performance.now() - t;
  const runs: Array<{ first: number; rtf: number }> = [];
  for (let i = 0; i < BENCH_RUNS; i++) runs.push(await once());
  const median = (k: "first" | "rtf") => runs.map((r) => r[k]).sort((a, b) => a - b)[BENCH_RUNS >> 1]!;
  return { id: req.id, type: "bench", loadMs: Math.round(loadMs), warmMs: Math.round(warmMs), firstMs: Math.round(median("first")), rtf: Number(median("rtf").toPrecision(3)) };
}

// ── streaming sessions (nemotron) ────────────────────────────────────────────
// `committedAt`: the onsets of `committed`'s words, undefined if any went untimed;
// `fed`: samples of audio since the stream was fresh.
interface Session { engine: string; lang?: string; chunkMs?: number; l: Loaded; r: Online; s: Stream; committed: string; committedAt?: number[]; last: string; fed: number }
const fresh = () => ({ committed: "", committedAt: [] as number[], last: "", fed: 0 });
const sessions = new Map<number, Session>();
// Sockets that closed while their engine was still loading.
const closedEarly = new Set<number>();

const joinText = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);
const joinAt = (a?: number[], b?: number[]) => a && b && [...a, ...b];

function decodeSession(id: number, ss: Session) {
  while (ss.r.isReady(ss.s)) ss.r.decode(ss.s);
  const res = ss.r.getResult(ss.s);
  const text = joinText(ss.committed, res.text.trim());
  if (ss.r.isEndpoint(ss.s)) {
    ss.committedAt = joinAt(ss.committedAt, streamed(res, (1000 * ss.fed) / SAMPLE_RATE).at);
    ss.committed = text;
    ss.r.reset(ss.s);
  }
  if (text !== ss.last) post({ id, type: "partial", text: ss.last = text });
}

async function open(req: Extract<WorkerRequest, { op: "open" }>) {
  const l = await load(req.op, req);
  const r = l.handle as Online;
  if (closedEarly.delete(req.id)) return post({ id: req.id, type: "closed" });
  l.users++;
  sessions.set(req.id, { engine: req.engine, lang: req.lang, chunkMs: req.chunkMs, l, r, s: freshStream(r, req.lang), ...fresh() });
  post({ id: req.id, type: "ready" });
}

function sessionOp(req: Extract<WorkerRequest, { op: "audio" | "end" | "reset" | "close" }>) {
  const ss = sessions.get(req.id);
  if (!ss) { if (req.op === "close") closedEarly.add(req.id); return; }
  touch(ss.engine, ss.l);
  if (req.op === "audio") {
    ss.s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: req.samples });
    ss.fed += req.samples.length;
    decodeSession(req.id, ss);
  } else if (req.op === "end") {
    finish(ss.r, ss.s, ss.chunkMs, () => !!(ss.committed || ss.r.getResult(ss.s).text.trim()));
    const tail = streamed(ss.r.getResult(ss.s), (1000 * ss.fed) / SAMPLE_RATE);
    post({ id: req.id, type: "final", text: joinText(ss.committed, tail.text), at: joinAt(ss.committedAt, tail.at) });
    Object.assign(ss, { s: freshStream(ss.r, ss.lang), ...fresh() }); // a finished stream takes no more input
  } else if (req.op === "reset") {
    Object.assign(ss, { s: freshStream(ss.r, ss.lang), ...fresh() });
  } else {
    sessions.delete(req.id);
    ss.l.users--;
    post({ id: req.id, type: "closed" });
  }
}

(parentPort ?? process).on("message", (req: WorkerRequest) => {
  const fail = (e: unknown) => post({ id: (req as { id: number }).id, type: "error", message: String((e as Error)?.message ?? e) });
  try {
    switch (req.op) {
      case "stt": transcribe(req).then((h) => { cancelled.delete(req.id); post({ id: req.id, type: "done", ...h }); }, (e) => { cancelled.delete(req.id); fail(e); }); break;
      case "tts": speak(req).then(() => { cancelled.delete(req.id); post({ id: req.id, type: "done" }); }, (e) => { cancelled.delete(req.id); fail(e); }); break;
      case "cancel": cancelled.add(req.id); break;
      case "embed": embed(req).then((e) => post({ id: req.id, type: "embedding", embedding: e }, [e.buffer as ArrayBuffer]), fail); break;
      case "bench": bench(req).then((e) => post(e), fail); break;
      case "open": open(req).catch((e) => { closedEarly.delete(req.id); fail(e); }); break;
      case "unload":
        drop(req.engine);
        break;
      default: sessionOp(req);
    }
  } catch (e) { fail(e); }
});
