// Scripted conversations through the app's own turn-taking, for
// turn.backchannels (docs/ARCHITECTURE.md). macOS only.
//   AGENT_URL=http://127.0.0.1:<port> pnpm converse:eval [ARMS=base,cues] [ROUNDS=1] [LANG_CODE=en|es]
// Each user turn is rendered with `say -o` (never played) and fed in real time,
// 32 ms a frame, through vad-web's own Silero v6 frame processor (the page's
// settings) into the real VoiceEngine; speech-to-text is the
// agent's native engine (STT, default Nemotron, or Nemotron 3.5 for Spanish,
// said by VOICE, default Samantha or Mónica), end of turn the real Smart-Turn
// v3 on onnxruntime-node (its features by transformers.js, as the page),
// streamed over the agent's /voice/stream as the page streams it, and each turn goes over /live to the agent's built-in
// brain with its configured model. Speech is not synthesized: a sentence
// "plays" 300 ms of silence on a clock, so the latency is end of the user's
// speech to the first reply audio handed to the player. Arms: base (the
// default pipeline) and cues (listening sounds on), alternated turn for turn.
// Point the agent at a scratch OPENLIVE_HOME: it keeps no chat (none is named).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { overlapMs, pct, voicedSpans, type Span } from "./measure";

const AGENT = process.env.AGENT_URL ?? "http://127.0.0.1:8787";
const LANG = (process.env.LANG_CODE ?? "en") as "en" | "es";
const STT = process.env.STT ?? (LANG === "en" ? "nemotron-en-160ms-int8" : "nemotron-3.5-160ms-int8");
const ARMS = (process.env.ARMS ?? "base,cues").split(",") as ("base" | "cues")[];
const ROUNDS = Number(process.env.ROUNDS ?? 1);
const VOICE = process.env.VOICE ?? (LANG === "en" ? "Samantha" : "Mónica");
const CACHE = process.env.CONVERSE_CACHE ?? join(homedir(), "Library", "Caches", "openlive-converse");

// A user turn: its parts, said with the pause (ms) after each but the last.
type Turn = (string | number)[];
const CONVERSATIONS: Record<typeof LANG, Turn[][]> = { en: [
  [["What's the capital of Australia?"], ["And how many people live there?"], ["Tell me one fun fact about it."], ["Thanks, that's all."]],
  [["I'm planning a trip to Japan next spring,", 900, "and I want to see the cherry blossoms. Where should I go?"],
    ["How many days would you spend in Kyoto?"],
    ["Turn off the lights.", 700, "Actually no, just dim the ones in the kitchen."]],
  [["Let me tell you about my weekend. On Saturday I drove up to the", 900, "mountains with my brother, and we were planning to hike to the", 1000, "lake at the top, but halfway up it started raining so hard that", 900, "we had to turn back. It was still a great day."],
    ["My sister wants to learn the guitar, but she only has", 1000, "twenty minutes a day, and she gets frustrated because", 1000, "her fingers hurt. Do you have any advice for her?"]],
  [["What's a good name for a grey cat?"], ["I like the second one."], ["How long do cats usually live?"], ["Okay, good night."]],
], es: [
  [["¿Cuál es la capital de Australia?"], ["¿Y cuánta gente vive allí?"], ["Cuéntame algo curioso de esa ciudad."], ["Gracias, eso es todo."]],
  [["Estoy planeando un viaje a Japón en primavera,", 900, "y quiero ver los cerezos en flor. ¿Adónde debería ir?"],
    ["¿Cuántos días pasarías en Kioto?"],
    ["Apaga las luces.", 700, "Mejor no, solo baja las de la cocina."]],
  [["Mi hermana quiere aprender a tocar la guitarra, pero solo tiene", 1000, "veinte minutos al día, y se frustra porque", 1000, "le duelen los dedos. ¿Qué le recomiendas?"],
    ["¿Qué nombre le pondrías a un gato gris?"], ["Me gusta el segundo."], ["Vale, buenas noches."]],
] };

