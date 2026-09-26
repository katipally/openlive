import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
let accel: typeof import("./accel.js");
let server: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ol-native-ws-"));
  process.env.OPENLIVE_DATA_DIR = dir;
  vi.resetModules();
  models = await import("./native-models.js");
  native = await import("./native.js");
  accel = await import("./accel.js");
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

describe("an accelerator", () => {
  it("that fails in a real call is retired: the handle unloads and the next load runs on CPU", async () => {
    await accel.refreshDevice(async () => ({ ...accel.currentDevice(), os: "darwin", runtime: "test (cpu, coreml)", providers: ["cpu", "coreml"] }));
    const e = models.nativeEngine("kitten")!;
    accel.finishBench(e, [{ provider: "cpu", loadMs: 1, warmMs: 1, firstMs: 1, rtf: 0.2 }, { provider: "coreml", loadMs: 1, warmMs: 1, firstMs: 1, rtf: 0.1 }]);
    const job = native.speak(e, "hi", e.voices![0]!, 1, () => {});
    const req = w.posted.find((m) => m.op === "tts")!;
    expect(req).toMatchObject({ provider: "coreml", config: { model: { provider: "coreml" } } });
    w.reply({ id: req.id, type: "error", message: "Unable to get shape for output" });
    await expect(job.started).rejects.toThrow("Unable to get shape");
    await expect(job.done).rejects.toThrow("Unable to get shape");
    expect(w.posted).toContainEqual({ op: "unload", engine: e.id });
    native.speak(e, "hi", e.voices![0]!, 1, () => {});
    expect(w.posted.filter((m) => m.op === "tts").at(-1)).toMatchObject({ provider: "cpu", config: { model: { provider: "cpu" } } });
  });
});

describe("Supertonic on this computer", () => {
  it("runs on onnxruntime-node's chosen provider, told the style and language, and a failing GPU retires to CPU", async () => {
    await accel.refreshDevice(async () => ({ ...accel.currentDevice(), os: "darwin", ortRuntime: "test (cpu, webgpu)", ortProviders: ["cpu", "webgpu"] }));
    const e = models.nativeEngine("supertonic-3")!;
    accel.finishBench(e, [{ provider: "cpu", loadMs: 1, warmMs: 1, firstMs: 1, rtf: 0.17 }, { provider: "webgpu", loadMs: 1, warmMs: 1, firstMs: 1, rtf: 0.06 }]);
    const job = native.speak(e, "Hola.", e.voices!.find((v) => v.id === "F2")!, 1.1, () => {}, "es");
    const req = w.posted.find((m) => m.op === "tts" && m.engine === e.id)!;
    expect(req).toMatchObject({ type: "supertonic", provider: "webgpu", voice: "F2", lang: "es", speed: 1.1, config: { dir: models.engineDir(e.id), provider: "webgpu" } });
    w.reply({ id: req.id, type: "error", message: "WebGPU device lost" });
    await expect(job.started).rejects.toThrow("device lost");
    await expect(job.done).rejects.toThrow("device lost");
    native.speak(e, "Hola.", e.voices![0]!, 1, () => {}, "es");
    expect(w.posted.filter((m) => m.op === "tts").at(-1)).toMatchObject({ provider: "cpu", config: { provider: "cpu" } });
  });
});

describe("a benchmark process", () => {
  const req = { op: "bench", id: 1, engine: "kitten", type: "kitten", config: {}, provider: "coreml", text: "hi" } as const;
  /** A stand-in child entry: `body` runs on the benchmark request, after the child records its pid. */
  const child = (name: string, body: string) => {
    const p = join(dir, `${name}.mjs`);
    writeFileSync(p, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(`${p}.pid`)}, String(process.pid));\nprocess.on("message", (req) => { ${body} });`);
    return p;
  };
  const alive = (entry: string) => { try { return process.kill(Number(readFileSync(`${entry}.pid`, "utf8")), 0); } catch { return false; } };

  it("reports its result and is then killed", async () => {
    const entry = child("ok", `process.send({ id: req.id, type: "bench", loadMs: 1, warmMs: 2, firstMs: 3, rtf: 0.5 });`);
    expect(await native.benchInChild(req, undefined, 10_000, entry)).toEqual({ provider: "coreml", loadMs: 1, warmMs: 2, firstMs: 3, rtf: 0.5 });
    await vi.waitFor(() => expect(alive(entry)).toBe(false));
  });

  it("that crashes natively fails only that provider", async () => {
    const r = await native.benchInChild(req, undefined, 10_000, child("abort", "process.abort();"));
    expect(r).toMatchObject({ provider: "coreml", error: expect.stringMatching(/SIGABRT|exited/) });
  });

  it("that hangs past its timeout is killed and fails that provider", async () => {
    const entry = child("hang", "");
    expect(await native.benchInChild(req, undefined, 300, entry)).toEqual({ provider: "coreml", error: "benchmark timed out after 0.3 s" });
    await vi.waitFor(() => expect(alive(entry)).toBe(false));
  });

  it("is killed when a voice job aborts it", async () => {
    const entry = child("abortable", "");
    const ac = new AbortController();
    const run = native.benchInChild(req, ac.signal, 10_000, entry);
    await vi.waitFor(() => expect(alive(entry)).toBe(true));
    ac.abort();
    await expect(run).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(alive(entry)).toBe(false));
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
    await expect(text).resolves.toEqual({ text: "", at: undefined });

    const late = new AbortController();
    const done = native.transcribe(e, new Float32Array(4), late.signal);
    const id2 = w.posted.filter((m) => m.op === "stt").at(-1)!.id;
    w.reply({ id: id2, type: "done", text: "hello", at: [120] });
    await expect(done).resolves.toEqual({ text: "hello", at: [120] });
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

  it("relays a final with its word onsets, a partial as text alone", async () => {
    const { ws, id, messages } = await openStream();
    w.reply({ id, type: "partial", text: "hello" });
    w.reply({ id, type: "final", text: "hello there", at: [310, 720] });
    await vi.waitFor(() => expect(messages).toContain(JSON.stringify({ type: "final", text: "hello there", at: [310, 720] })));
    expect(messages).toContain(JSON.stringify({ type: "partial", text: "hello" }));
    ws.close();
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
