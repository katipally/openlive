import { createRequire } from "node:module";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import { SAMPLE_RATE, limitPeak, splitAtPauses } from "./pcm.js";

// Worker thread that owns every native speech engine handle (native.ts spawns
// one for ASR and one for TTS). sherpa's streaming decode() is synchronous, so
// running it here keeps the agent's event loop, and its live sockets, free.
// Every sherpa call that returns audio passes enableExternalBuffer false:
// Electron's V8 memory cage rejects external buffers ("External buffers are
// not allowed"), which only shows up in the packed app, not under plain Node.

type Wave = { samples: Float32Array; sampleRate: number };
type Stream = { acceptWaveform(w: Wave): void; inputFinished(): void };
type Online = { createStream(): Stream; isReady(s: Stream): boolean; decode(s: Stream): void; isEndpoint(s: Stream): boolean; reset(s: Stream): void; getResult(s: Stream): { text: string } };
type Offline = { createStream(): Stream; decodeAsync(s: Stream): Promise<{ text: string }> };
type Tts = { sampleRate: number; generateAsync(req: unknown): Promise<Wave> };
type Sherpa = {
  OnlineRecognizer: new (cfg: unknown) => Online;
  OfflineRecognizer: { createAsync(cfg: unknown): Promise<Offline> };
  OfflineTts: { createAsync(cfg: unknown): Promise<Tts> };
  GenerationConfig: new (o: Record<string, unknown>) => unknown;
  readWave(path: string, enableExternalBuffer?: boolean): Wave;
};

export type WorkerRequest =
  | { op: "stt"; id: number; engine: string; dir: string; samples: Float32Array }
  | { op: "tts"; id: number; engine: string; dir: string; text: string; speed: number; sid?: number; wav?: string }
  | { op: "open"; id: number; engine: string; dir: string }
  | { op: "audio"; id: number; samples: Float32Array }
  | { op: "end" | "reset" | "close"; id: number }
  | { op: "cancel"; id: number }
  | { op: "unload"; engine: string };

export type WorkerEvent =
  | { id: number; type: "done"; text?: string }
  | { id: number; type: "start"; sampleRate: number }
  | { id: number; type: "chunk"; samples: Float32Array }
  | { id: number; type: "ready" | "closed" }
  | { id: number; type: "partial" | "final"; text: string }
  | { id: number; type: "error"; message: string };

const IDLE_UNLOAD_MS = 5 * 60_000; // a loaded engine holds hundreds of MB
// Half the slowest speaking rate measured per voice (pocket 16, kitten 10 chars/s):
// a synthesis running past 2 s plus this pace is a runaway, not speech.
const MIN_CHARS_PER_SEC: Record<string, number> = { pocket: 8, kitten: 5 };
// Upstream nemotron example pads 0.4 s so the last 160 ms chunk flushes; 0.5 s leaves margin.
const TAIL_PADDING = new Float32Array(SAMPLE_RATE / 2);
// Measured 2026-09-24: speech starting at sample 0 loses its first word on
// nemotron ("Hello there" -> "There"); 0.3 s of leading silence recovers it.
const LEAD_PADDING = new Float32Array(SAMPLE_RATE * 0.3);

function freshStream(r: Online): Stream {
  const s = r.createStream();
  s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: LEAD_PADDING });
  return s;
}

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
const port = parentPort!;
const post = (e: WorkerEvent, transfer: ArrayBuffer[] = []) => port.postMessage(e, transfer);

const transducer = (dir: string) => ({
  encoder: join(dir, "encoder.int8.onnx"), decoder: join(dir, "decoder.int8.onnx"), joiner: join(dir, "joiner.int8.onnx"),
});

