import { fork } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { Worker } from "node:worker_threads";
import { WebSocketServer } from "ws";
import { join } from "node:path";
import { engineDir, engineInstalled, langCode, nativeEngine, sherpaConfig, type EngineKind, type EngineVoice, type NativeEngine } from "./native-models.js";
import { accelFor, benchAudio, BENCH_TEXT, currentDevice, finishBench, markFailed, needsBench, providersFor, startBench, type BenchResult } from "./accel.js";
import { threadsFor, type Provider } from "./device.js";
import { pcmFromBytes } from "./pcm.js";
import type { Heard, ModelRef, WorkerEvent, WorkerRequest } from "./native-worker.js";
import { log } from "../log.js";

// Main-thread side of the native speech engines: every model call is a message
// to a worker thread (one for ASR, one for TTS, so a long synthesis never
// stalls a transcription). tsx runs the .ts sources; the packed agent ships the
// worker as its own bundle next to agent.mjs (apps/desktop/scripts/pack-agent.cjs).
const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./native-worker.ts" : "./native-worker.mjs", import.meta.url);

type Listener = (e: WorkerEvent) => void;
interface Pool { worker: Worker; listeners: Map<number, Listener> }
const pools = new Map<EngineKind, Pool>();
let nextId = 0;

function pool(kind: EngineKind): Pool {
  const existing = pools.get(kind);
  if (existing) return existing;
  const p: Pool = { worker: new Worker(WORKER_URL), listeners: new Map() };
  p.worker.unref();
  p.worker.on("message", (e: WorkerEvent) => {
    p.listeners.get(e.id)?.(e);
    if (e.type === "done" || e.type === "error" || e.type === "closed") p.listeners.delete(e.id);
  });
  // A crashed worker fails everything in flight; the next call spawns a fresh one.
  const fail = (err: Error) => {
    if (pools.get(kind) === p) pools.delete(kind);
    for (const [id, l] of p.listeners) l({ id, type: "error", message: err.message });
    p.listeners.clear();
  };
  p.worker.on("error", (err) => { log.error("voice", `${kind} worker:`, err); fail(err); });
  p.worker.on("exit", (code) => fail(new Error(`voice worker exited (${code})`)));
  pools.set(kind, p);
  return p;
}

function model(e: NativeEngine): ModelRef {
  if (needsBench(e)) queueBench(e);
  const accel = accelFor(e);
  return { engine: e.id, type: e.type, config: sherpaConfig(e, accel), provider: accel.provider };
}

function send(e: NativeEngine, req: WorkerRequest, listener?: Listener, transfer: ArrayBuffer[] = []): void {
  lastUse = Date.now();
  bench?.abort.abort();
  const p = pool(e.kind);
  if (listener && "id" in req) {
    // A failure on an accelerator retires it for this engine: the next load runs on CPU.
    const provider = ("provider" in req && req.provider) || "cpu";
    p.listeners.set(req.id, provider !== "cpu" ? (ev) => {
      if (ev.type === "error") { markFailed(e, provider, ev.message); unloadNative(e); log.warn("voice", `${e.id} failed on ${provider}, using CPU from now on:`, ev.message); }
      listener(ev);
    } : listener);
  }
  p.worker.postMessage(req, transfer);
}

/** Aborting `signal` drops the job if it has not started (it resolves ""), so a
 *  caller that gave up never holds the engine's queue. `lang` must be one of
 *  the engine's languages (the routes check); unset, the engine picks. */
export function transcribe(e: NativeEngine, samples: Float32Array, signal?: AbortSignal, lang?: string): Promise<Heard> {
  const id = ++nextId;
  let active = true;
  const cancel = () => { if (active) pool(e.kind).worker.postMessage({ op: "cancel", id } satisfies WorkerRequest); };
  return new Promise<Heard>((resolve, reject) => {
    send(e, { op: "stt", id, ...model(e), samples, lang }, (ev) => {
      if (ev.type === "done") resolve({ text: ev.text ?? "", at: ev.at });
      else if (ev.type === "error") reject(new Error(ev.message));
    }, [samples.buffer as ArrayBuffer]);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  }).finally(() => { active = false; signal?.removeEventListener("abort", cancel); });
}

/** `started` resolves with the sample rate once the engine is loaded, before
 *  the first chunk; chunks then arrive as they are generated. `lang` is the
 *  language of `text`, for an engine that is told it (Supertonic). */