// ── the app's modules, with only the audio hardware and the browser models swapped ──
const smart = vi.hoisted(() => {
  process.env.LANG_CODE ??= "en";
  // asrStream.ts opens /voice/stream where the desktop app would: the agent's port.
  (globalThis as { window?: unknown }).window = { openlive: { agentPort: Number(new URL(process.env.AGENT_URL ?? "http://127.0.0.1:8787").port) } };
  return { prob: null as null | ((a: Float32Array) => Promise<number>), sttMs: [] as number[], turnMs: [] as number[] };
});
const cfg = vi.hoisted(() => ({ backchannels: false }));
vi.mock("@ricky0123/vad-web", () => ({ MicVAD: class {} }));
vi.mock("@/lib/log", () => ({ log: { debug() {}, info() {}, warn: console.warn, error: console.error } }));
vi.mock("../../../apps/web/src/lib/live/models", () => {
  const agent = process.env.AGENT_URL ?? "http://127.0.0.1:8787", lang = process.env.LANG_CODE!;
  const engine = process.env.STT ?? (lang === "en" ? "nemotron-en-160ms-int8" : "nemotron-3.5-160ms-int8");
  const stt = async (audio: Float32Array, signal?: AbortSignal) => {
    const t0 = performance.now();
    const res = await fetch(`${agent}/voice/stt?engine=${engine}&lang=${lang}`, { method: "POST", body: audio as Float32Array<ArrayBuffer>, headers: { "content-type": "application/octet-stream" }, signal });
    if (!res.ok) throw new Error(`stt: ${res.status} ${await res.text()}`);
    smart.sttMs.push(performance.now() - t0);
    return { text: ((await res.json()) as { text: string }).text, at: [] };
  };
  const silence = (text: string) => ({ audio: new Float32Array(Math.max(2400, 7200 * Math.min(1, text.length / 20))), sampleRate: 24000 });
  return {
    stt,
    tts: async (text: string) => silence(text),
    ttsStream: async (text: string, _o: unknown, onChunk: (a: Float32Array, r: number) => void) => { const s = silence(text); onChunk(s.audio, s.sampleRate); },
    turnModelReady: () => true,
    turnComplete: async (audio: Float32Array, threshold = 0.5) => { const t0 = performance.now(), p = await smart.prob!(audio); smart.turnMs.push(performance.now() - t0); return p > threshold; },
    activeSttEngine: () => engine,
    hasWebGPU: () => false,
    timedOn: (final: { text: string; at?: number[] }) => ({ text: final.text, at: final.at ?? [] }),
    resetNativeFallbacks() {}, nativeSttFailed() {}, warmNativeEngines() {},
  };
});
vi.mock("../../../apps/web/src/lib/live/pipelineConfig", async (orig) => {
  const o = await orig<typeof import("../../../apps/web/src/lib/live/pipelineConfig")>();
  return { ...o, loadPipelineConfig: () => ({ ...o.DEFAULT_PIPELINE_CONFIG, language: process.env.LANG_CODE, turn: { ...o.DEFAULT_PIPELINE_CONFIG.turn, ...cfg } }) };
});
const { VoiceEngine } = await import("../../../apps/web/src/lib/live/voiceEngine");
const { DEFAULT_PIPELINE_CONFIG } = await import("../../../apps/web/src/lib/live/pipelineConfig");

/** A player on the clock: plays nothing, records when each chunk would sound. */
class ClockPlayer {
  spans: Span[] = [];
  private until = 0;
  private minEpoch = 0;
  play(a: Float32Array, epoch: number, rate = 24000, onStart?: () => void) {
    if (epoch < this.minEpoch) return;
    const now = performance.now(), start = Math.max(now, this.until);
    this.until = start + (1000 * a.length) / rate;
    this.spans.push([start, this.until]);
    if (onStart) setTimeout(onStart, start - now);
  }
  playing() { return performance.now() < this.until; }
  flush(epoch: number) { this.minEpoch = epoch; const now = performance.now(); if (this.until > now) { this.spans.at(-1)![1] = now; this.until = now; } }
  level() { return 0; }
  agentBands(n: number) { return new Array(n).fill(0); }
  hold() {} release() {} resume() {} close() {}
}

async function loadSmartTurn() {
  const { AutoProcessor, env } = await import("@huggingface/transformers");
  const ort = await import("onnxruntime-node");
  mkdirSync(CACHE, { recursive: true });
  env.cacheDir = CACHE;
  const file = join(CACHE, "smart-turn-v3.2-cpu.onnx");
  if (!existsSync(file)) writeFileSync(file, Buffer.from(await (await fetch("https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx")).arrayBuffer()));
  const proc = await AutoProcessor.from_pretrained("onnx-community/whisper-tiny.en");
  const session = await ort.InferenceSession.create(file);
  const N8 = 8 * 16000;
  // As turn.worker.ts: the last 8 s, zero-padded in front, as an [1, 80, 800] log-mel.
  smart.prob = async (audio) => {
    const a = new Float32Array(N8);
    if (audio.length >= N8) a.set(audio.subarray(audio.length - N8)); else a.set(audio, N8 - audio.length);
    const f = (await proc(a, { sampling_rate: 16000 })).input_features;
    const data = f.data as Float32Array, T = f.dims[2];
    const out = new Float32Array(80 * 800);
    for (let m = 0; m < 80; m++) for (let x = 0; x < 800; x++) out[m * 800 + x] = data[m * T + x]!;
    const res = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", out, [1, 80, 800]) });
    return res[session.outputNames[0]!]!.data[0] as number;
  };
}