async function create(engine: string, dir: string): Promise<unknown> {
  const tokens = join(dir, "tokens.txt");
  switch (engine) {
    case "nemotron": return new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
      modelConfig: { transducer: transducer(dir), tokens, numThreads: 2 },
      // Endpoints only bound how much audio one stream holds: the text is
      // committed and the stream reset, and "end" still decides the final.
      enableEndpoint: true, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20,
    });
    case "parakeet": return sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: { transducer: transducer(dir), tokens, modelType: "nemo_transducer", numThreads: 2 },
    });
    case "moonshine": return sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: { moonshine: { encoder: join(dir, "encoder_model.ort"), mergedDecoder: join(dir, "decoder_model_merged.ort") }, tokens, numThreads: 2 },
    });
    case "pocket": return sherpa.OfflineTts.createAsync({
      model: {
        pocket: {
          lmFlow: join(dir, "lm_flow.int8.onnx"), lmMain: join(dir, "lm_main.int8.onnx"), encoder: join(dir, "encoder.onnx"),
          decoder: join(dir, "decoder.int8.onnx"), textConditioner: join(dir, "text_conditioner.onnx"),
          vocabJson: join(dir, "vocab.json"), tokenScoresJson: join(dir, "token_scores.json"), voiceEmbeddingCacheCapacity: 8,
        },
        numThreads: 2,
      },
      maxNumSentences: 1,
    });
    case "kitten": return sherpa.OfflineTts.createAsync({
      model: { kitten: { model: join(dir, "model.int8.onnx"), voices: join(dir, "voices.bin"), tokens, dataDir: join(dir, "espeak-ng-data") }, numThreads: 2 },
      maxNumSentences: 1,
    });
  }
  throw new Error(`unknown engine ${engine}`);
}

interface Loaded { handle: unknown; queue: Promise<unknown>; users: number; timer?: ReturnType<typeof setTimeout>; waves: Map<string, Wave> }
const loaded = new Map<string, Promise<Loaded>>();

function load(engine: string, dir: string): Promise<Loaded> {
  let p = loaded.get(engine);
  if (!p) {
    const t = Date.now();
    p = create(engine, dir).then((handle) => {
      console.error(`[voice] ${engine} loaded in ${Date.now() - t}ms`);
      return { handle, queue: Promise.resolve(), users: 0, waves: new Map() };
    });
    p.catch(() => loaded.delete(engine));
    loaded.set(engine, p);
  }
  return p.then((l) => { touch(engine, l); return l; });
}

// Dropping the handle is enough: the addon frees native memory on GC.
function touch(engine: string, l: Loaded) {
  clearTimeout(l.timer);
  l.timer = setTimeout(() => {
    if (l.users) return touch(engine, l);
    // Only if still current: an unloaded handle's sessions keep touching it.
    void loaded.get(engine)?.then((cur) => { if (cur === l) loaded.delete(engine); }, () => {});
  }, IDLE_UNLOAD_MS);
}

/** One job at a time per engine handle. */
function serialize<T>(l: Loaded, job: () => Promise<T>): Promise<T> {
  const run = l.queue.then(job);
  l.queue = run.catch(() => {});
  return run;
}

async function transcribe(req: Extract<WorkerRequest, { op: "stt" }>): Promise<string> {
  const l = await load(req.engine, req.dir);
  return serialize(l, async () => {
    if (cancelled.has(req.id)) return "";
    if (req.engine === "nemotron") {
      const r = l.handle as Online;
      const s = freshStream(r);
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: req.samples });
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: TAIL_PADDING });
      s.inputFinished();
      while (r.isReady(s)) r.decode(s);
      return r.getResult(s).text.trim();
    }
    const r = l.handle as Offline;
    const texts: string[] = [];
    for (const samples of req.engine === "moonshine" ? splitAtPauses(req.samples) : [req.samples]) {
      if (cancelled.has(req.id)) break;
      const s = r.createStream();
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      texts.push((await r.decodeAsync(s)).text.trim());
    }
    return texts.filter(Boolean).join(" ");
  });
}

const cancelled = new Set<number>();

