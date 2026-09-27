// Expressive TTS bake-off: each candidate on this computer where the agent's
// P0 benchmark would put it, over the regression corpus, P7-normalized numbers
// and dates, and tagged expressive lines. Measures first audio and real-time
// factor, voice consistency across a reply's chunks (analyze.ts, as run.ts),
// intelligibility (WER through Parakeet), a MOS proxy (UTMOS22 strong), tag
// adherence (CED AudioSet tagger), model size and RAM. Renders to files, never
// plays anything.
//   tsx src/bakeoff.ts --engine chatterbox-turbo --out <dir>   one engine per process, so RAM is its own
//   tsx src/bakeoff.ts --table <dir>                           the results side by side
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { KEEP_S, trimSilence } from "../../../packages/shared/src/speech/trim";
import { stripMarkdown, toSpeech } from "../../../apps/web/src/lib/live/voiceText";
import type { Accel, BenchResult } from "../../../services/agent/src/voice/accel";
import { compareReply, percentile, type ReplyMetrics } from "./analyze";
import { CHATTERBOX_RATE, loadChatterbox } from "./chatterbox";
import { cacheDir, ENGINES, fetchPinned, verify, type Synth } from "./engines";
import { tagProb, wer, words } from "./score";
import { chunks, round, summarize } from "./summary";

const { values: args } = parseArgs({ options: { engine: { type: "string" }, out: { type: "string" }, table: { type: "string" } } });
const HERE = new URL("../", import.meta.url);
const at = (p: string) => resolve(process.env.INIT_CWD ?? ".", p);

if (args.table) {
  const rows = readdirSync(at(args.table)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(at(args.table!), f), "utf8")));
  const cols: [string, (r: Record<string, any>) => unknown][] = [
    ["engine", (r) => r.id], ["license", (r) => r.license], ["on", (r) => `${r.accel.provider} x${r.accel.numThreads}`],
    ["first ms p50/p95", (r) => `${r.firstMs.p50}/${r.firstMs.p95}`], ["rtf p50/p95", (r) => `${r.rtf.p50}/${r.rtf.p95}`],
    ["rough joins", (r) => r.consistency.roughJoins], ["f0 step st", (r) => r.consistency.f0JumpSt], ["loud step dB", (r) => r.consistency.loudJumpDb],
    ["pause ms", (r) => r.consistency.pauseMs], ["start pitch st", (r) => r.consistency.startPitchSt],
    ["WER %", (r) => r.werPct], ["WER numbers %", (r) => r.werNumbersPct], ["UTMOS", (r) => r.utmos],
    ["tags hit", (r) => (r.tags ? `${r.tags.filter((t: { hit: boolean }) => t.hit).length}/${r.tags.length}` : "n/a")],
    ["langs", (r) => r.languages.length], ["size MB", (r) => r.sizeMB], ["RAM MB", (r) => r.ramMB],
  ];
  console.log(`| ${cols.map(([h]) => h).join(" | ")} |\n|${cols.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| ${cols.map(([, f]) => f(r)).join(" | ")} |`);
  process.exit(0);
}

const cache = cacheDir();
// Everything the agent reads from DATA_DIR stays in the bake-off's cache.
process.env.OPENLIVE_DATA_DIR = join(cache, "sherpa");
const models = await import("../../../services/agent/src/voice/native-models");
const { chooseProvider, BENCH_TEXT } = await import("../../../services/agent/src/voice/accel");
const { probeDevice, threadsFor } = await import("../../../services/agent/src/voice/device");
const sherpa = createRequire(new URL("../../../services/agent/package.json", import.meta.url))("sherpa-onnx-node");
const ort = createRequire(new URL("../../../services/agent/package.json", import.meta.url))("onnxruntime-node");

interface Candidate { id: string; license: string; languages: string[]; tags: boolean; providers: string[]; sizeBytes: number; open(a: Accel): Promise<Synth> }