export function speak(e: NativeEngine, text: string, voice: EngineVoice, speed: number, onChunk: (s: Float32Array) => void, lang?: string) {
  const id = ++nextId;
  let active = true;
  let onStart!: (rate: number) => void, onStartFail!: (err: Error) => void;
  const started = new Promise<number>((res, rej) => { onStart = res; onStartFail = rej; });
  const done = new Promise<void>((resolve, reject) => {
    send(e, { op: "tts", id, ...model(e), text, speed, sid: voice.sid, wav: voice.wav && join(engineDir(e.id), voice.wav), espeak: voice.espeak, voice: voice.id, lang }, (ev) => {
      if (ev.type === "start") onStart(ev.sampleRate);
      else if (ev.type === "chunk") onChunk(ev.samples);
      // A job cancelled while still queued ends without ever starting.
      else if (ev.type === "done") { active = false; onStartFail(new Error("cancelled")); resolve(); }
      else if (ev.type === "error") { active = false; const err = new Error(ev.message); onStartFail(err); reject(err); }
    });
  });
  const cancel = () => { if (active) pool(e.kind).worker.postMessage({ op: "cancel", id } satisfies WorkerRequest); };
  return { started, done, cancel };
}

export function unloadNative(e: NativeEngine): void {
  pools.get(e.kind)?.worker.postMessage({ op: "unload", engine: e.id } satisfies WorkerRequest);
}

// ── benchmarks (accel.ts) ────────────────────────────────────────────────────
// Generous: each provider of moonshine-tiny and kitten-nano finished in under
// 2 s on an M4 (2026-09-25). One still going past this is hung or far too slow.
const BENCH_TIMEOUT_MS = 120_000;
type BenchRequest = Extract<WorkerRequest, { op: "bench" }>;

/** One provider's benchmark in a child process of its own (native-worker.ts
 *  again, as a process): a native crash in the provider, a hang past
 *  `timeoutMs` or any other exit only fails that provider. Aborting `signal`
 *  kills the child and rejects; so does the agent exiting. */
export function benchInChild(req: BenchRequest, signal?: AbortSignal, timeoutMs = BENCH_TIMEOUT_MS, entry = fileURLToPath(WORKER_URL)): Promise<BenchResult> {
  const provider = req.provider ?? "cpu";
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    // Inside Electron the agent's execPath is Electron itself, which this turns
    // into plain Node; Node ignores it. execArgv is inherited, so tsx's loader
    // runs the .ts entry in dev.
    const child = fork(entry, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, serialization: "advanced" });
    const kill = () => child.kill("SIGKILL");
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      process.off("exit", kill);
      kill();
    };
    const end = (r: BenchResult) => { stop(); resolve(r); };
    const onAbort = () => { stop(); reject(new Error("aborted")); };
    const timer = setTimeout(() => end({ provider, error: `benchmark timed out after ${timeoutMs / 1000} s` }), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    process.once("exit", kill);
    child.on("message", (ev: WorkerEvent) => {
      if (ev.type === "bench") end({ provider, loadMs: ev.loadMs, warmMs: ev.warmMs, firstMs: ev.firstMs, rtf: ev.rtf });
      else if (ev.type === "error") end({ provider, error: ev.message });
    });
    child.on("error", (err) => end({ provider, error: err.message }));
    child.on("exit", (code, sig) => end({ provider, error: `benchmark process ${sig ? `killed by ${sig}` : `exited (${code})`}` }));
    child.send(req);
  });
}

/** Times `e` on each provider with the fixed input, one child process each
 *  (benchInChild): a benchmark never holds a live engine's queue, and a
 *  provider's native state, or crash, goes with its process. Aborting `signal`
 *  stops it and rejects. */
export async function benchEngine(e: NativeEngine, providers: Provider[], numThreads = threadsFor(currentDevice()), signal?: AbortSignal): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const voice = e.voices?.[0];
  const input = e.kind === "tts"
    ? { text: BENCH_TEXT, sid: voice?.sid, wav: voice?.wav && join(engineDir(e.id), voice.wav), espeak: voice?.espeak, voice: voice?.id }
    : { samples: benchAudio() };
  for (const provider of providers) {
    results.push(await benchInChild({ op: "bench", id: ++nextId, engine: e.id, type: e.type, config: sherpaConfig(e, { provider, numThreads }), provider, ...input }, signal));
  }
  return results;
}

