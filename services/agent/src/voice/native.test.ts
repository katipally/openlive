import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

// The main-thread side of the native engines against a stand-in worker thread:
// every postMessage is recorded, and a test answers as the worker would.
const w = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const posted: Array<{ op: string; id?: number; [k: string]: unknown }> = [];
  let current: InstanceType<typeof EventEmitter> | null = null;
  class Worker extends EventEmitter {
    constructor() { super(); current = this; }
    postMessage(m: { op: string; id?: number }) { posted.push(m); }
    unref() {}
  }
  return { posted, Worker, reply: (e: object) => current!.emit("message", e) };
});
vi.mock("node:worker_threads", () => ({ Worker: w.Worker }));

let dir: string;
let native: typeof import("./native.js");
let models: typeof import("./native-models.js");
let server: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ol-native-ws-"));
  process.env.OPENLIVE_DATA_DIR = dir;
  vi.resetModules();
  models = await import("./native-models.js");
  native = await import("./native.js");
  for (const e of [models.nativeEngine("nemotron")!, models.nativeEngine("nemotron-3.5-160ms-int8")!]) {
    for (const f of e.files) {
      const p = join(models.engineDir(e.id), f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "");
    }
  }
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const q = new URL(req.url!, "http://x").searchParams;
    native.upgradeAsrStream(req, socket, head, q.get("engine") ?? "nemotron", q.get("lang"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { w.posted.length = 0; });

/** Opens a stream and answers its "open" as the worker; resolves once the client is ready. */
async function openStream(query = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/stream${query}`);
  const messages: string[] = [];
  const closed = new Promise<number>((r) => ws.on("close", r));
  ws.on("error", () => {});
  ws.on("message", (d) => messages.push(String(d)));
  await vi.waitFor(() => expect(w.posted.some((m) => m.op === "open")).toBe(true));
  const id = w.posted.find((m) => m.op === "open")!.id!;
  w.reply({ id, type: "ready" });
  await vi.waitFor(() => expect(messages).toContain(JSON.stringify({ type: "ready" })));
  return { ws, id, messages, closed };
}

describe("speak", () => {
  it("settles `started` for a job cancelled while still queued", async () => {
    const e = models.nativeEngine("kitten")!;
    const job = native.speak(e, "hi", e.voices![0]!, 1, () => {});
    const id = w.posted.find((m) => m.op === "tts")!.id;
    w.reply({ id, type: "done" });
    await expect(job.started).rejects.toThrow("cancelled");
    await expect(job.done).resolves.toBeUndefined();
  });

  it("hands the worker the variant's config, the voice's wav path and its phonemizer voice", () => {
    const pocket = models.nativeEngine("pocket")!;
    native.speak(pocket, "hi", pocket.voices![1]!, 1, () => {});
    expect(w.posted.find((m) => m.op === "tts")).toMatchObject({
      engine: "pocket-int8", type: "pocket", wav: join(models.engineDir("pocket-int8"), "test_wavs/loona.wav"), espeak: undefined,
    });
    const kokoro = models.nativeEngine("kokoro-multi-v1_0-int8")!;
    native.speak(kokoro, "hola", kokoro.voices!.find((v) => v.id === "ef_dora")!, 1, () => {});
    expect(w.posted.filter((m) => m.op === "tts").at(-1)).toMatchObject({ engine: kokoro.id, type: "kokoro", sid: 28, espeak: "es" });
  });
});

describe("transcribe", () => {
  it("cancels a job whose caller aborts, and only while it is still pending", async () => {
    const e = models.nativeEngine("parakeet")!;
    const abort = new AbortController();
    const text = native.transcribe(e, new Float32Array(4), abort.signal);
    const id = w.posted.find((m) => m.op === "stt")!.id;
    abort.abort();
    expect(w.posted).toContainEqual({ op: "cancel", id });
    w.reply({ id, type: "done", text: "" });
    await expect(text).resolves.toBe("");

    const late = new AbortController();
    const done = native.transcribe(e, new Float32Array(4), late.signal);
    const id2 = w.posted.filter((m) => m.op === "stt").at(-1)!.id;
    w.reply({ id: id2, type: "done", text: "hello" });
    await expect(done).resolves.toBe("hello");
    late.abort();
    expect(w.posted).not.toContainEqual({ op: "cancel", id: id2 });
  });

  it("cancels at once for a signal that already aborted", () => {
    const e = models.nativeEngine("parakeet")!;
    void native.transcribe(e, new Float32Array(4), AbortSignal.abort());
    const id = w.posted.find((m) => m.op === "stt")!.id;
    expect(w.posted).toContainEqual({ op: "cancel", id });
  });
});

describe("the streaming ASR socket", () => {
  it("pins a multilingual engine to the asked language", async () => {
    const { ws } = await openStream("?engine=nemotron-3.5-160ms-int8&lang=ja-JP");
    expect(w.posted.find((m) => m.op === "open")).toMatchObject({ engine: "nemotron-3.5-160ms-int8", type: "online-transducer", lang: "ja" });
    ws.close();
  });

  it("refuses a language the engine does not speak, before loading anything", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/stream?engine=nemotron&lang=ja`);
    const [msg, code] = await new Promise<[string, number]>((res) => {
      let first = "";
      ws.on("message", (d) => { first ||= String(d); });
      ws.on("close", (c) => res([first, c]));
    });
    expect(JSON.parse(msg)).toEqual({ type: "error", error: "language-not-supported" });
    expect(code).toBe(1008);
    expect(w.posted.some((m) => m.op === "open")).toBe(false);
  });

  it("closes on an oversized frame without an uncaught error, and releases the session", async () => {
    const { ws, id, closed } = await openStream();
    ws.send(new Float32Array(100_000)); // 400 KB, over the 256 KiB frame cap
    expect(await closed).toBe(1009);
    await vi.waitFor(() => expect(w.posted).toContainEqual({ op: "close", id }));
  });

  it("sends nothing more for a session its worker failed", async () => {
    const { id, messages, closed } = await openStream();
    w.reply({ id, type: "error", message: "boom" });
    expect(await closed).toBe(1008);
    expect(messages).toContain(JSON.stringify({ type: "error", error: "boom" }));
    await new Promise((r) => setTimeout(r, 100)); // the server side's own close event
    expect(w.posted.filter((m) => m.id === id).map((m) => m.op)).toEqual(["open"]);
  });
});