// Chatterbox-Turbo at the fastest mix measured on an M4 (2026-09-26): the q4
// LM beats q8 by 4x on CPU, and the fp32 decoder beats q4 and fp16.
const CBT_REV = "d21799bd0354adb85e348b8a0442a8405110a2cf";
const CBT_SUMS: Record<string, string> = {
  "tokenizer.json": "3f04e34bea22f9144d1a19151154095bc9ce0430bf421304f5797e716288a906",
  "tokenizer_config.json": "0d637373c70a54c3c7202c0c12b40ff4f346c329960283f5a88031717d73c66f",
  "onnx/language_model_q4.onnx": "b39d03d3f8b943b9e60c6fce3fb41191dbc1df4589f913291db1e214eef669b1",
  "onnx/language_model_q4.onnx_data": "2c029dc0acf48752473d8c74c72b5ceaaad76b9886fe106eaf2022142d5b5d5e",
  "onnx/embed_tokens_q4.onnx": "fd6ba1d22902e8f539d3dd6d7c1c44b98ebb4c84ebbb5e47fcb826ddcf667561",
  "onnx/embed_tokens_q4.onnx_data": "f54a51e234b509b64c3a03bb79e1149fba7e2eba6c2d9c222f18883379e1f5d8",
  "onnx/conditional_decoder.onnx": "8c43f3a1d0ddb1a86e226a244d7cda5396c67f5c6412789c23900c646e3ffc50",
  "onnx/conditional_decoder.onnx_data": "05f162a519f3e9abaf0b7337ae037f4af8b2b30c4455d39b2c61ed3a9b2b5476",
  "onnx/speech_encoder_quantized.onnx": "5b6f15870a43cf97892df86fc550a0ef4763522d527cde72b2a4316f80a34de4",
  "onnx/speech_encoder_quantized.onnx_data": "d59861fb55e806fbeee731da9d4f8ff819fb5735de5d15e262d902594ee4dbb6",
};
// The default voice of the onnx-community Chatterbox export (MIT), cloned by every render.
const CBT_VOICE = { url: "https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43", sums: { "default_voice.wav": "3ebc531cdaba358a327099c1c4f0448026719957bcf4d8e9868767f227e02f4e" } };
const UTMOS = { url: "https://huggingface.co/TigreGotico/utmos-onnx/resolve/ff41b8f440cb12ecda18261f9ff7326d058275ce", sums: { "utmos22_strong.onnx": "ece7ddb0999d0f12ffe8d7586b3618b8b6fa89269b5152288e4440d686409f69" } };
const CED = {
  id: "ced-mini-int8", url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-mini-audio-tagging-2024-04-19.tar.bz2",
  sums: { "model.int8.onnx": "ff29f39f9fbe637f72535160e9d006d61d872fdab0fce838672265b9b38cf946", "class_labels_indices.csv": "cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429" },
};
const ORT_EP: Record<string, string> = { directml: "dml" }; // native-worker.ts ORT_EP

const device = await probeDevice();
const bytes = (dir: string, files: string[]) => files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
function native(id: string, variant: string): Candidate {
  const e = models.nativeEngine(variant)!, engine = ENGINES.find((x) => x.id === id)!;
  return {
    id, license: engine.license, languages: e.languages, tags: false, sizeBytes: e.sizeBytes,
    providers: models.onOrt(e) ? device.ortProviders ?? ["cpu"] : device.providers,
    open: (a) => engine.open(cache, a),
  };
}
const CANDIDATES: Record<string, () => Promise<Candidate>> = {
  "supertonic-agent": async () => native("supertonic-agent", "supertonic-3"),
  "kokoro-native": async () => native("kokoro-native", "kokoro-multi-v1_0"),
  "chatterbox-turbo": async () => {
    const dir = join(cache, "chatterbox-turbo", CBT_REV);
    await fetchPinned(`https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX/resolve/${CBT_REV}`, dir, CBT_SUMS);
    await fetchPinned(CBT_VOICE.url, dir, CBT_VOICE.sums);
    await verify(dir, { ...CBT_SUMS, ...CBT_VOICE.sums });
    return {
      id: "chatterbox-turbo", license: "MIT", languages: ["en"], tags: true, providers: device.ortProviders ?? ["cpu"],
      sizeBytes: bytes(dir, [...Object.keys(CBT_SUMS), ...Object.keys(CBT_VOICE.sums)]),
      async open({ provider, numThreads }) {
        const cb = await loadChatterbox(dir, { lm: "q4", decoder: "" }, ORT_EP[provider] ?? provider, numThreads);
        const ref = sherpa.readWave(join(dir, "default_voice.wav"));
        const voice = await cb.voice(ref.sampleRate === CHATTERBOX_RATE ? ref.samples : new sherpa.LinearResampler(ref.sampleRate, CHATTERBOX_RATE).flush(ref.samples));
        return { sampleRate: CHATTERBOX_RATE, say: async (text) => trimSilence(await cb.synth(text, voice), CHATTERBOX_RATE, ...KEEP_S.supertonic), close: () => cb.close() };
      },
    };
  },
};