/** vad-web's own frame processor and Silero v6, on onnxruntime-node, set up as voiceEngine.ts sets up MicVAD. */
async function openVad(ev: { start: () => void; end: (a: Float32Array) => void; frame: (f: Float32Array, speech: boolean) => void; misfire: () => void }) {
  const req = createRequire(import.meta.url);
  const dist = join(req.resolve("@ricky0123/vad-web"), "..");
  const { FrameProcessor } = req(join(dist, "frame-processor.js"));
  const { Silero } = req(join(dist, "models", "silero.js"));
  const { Message } = req(join(dist, "messages.js"));
  const ort = await import("onnxruntime-node");
  const silero = await Silero.new(ort, async () => readFileSync(join(dist, "silero_vad_v6.onnx")));
  const { speechThreshold, redemptionMs } = DEFAULT_PIPELINE_CONFIG.vad;
  const fp = new FrameProcessor(silero.process, silero.reset_state, {
    positiveSpeechThreshold: speechThreshold, negativeSpeechThreshold: Math.max(0.1, speechThreshold - 0.15),
    minSpeechMs: 250, preSpeechPadMs: 800, redemptionMs, submitUserSpeechOnPause: false,
  }, 32);
  fp.resume();
  return (frame: Float32Array) => fp.process(frame, (e: { msg: string; probs?: { isSpeech: number }; audio?: Float32Array }) => {
    if (e.msg === Message.FrameProcessed) ev.frame(frame, e.probs!.isSpeech >= speechThreshold);
    else if (e.msg === Message.SpeechStart) ev.start();
    else if (e.msg === Message.SpeechEnd) ev.end(e.audio!);
    else if (e.msg === Message.VADMisfire) ev.misfire();
  });
}

/** `text` said by VOICE, as 16 kHz float samples. */
function say(text: string, dir: string): Float32Array {
  const file = join(dir, "say.wav");
  const r = spawnSync("say", ["-v", VOICE, "-o", file, "--file-format=WAVE", "--data-format=LEF32@16000", text]);
  if (r.status) throw new Error(`say: ${r.stderr}`);
  const b = readFileSync(file);
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("ascii", at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === "data") return new Float32Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + size));
    at += 8 + size + (size & 1);
  }
  throw new Error("say: no data chunk");
}

type Row = { arm: string; round: number; conv: number; turn: number; committed: string; latency: number; held: boolean; early: boolean };
type Stats = { rows: Row[]; cues: { at: number; pauseAt: number }[]; cueOverlapMs: number; cueOverlaps: number };