// Benchmarks wait until no voice job has run for this long, so one never
// competes with a call for cores; any job that starts meanwhile aborts it.
const BENCH_IDLE_MS = 30_000;
const benchQueue = new Map<string, NativeEngine>(); // insertion order is run order
let lastUse = 0;
let benchTimer: ReturnType<typeof setTimeout> | undefined;
let bench: { id: string; abort: AbortController } | null = null;

const queueBench = (e: NativeEngine, now = false) => {
  benchQueue.set(e.id, e);
  if (now) lastUse = 0;
  if (!bench) armBench(now ? 0 : BENCH_IDLE_MS);
};
function armBench(ms: number) {
  clearTimeout(benchTimer);
  benchTimer = setTimeout(() => void runBenches(), ms);
  benchTimer.unref();
}

async function runBenches() {
  const [e] = benchQueue.values();
  if (!e || bench) return;
  if ([...pools.values()].some((p) => p.listeners.size)) return armBench(BENCH_IDLE_MS);
  const wait = lastUse + BENCH_IDLE_MS - Date.now();
  if (wait > 0) return armBench(wait);
  benchQueue.delete(e.id);
  if (!engineInstalled(e) || !needsBench(e) || !startBench(e)) return armBench(0);
  bench = { id: e.id, abort: new AbortController() };
  try {
    const entry = finishBench(e, await benchEngine(e, providersFor(e, currentDevice()), undefined, bench.abort.signal))!;
    log.debug("voice", `${e.id} benchmarked, runs on ${entry.chosen}:`, JSON.stringify(entry.results));
    if (entry.chosen !== "cpu") unloadNative(e);
  } catch {
    finishBench(e, null); // a call started: measure again once it is over
    benchQueue.set(e.id, e);
  } finally { bench = null; }
  if (benchQueue.size) armBench(0);
}

/** For Settings: which engine is being measured and which wait their turn. */
export const benchState = () => ({ running: bench?.id, queued: [...benchQueue.keys()] });

/** "Re-run benchmark": drops the result and measures as soon as no voice job is running. */
export function rebench(e: NativeEngine): void {
  if (bench?.id === e.id) return;
  finishBench(e, null);
  queueBench(e, true);
}

// ── streaming ASR socket ─────────────────────────────────────────────────────
// Mounted at /voice/stream by live/ws.ts, behind the same secret/origin gate as
// /live. 256 KiB per frame is ~4 s of 16 kHz Float32, far above any mic chunk.
const streamWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

export function upgradeAsrStream(req: IncomingMessage, socket: Duplex, head: Buffer, engineId: string | null, langParam: string | null = null): void {
  streamWss.handleUpgrade(req, socket, head, (ws) => {
    const say = (o: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    const e = nativeEngine(engineId ?? "nemotron");
    const lang = langCode(langParam) ?? undefined;
    const refuse = (error: string) => { say({ type: "error", error }); ws.close(1008, error); };
    if (!e?.streaming) return refuse("unknown streaming engine");
    if (lang && !e.languages.includes(lang)) return refuse("language-not-supported");
    if (!engineInstalled(e)) return refuse("engine-not-installed");

    // Without a listener, a frame over maxPayload surfaces as an uncaught exception.
    ws.on("error", (err) => log.warn("voice", "asr stream:", err.message));
    const id = ++nextId;
    // Set once the worker has let go of this session (it failed, or its worker
    // died): a later op would only spawn a fresh worker to hear about an unknown id.
    let gone = false;
    send(e, { op: "open", id, ...model(e), lang }, (ev) => {
      if (ev.type === "ready") say({ type: "ready" });
      else if (ev.type === "partial" || ev.type === "final") say({ type: ev.type, text: ev.text, at: ev.at });
      else if (ev.type === "error") { gone = true; refuse(ev.message); }
    });
    const op = (o: "end" | "reset" | "close") => { if (!gone) send(e, { op: o, id }); };
    ws.on("message", (data, isBinary) => {
      if (gone) return;
      if (isBinary) {
        const samples = pcmFromBytes(data as Buffer);
        if (samples?.length) send(e, { op: "audio", id, samples }, undefined, [samples.buffer as ArrayBuffer]);
        return;
      }
      let msg: { type?: string } | null = null;
      try { msg = JSON.parse(String(data)); } catch { /* not JSON: ignore */ }
      if (msg?.type === "end" || msg?.type === "reset") op(msg.type);
    });
    ws.on("close", () => op("close"));
  });
}