async function speak(req: Extract<WorkerRequest, { op: "tts" }>): Promise<void> {
  const l = await load(req.engine, req.dir);
  await serialize(l, async () => {
    if (cancelled.has(req.id)) return;
    const tts = l.handle as Tts;
    let cfg: Record<string, unknown> = { sid: req.sid ?? 0, speed: req.speed };
    if (req.wav) {
      let ref = l.waves.get(req.wav);
      if (!ref) l.waves.set(req.wav, ref = sherpa.readWave(join(req.dir, req.wav), false));
      // numSteps and the 12 s reference cap are the upstream pocket example's values.
      cfg = { speed: req.speed, referenceAudio: ref.samples, referenceSampleRate: ref.sampleRate, numSteps: 5, extra: { max_reference_audio_len: 12 } };
    }
    post({ id: req.id, type: "start", sampleRate: tts.sampleRate });
    // Pocket now and then babbles on for 3-10x its text, plain prose included
    // (measured 2026-09-24), and the chain would play all of it.
    let budget = (tts.sampleRate * (2 + req.text.length / (MIN_CHARS_PER_SEC[req.engine] ?? 5))) / req.speed;
    await tts.generateAsync({
      text: req.text,
      enableExternalBuffer: false,
      generationConfig: new sherpa.GenerationConfig(cfg),
      onProgress: ({ samples }: { samples: Float32Array }) => {
        if (cancelled.has(req.id)) return 0;
        post({ id: req.id, type: "chunk", samples: req.engine === "kitten" ? limitPeak(samples) : samples });
        return (budget -= samples.length) > 0 ? 1 : 0;
      },
    });
  });
}

// ── streaming sessions (nemotron) ────────────────────────────────────────────
interface Session { engine: string; l: Loaded; r: Online; s: Stream; committed: string; last: string }
const sessions = new Map<number, Session>();
// Sockets that closed while their engine was still loading.
const closedEarly = new Set<number>();

const joinText = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);

function decodeSession(id: number, ss: Session) {
  while (ss.r.isReady(ss.s)) ss.r.decode(ss.s);
  const text = joinText(ss.committed, ss.r.getResult(ss.s).text.trim());
  if (ss.r.isEndpoint(ss.s)) {
    ss.committed = text;
    ss.r.reset(ss.s);
  }
  if (text !== ss.last) post({ id, type: "partial", text: ss.last = text });
}

async function open(req: Extract<WorkerRequest, { op: "open" }>) {
  const l = await load(req.engine, req.dir);
  const r = l.handle as Online;
  if (closedEarly.delete(req.id)) return post({ id: req.id, type: "closed" });
  l.users++;
  sessions.set(req.id, { engine: req.engine, l, r, s: freshStream(r), committed: "", last: "" });
  post({ id: req.id, type: "ready" });
}

function sessionOp(req: Extract<WorkerRequest, { op: "audio" | "end" | "reset" | "close" }>) {
  const ss = sessions.get(req.id);
  if (!ss) { if (req.op === "close") closedEarly.add(req.id); return; }
  touch(ss.engine, ss.l);
  if (req.op === "audio") {
    ss.s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: req.samples });
    decodeSession(req.id, ss);
  } else if (req.op === "end") {
    ss.s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: TAIL_PADDING });
    ss.s.inputFinished();
    while (ss.r.isReady(ss.s)) ss.r.decode(ss.s);
    post({ id: req.id, type: "final", text: joinText(ss.committed, ss.r.getResult(ss.s).text.trim()) });
    Object.assign(ss, { s: freshStream(ss.r), committed: "", last: "" }); // a finished stream takes no more input
  } else if (req.op === "reset") {
    Object.assign(ss, { s: freshStream(ss.r), committed: "", last: "" });
  } else {
    sessions.delete(req.id);
    ss.l.users--;
    post({ id: req.id, type: "closed" });
  }
}

port.on("message", (req: WorkerRequest) => {
  const fail = (e: unknown) => post({ id: (req as { id: number }).id, type: "error", message: String((e as Error)?.message ?? e) });
  try {
    switch (req.op) {
      case "stt": transcribe(req).then((text) => { cancelled.delete(req.id); post({ id: req.id, type: "done", text }); }, (e) => { cancelled.delete(req.id); fail(e); }); break;
      case "tts": speak(req).then(() => { cancelled.delete(req.id); post({ id: req.id, type: "done" }); }, (e) => { cancelled.delete(req.id); fail(e); }); break;
      case "cancel": cancelled.add(req.id); break;
      case "open": open(req).catch((e) => { closedEarly.delete(req.id); fail(e); }); break;
      case "unload":
        loaded.get(req.engine)?.then((l) => clearTimeout(l.timer), () => {});
        loaded.delete(req.engine);
        break;
      default: sessionOp(req);
    }
  } catch (e) { fail(e); }
});