async function conversation(arm: "base" | "cues", round: number, ci: number, audio: Float32Array[][], stats: Stats) {
  cfg.backchannels = arm === "cues";
  const player = new ClockPlayer(), cues = new ClockPlayer();
  const ws = new WebSocket(`${AGENT.replace(/^http/, "ws")}/live`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ t: "bind", agentId: null, cwd: "" }));
  let turn = 0, done = 0;
  const commits: { text: string; at: number; turnIdx: number }[] = [];
  let turnIdx = 0;
  const eng = new VoiceEngine({
    onPhase() {}, onPartial() {}, onHold() {}, onAgentText() {},
    onUserText: (text) => {
      commits.push({ text, at: performance.now(), turnIdx });
      ws.send(JSON.stringify({ t: "user_text", text, turn: ++turn }));
    },
    onBargeIn: (spoken) => ws.send(JSON.stringify({ t: "cancel", ...(spoken !== undefined ? { spoken } : {}) })),
  }, player as never);
  Object.assign(eng, { cuePlayer: cues });
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.t !== "sse" || (msg.turn !== undefined && msg.turn !== turn)) return;
    if (msg.event.type === "text_delta") eng.feedAgentDelta(msg.event.text);
    else if (msg.event.type === "tool_start") eng.endAgentStep(); // as useLiveSession: the line before a tool is voiced now
    else if (msg.event.type === "done") { eng.endAgentTurn(); done++; }
  };
  const e = eng as any;
  const feed = await openVad({
    start: () => e.onSpeechStart(), end: (a) => void e.onSpeechEnd(a, e.endStream(a)), frame: (f, s) => e.onFrame(f, s),
    misfire: () => { e.streaming = false; e.segmentLost(); if (e.phase === "listening") e.setPhase("idle"); },
  });
  e.vad = { start: async () => {}, pause() {}, destroy: async () => {} };
  e.syncAsr();
  for (let i = 0; i < 100 && !e.asr?.live; i++) await new Promise((r) => setTimeout(r, 50));
  if (!e.asr?.live) throw new Error(`${STT} does not stream here`);
  const { tts } = DEFAULT_PIPELINE_CONFIG;
  await e.renderCues({ engine: tts.variant, family: tts.family, voice: tts.voice, speed: tts.speed, lang: LANG, lexicon: null });
  // The mic: every 32 ms a frame, speech or room silence, on the wall clock.
  let t = performance.now();
  const frame = async (f: Float32Array) => { t += 32; await new Promise((r) => setTimeout(r, Math.max(0, t - performance.now()))); await feed(f); };
  const noise = () => Float32Array.from({ length: 512 }, () => (Math.random() - 0.5) * 2e-4);
  const userSpans: Span[] = [], pauses: number[] = [];
  for (let k = 0; k < audio.length; k++) {
    turnIdx = k;
    for (const part of audio[k]!) {
      if (part.length === 0) continue;
      const start = t + 32;
      for (const s of voicedSpans(part, start)) userSpans.push(s);
      for (let at = 0; at < part.length; at += 512) {
        const f = part.slice(at, at + 512);
        await frame(f.length === 512 ? f : Float32Array.from({ length: 512 }, (_, i) => f[i] ?? 0));
      }
      pauses.push(userSpans.at(-1)?.[1] ?? t);
    }
    // Silence until this turn's reply has played out (or 20 s), then 1.5 s more.
    const want = done + 1, t0 = performance.now();
    while ((done < want || player.playing() || e.phase !== "idle") && performance.now() - t0 < 20_000) await frame(noise());
    for (let i = 0; i < 47; i++) await frame(noise());
  }
  eng.stop();
  ws.close();
  const holdMs = DEFAULT_PIPELINE_CONFIG.turn.holdMs;
  for (const c of commits) {
    const first = player.spans.find(([a]) => a >= c.at);
    const voicedAt = userSpans.filter(([, b]) => b <= c.at).at(-1)?.[1] ?? NaN;
    const latency = first ? first[0] - voicedAt : NaN;
    stats.rows.push({ arm, round, conv: ci, turn: c.turnIdx, committed: c.text, latency, held: c.at - voicedAt > 0.8 * holdMs, early: commits.filter((x) => x.turnIdx === c.turnIdx).length > 1 });
  }
  for (const [a] of cues.spans) stats.cues.push({ at: a, pauseAt: pauses.filter((p) => p <= a).at(-1) ?? NaN });
  const cueSpans = cues.spans.slice();
  stats.cueOverlapMs += overlapMs(cueSpans, userSpans);
  stats.cueOverlaps += cueSpans.filter((c) => overlapMs([c], userSpans) > 0).length;
}

test("converse", async () => {
  await loadSmartTurn();
  const dir = mkdtempSync(join(tmpdir(), "ol-converse-"));
  const stats: Record<string, Stats> = Object.fromEntries(ARMS.map((a) => [a, { rows: [], cues: [], cueOverlapMs: 0, cueOverlaps: 0 }]));
  try {
    const audio = CONVERSATIONS[LANG].map((c) => c.map((turn) => turn.flatMap((p) => typeof p === "number" ? [new Float32Array(Math.round(p * 16))] : [say(p, dir)])));
    for (let r = 0; r < ROUNDS; r++) for (let ci = 0; ci < audio.length; ci++) for (const arm of (r + ci) % 2 ? ARMS.slice().reverse() : ARMS) {
      await conversation(arm, r, ci, audio[ci]!, stats[arm]!);
      console.log(`round ${r + 1} conversation ${ci + 1} ${arm}: done`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const report: Record<string, unknown> = {};
  for (const arm of ARMS) {
    const s = stats[arm]!, direct = s.rows.filter((r) => !r.held && Number.isFinite(r.latency)).map((r) => r.latency);
    report[arm] = {
      commits: s.rows.length, held: s.rows.filter((r) => r.held).length, splitTurns: s.rows.filter((r) => r.early).length,
      latencyP50: Math.round(pct(direct, 50)), latencyP95: Math.round(pct(direct, 95)),
      cues: s.cues.length, cueAfterPauseMsP50: Math.round(pct(s.cues.map((c) => c.at - c.pauseAt), 50)), cueOverlaps: s.cueOverlaps, cueOverlapMs: Math.round(s.cueOverlapMs),
      rows: s.rows.map((r) => `${r.conv}.${r.turn} ${Math.round(r.latency)}ms${r.held ? " held" : ""} "${r.committed}"`),
    };
  }
  report.batchSttMsP50 = Math.round(pct(smart.sttMs, 50));
  report.smartTurnMsP50 = Math.round(pct(smart.turnMs, 50));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.CONVERSE_OUT) writeFileSync(process.env.CONVERSE_OUT, JSON.stringify(report, null, 2));
});
