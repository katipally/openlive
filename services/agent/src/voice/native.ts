import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Worker } from "node:worker_threads";
import { WebSocketServer } from "ws";
import { join } from "node:path";
import { engineDir, engineInstalled, nativeEngine, sherpaConfig, type EngineKind, type EngineVoice, type NativeEngine } from "./native-models.js";
import { pcmFromBytes } from "./pcm.js";
import type { ModelRef, WorkerEvent, WorkerRequest } from "./native-worker.js";
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

const model = (e: NativeEngine): ModelRef => ({ engine: e.id, type: e.type, config: sherpaConfig(e) });

function send(e: NativeEngine, req: WorkerRequest, listener?: Listener, transfer: ArrayBuffer[] = []): void {
  const p = pool(e.kind);
  if (listener && "id" in req) p.listeners.set(req.id, listener);
  p.worker.postMessage(req, transfer);
}

/** Aborting `signal` drops the job if it has not started (it resolves ""), so a
 *  caller that gave up never holds the engine's queue. */
export function transcribe(e: NativeEngine, samples: Float32Array, signal?: AbortSignal): Promise<string> {
  const id = ++nextId;
  let active = true;
  const cancel = () => { if (active) pool(e.kind).worker.postMessage({ op: "cancel", id } satisfies WorkerRequest); };
  return new Promise<string>((resolve, reject) => {
    send(e, { op: "stt", id, ...model(e), samples }, (ev) => {
      if (ev.type === "done") resolve(ev.text ?? "");
      else if (ev.type === "error") reject(new Error(ev.message));
    }, [samples.buffer as ArrayBuffer]);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  }).finally(() => { active = false; signal?.removeEventListener("abort", cancel); });
}

/** `started` resolves with the sample rate once the engine is loaded, before
 *  the first chunk; chunks then arrive as they are generated. */
export function speak(e: NativeEngine, text: string, voice: EngineVoice, speed: number, onChunk: (s: Float32Array) => void) {
  const id = ++nextId;
  let active = true;
  let onStart!: (rate: number) => void, onStartFail!: (err: Error) => void;
  const started = new Promise<number>((res, rej) => { onStart = res; onStartFail = rej; });
  const done = new Promise<void>((resolve, reject) => {
    send(e, { op: "tts", id, ...model(e), text, speed, sid: voice.sid, wav: voice.wav && join(engineDir(e.id), voice.wav), espeak: voice.espeak }, (ev) => {
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

// ── streaming ASR socket ─────────────────────────────────────────────────────
// Mounted at /voice/stream by live/ws.ts, behind the same secret/origin gate as
// /live. 256 KiB per frame is ~4 s of 16 kHz Float32, far above any mic chunk.
const streamWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

export function upgradeAsrStream(req: IncomingMessage, socket: Duplex, head: Buffer, engineId: string | null): void {
  streamWss.handleUpgrade(req, socket, head, (ws) => {
    const say = (o: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    const e = nativeEngine(engineId ?? "nemotron");
    const refuse = (error: string) => { say({ type: "error", error }); ws.close(1008, error); };
    if (!e?.streaming) return refuse("unknown streaming engine");
    if (!engineInstalled(e)) return refuse("engine-not-installed");

    // Without a listener, a frame over maxPayload surfaces as an uncaught exception.
    ws.on("error", (err) => log.warn("voice", "asr stream:", err.message));
    const id = ++nextId;
    // Set once the worker has let go of this session (it failed, or its worker
    // died): a later op would only spawn a fresh worker to hear about an unknown id.
    let gone = false;
    send(e, { op: "open", id, ...model(e) }, (ev) => {
      if (ev.type === "ready") say({ type: "ready" });
      else if (ev.type === "partial" || ev.type === "final") say({ type: ev.type, text: ev.text });
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