const id = args.engine ?? "";
if (!CANDIDATES[id] || !args.out) throw new Error(`usage: --engine ${Object.keys(CANDIDATES).join("|")} --out <dir>, or --table <dir>`);
const out = at(args.out);
mkdirSync(join(out, id), { recursive: true });
const c = await CANDIDATES[id]!();
const numThreads = threadsFor(device);
const ms = (t0: number) => Math.round(performance.now() - t0);
const secs = (x: Float32Array, sr: number) => x.length / sr;

// P0: the agent's benchmark on each provider this device has (accel.ts), and its choice.
const [benchFirst] = BENCH_TEXT.match(/[^.]+\./)!;
const bench: BenchResult[] = [];
for (const provider of c.providers as Accel["provider"][]) {
  try {
    let t = performance.now();
    const s = await c.open({ provider, numThreads });
    const loadMs = ms(t); t = performance.now();
    await s.say(benchFirst, false);
    const warmMs = ms(t); t = performance.now();
    await s.say(benchFirst, false);
    const firstMs = ms(t); t = performance.now();
    const a = await s.say(BENCH_TEXT, false);
    bench.push({ provider, loadMs, warmMs, firstMs, rtf: round((performance.now() - t) / 1000 / secs(a, s.sampleRate)) });
    await s.close();
  } catch (err) { bench.push({ provider, error: (err as Error).message }); }
  console.log(JSON.stringify(bench.at(-1)));
}
const accel: Accel = { provider: chooseProvider(bench), numThreads };

// Renders. RAM is the process's peak resident set from loading through the
// first reply's chunks, less where it stood before: the one-go renders after
// it load a second handle for a native engine (engines.ts).
const rss0 = process.memoryUsage().rss;
let rssPeak = rss0;
const sample = () => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); };
const sampler = setInterval(sample, 50);
const synth = await c.open(accel);
const corpus: string[] = JSON.parse(readFileSync(new URL("corpus.json", HERE), "utf8"));
const extra: { normalized: string[]; expressive: { text: string; tag: string }[] } = JSON.parse(readFileSync(new URL("bakeoff.json", HERE), "utf8"));
const replies = [...corpus, ...extra.normalized];
await synth.say(benchFirst, false); // warm, as the bench does
const sr = synth.sampleRate; // native engines know theirs once they have spoken
const firsts: number[] = [], rtfs: number[] = [], metrics: ReplyMetrics[] = [], heard: Float32Array[] = [];
for (const [r, reply] of replies.entries()) {
  const parts: Float32Array[] = [];
  for (const text of chunks(reply, r + 7)) {
    const t = performance.now();
    parts.push(await synth.say(text, false));
    const took = performance.now() - t;
    if (parts.length === 1) firsts.push(Math.round(took));
    rtfs.push(took / 1000 / Math.max(0.05, secs(parts.at(-1)!, sr)));
  }
  if (!r) { sample(); clearInterval(sampler); }
  metrics.push(compareReply(parts, await synth.say(toSpeech(stripMarkdown(reply), "en"), true), sr));
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (all.set(p, o), o + p.length), 0);
  heard.push(all);
  sherpa.writeWave(join(out, id, `reply-${r}.wav`), { samples: all, sampleRate: sr });
  process.stdout.write(".");
}
// Tagged lines render with their tag at the end, beside the same line without it.
const tagged: { tag: string; text: string; plain: Float32Array; tagged: Float32Array }[] = [];
for (const { text, tag } of c.tags ? extra.expressive : []) {
  tagged.push({ tag, text, plain: await synth.say(text, false), tagged: await synth.say(`${text} [${tag}]`, false) });
  sherpa.writeWave(join(out, id, `tag-${tagged.length - 1}-${tag}.wav`), { samples: tagged.at(-1)!.tagged, sampleRate: sr });
}
await synth.close();
console.log();

