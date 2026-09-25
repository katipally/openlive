import { createRequire } from "node:module";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parentPort } from "node:worker_threads";
import { SAMPLE_RATE, limitPeak, splitAtPauses } from "./pcm.js";
import type { ModelType } from "./native-models.js";

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

/** A variant to load: its id keys the loaded handle; config is native-models.ts sherpaConfig. */
export interface ModelRef { engine: string; type: ModelType; config: object }
export type WorkerRequest =
  | ({ op: "stt"; id: number; samples: Float32Array } & ModelRef)
  | ({ op: "tts"; id: number; text: string; speed: number; sid?: number; wav?: string; espeak?: string } & ModelRef)
  | ({ op: "open"; id: number } & ModelRef)
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
// Per worker, so per kind: Parakeet 0.6B v3 and Nemotron 3.5 loaded together
// held 3.3 GB resident (measured 2026-09-24).
const MAX_LOADED = 2;
// Half the slowest speaking rate measured per voice (pocket 16, kitten 10 chars/s):
// a synthesis running past 2 s plus this pace is a runaway, not speech.
const MIN_CHARS_PER_SEC: Record<string, number> = { pocket: 8, kitten: 5 };
// Model types that reach full scale (pcm.ts limitPeak). Measured 2026-09-24:
// kitten peaks at 1.08, piper es_ES-davefx at 0.994; kokoro, matcha, pocket
// and the other Piper voices stay under 0.84.
const PEAK_LIMITED = new Set<ModelType>(["kitten", "vits"]);
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

async function create(op: WorkerRequest["op"], m: ModelRef): Promise<unknown> {
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

async function transcribe(req: Extract<WorkerRequest, { op: "stt" }>): Promise<string> {
  const l = await load(req.op, req);
  return serialize(l, async () => {
    if (cancelled.has(req.id)) return "";
    if (req.type === "online-transducer") {
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
    // Canary skipped two sentences of a 38 s clip (measured 2026-09-24); the
    // 8 s windows moonshine needs (pcm.ts) keep it whole.
    for (const samples of req.type === "moonshine" || req.type === "canary" ? splitAtPauses(req.samples) : [req.samples]) {
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
  const l = await load(req.op, req);
  await serialize(l, async () => {
    if (cancelled.has(req.id)) return;
    const tts = l.handle as Tts;
    let cfg: Record<string, unknown> = { sid: req.sid ?? 0, speed: req.speed, ...(req.espeak && { extra: { lang: req.espeak } }) };
    if (req.wav) {
      let ref = l.waves.get(req.wav);
      if (!ref) l.waves.set(req.wav, ref = sherpa.readWave(req.wav, false));
      // numSteps and the 12 s reference cap are the upstream pocket example's values.
      cfg = { speed: req.speed, referenceAudio: ref.samples, referenceSampleRate: ref.sampleRate, numSteps: 5, extra: { max_reference_audio_len: 12 } };
    }
    post({ id: req.id, type: "start", sampleRate: tts.sampleRate });
    // Pocket now and then babbles on for 3-10x its text, plain prose included
    // (measured 2026-09-24), and the chain would play all of it.
    let budget = (tts.sampleRate * (2 + req.text.length / (MIN_CHARS_PER_SEC[req.type] ?? 5))) / req.speed;
    await tts.generateAsync({
      text: req.text,
      enableExternalBuffer: false,
      generationConfig: new sherpa.GenerationConfig(cfg),
      onProgress: ({ samples }: { samples: Float32Array }) => {
        if (cancelled.has(req.id)) return 0;
        // kokoro-multi int8 now and then returns all-NaN audio (native-models.ts): play silence, not NaN.
        if (samples.some(Number.isNaN)) samples.fill(0);
        post({ id: req.id, type: "chunk", samples: PEAK_LIMITED.has(req.type) ? limitPeak(samples) : samples });
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
  const l = await load(req.op, req);
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
        drop(req.engine);
        break;
      default: sessionOp(req);
    }
  } catch (e) { fail(e); }
});