// Scoring, with every scorer loaded only now, outside the RAM window.
const asr = models.nativeEngine("parakeet-110m-int8")!;
if (!models.engineInstalled(asr)) await models.downloadEngine(asr, () => {}, AbortSignal.timeout(15 * 60_000));
const recognizer = new sherpa.OfflineRecognizer(models.sherpaConfig(asr, { provider: "cpu", numThreads }));
const transcribe = (x: Float32Array) => {
  const s = recognizer.createStream();
  s.acceptWaveform({ sampleRate: sr, samples: x });
  recognizer.decode(s);
  return recognizer.getResult(s).text as string;
};
const utmosDir = join(cache, "utmos");
await fetchPinned(UTMOS.url, utmosDir, UTMOS.sums);
await verify(utmosDir, UTMOS.sums);
const mosSession = await ort.InferenceSession.create(join(utmosDir, "utmos22_strong.onnx"), { intraOpNumThreads: numThreads });
const mos = async (x: Float32Array) => {
  const w: Float32Array = new sherpa.LinearResampler(sr, 16000).flush(x);
  return (await mosSession.run({ wave: new ort.Tensor("float32", w, [1, w.length]) })).mos.data[0] as number;
};
const weighted = (rs: { ref: string; hyp: string }[]) => {
  const n = rs.reduce((a, r) => a + words(r.ref).length, 0);
  return round((100 * rs.reduce((a, r) => a + wer(r.ref, r.hyp) * words(r.ref).length, 0)) / n);
};
const said = replies.map((reply, r) => ({ ref: toSpeech(stripMarkdown(reply), "en"), hyp: transcribe(heard[r]!) }));
const scores: number[] = [];
for (const x of heard) scores.push(await mos(x));

let tags = null;
if (c.tags) {
  const cedDir = join(cache, "sherpa", "models", CED.id);
  if (!models.engineInstalled({ ...asr, id: CED.id, files: Object.keys(CED.sums) })) await models.downloadEngine({ ...asr, id: CED.id, url: CED.url, files: Object.keys(CED.sums), vocoder: undefined }, () => {}, AbortSignal.timeout(15 * 60_000));
  await verify(cedDir, CED.sums);
  const tagger = new sherpa.AudioTagging({ model: { ced: join(cedDir, "model.int8.onnx"), numThreads, provider: "cpu" }, labels: join(cedDir, "class_labels_indices.csv"), topK: 527 });
  const events = (x: Float32Array) => {
    const s = tagger.createStream();
    s.acceptWaveform({ sampleRate: sr, samples: x });
    return tagger.compute(s) as { name: string; prob: number }[];
  };
  // A tag is performed when its sound shows up in the tagger (probability 0.2
  // or more, and 0.15 over the same line without it) and it is not read out.
  // The tagger reads each render's end, where the tag sits: over a whole line
  // the speech drowns it (measured 2026-09-26: a laugh at 0.05 over the line,
  // 0.51 over its last 1.2 s; CED's own laughter clip 0.30).
  const end = (x: Float32Array, s: number) => x.subarray(Math.max(0, x.length - Math.round(s * sr)));
  tags = tagged.map((t) => {
    const s = Math.max(1.2, secs(t.tagged, sr) - secs(t.plain, sr) + 0.3);
    const p = round(tagProb(t.tag, events(end(t.tagged, s)))), p0 = round(tagProb(t.tag, events(end(t.plain, s))));
    const hyp = transcribe(t.tagged), spoken = words(hyp).includes(t.tag) && !words(t.text).includes(t.tag);
    return { tag: t.tag, text: t.text, prob: p, plainProb: p0, extraS: round(secs(t.tagged, sr) - secs(t.plain, sr)), spoken, hyp, hit: p >= 0.2 && p - p0 >= 0.15 && !spoken };
  });
}

const result = {
  id, license: c.license, languages: c.languages, device: `${device.cpu}, ${device.ramBytes / 2 ** 30} GB`, bench, accel,
  firstMs: { p50: percentile(firsts, 0.5), p95: percentile(firsts, 0.95) },
  rtf: { p50: round(percentile(rtfs, 0.5)), p95: round(percentile(rtfs, 0.95)) },
  consistency: summarize(metrics),
  werPct: weighted(said.slice(0, corpus.length)), werNumbersPct: weighted(said.slice(corpus.length)),
  utmos: round(scores.reduce((a, b) => a + b, 0) / scores.length),
  tags, sizeMB: Math.round(c.sizeBytes / 1e6), ramMB: Math.round((rssPeak - rss0) / 1e6), transcripts: said,
};
writeFileSync(join(out, `${id}.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, transcripts: undefined }, null, 1));
process.exit(0); // idle native workers would otherwise keep the process alive
