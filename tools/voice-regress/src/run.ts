// Voice regression: every corpus reply streamed through the app's
// SentenceChunker, each chunk synthesized as the app speaks it and the chunks
// played back to back (audioPlayback.ts), against the same reply rendered in
// one go. Fails when the joins sound less like one voice than the thresholds
// allow, or drift from the engine's baseline.
//   tsx src/run.ts [--engine kitten,kokoro-js | --engine all] [--update] [--strict]
//                  [--chunker <a voiceText.ts variant>] [--report <dir for per-join JSON>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { stripMarkdown, toSpeech, SentenceChunker as AppChunker } from "../../../apps/web/src/lib/live/voiceText";
import { compareReply, type ReplyMetrics } from "./analyze";
import { cacheDir, ENGINES, type Engine, type Synth } from "./engines";

const { values: args } = parseArgs({ options: {
  engine: { type: "string" }, update: { type: "boolean" }, strict: { type: "boolean" }, chunker: { type: "string" }, report: { type: "string" },
} });
const HERE = new URL("../", import.meta.url);
const corpus: string[] = JSON.parse(readFileSync(new URL("corpus.json", HERE), "utf8"));
const Chunker: typeof AppChunker = args.chunker ? (await import(pathToFileURL(resolve(process.env.INIT_CWD ?? ".", args.chunker)).href)).SentenceChunker : AppChunker;

// Means over the corpus, each against the one-go render. `max` is the
// absolute threshold, for the mean and, for the four join metrics, for each
// join: a join past any of them is rough. `drift` is how far past its
// baseline a metric may move (times the engine's slack). Calibrated
// 2026-09-25 on Kitten nano over 7 and 5 runs: the current chunker gave 1-2
// rough joins of 29, pauses 9-12 ms and start pitch 0.16-0.30 st off one-go;
// the old comma-cut first chunk 5-6 of 30, 38-43 ms and 0.50-0.62 st.
const METRICS = {
  f0JumpSt: { max: 1.5, drift: 0.6, what: "pitch step at a join vs one-go (semitones)" },
  pauseMs: { max: 150, drift: 12, what: "pause at a join vs one-go (ms)" },
  loudJumpDb: { max: 3, drift: 0.5, what: "loudness step at a join vs one-go (dB)" },
  startPitchSt: { max: 1.5, drift: 0.15, what: "a chunk's first 0.6 s pitch vs the same words one-go (semitones)" },
  roughJoins: { max: 0.1, drift: 0.05, what: "share of joins past any join threshold" },
  leadMs: { max: 250, drift: 40, what: "silence before the reply's first word (ms)" },
  tailMs: { max: 600, drift: 100, what: "silence after the reply's last word (ms)" },
  durationDev: { max: 0.15, drift: 0.03, what: "|reply length / one-go length - 1|" },
  broken: { max: 0, drift: 0, what: "NaN or clipped samples, or silent chunks" },
} as const;
type Summary = Record<keyof typeof METRICS, number> & { replies: number; joins: number };

/** LLM-like deltas of 1-3 words (the space leading the word), from a fixed seed. */
function deltas(text: string, seed: number): string[] {
  const words = text.match(/\s*\S+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < words.length;) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (seed % 3);
    out.push(words.slice(i, i + n).join(""));
    i += n;
  }
  return out;
}

/** The reply's spoken chunks, as voiceEngine.ts feeds the chunker and enqueueSpeak cleans each one. */
function chunks(reply: string, seed: number): string[] {
  const c = new Chunker();
  const out = deltas(reply, seed).flatMap((d) => c.push(d, "en"));
  out.push(c.flush());
  return out.map((s) => stripMarkdown(s)).filter(Boolean).map((s) => toSpeech(s, "en"));
}

const mean = (xs: number[]) => { const f = xs.filter(Number.isFinite); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0; };
const round = (x: number) => Number(x.toFixed(3));

function summarize(ms: ReplyMetrics[]): Summary {
  const joins = ms.flatMap((m) => m.joins);
  const rough = ms.reduce((n, m) => n + m.joins.filter((j, i) => Math.abs(j.f0Step - j.refF0Step) > METRICS.f0JumpSt.max
    || Math.abs(j.pause - j.refPause) * 1000 > METRICS.pauseMs.max || Math.abs(j.loudStep - j.refLoudStep) > METRICS.loudJumpDb.max
    || m.headDev[i + 1]! > METRICS.startPitchSt.max).length, 0);
  return {
    replies: ms.length, joins: joins.length, roughJoins: round(rough / Math.max(1, joins.length)),
    f0JumpSt: round(mean(joins.map((j) => Math.abs(j.f0Step - j.refF0Step)))),
    pauseMs: round(mean(joins.map((j) => Math.abs(j.pause - j.refPause))) * 1000),
    loudJumpDb: round(mean(joins.map((j) => Math.abs(j.loudStep - j.refLoudStep)))),
    startPitchSt: round(mean(ms.flatMap((m) => m.headDev))),
    leadMs: round(mean(ms.map((m) => m.lead)) * 1000),
    tailMs: round(mean(ms.map((m) => m.tail)) * 1000),
    durationDev: round(mean(ms.map((m) => Math.abs(m.durationRatio - 1)))),
    broken: ms.reduce((n, m) => n + m.nan + m.clipped + m.emptyChunks, 0),
  };
}

/** Every threshold and drift the summary breaks. */
function check(s: Summary, base: Summary | null, e: Engine): string[] {
  const out: string[] = [];
  for (const k of Object.keys(METRICS) as (keyof typeof METRICS)[]) {
    const max = e.limits?.[k] ?? METRICS[k].max, drift = e.drift?.[k] ?? round(METRICS[k].drift * e.slack), what = METRICS[k].what;
    if (s[k] > max) out.push(`${k} ${s[k]} > ${max}: ${what}`);
    else if (base && s[k] > base[k] + drift) out.push(`${k} ${s[k]} drifted past baseline ${base[k]} + ${drift}: ${what}`);
  }
  return out;
}

async function regress(e: Engine, cache: string): Promise<"pass" | "fail" | "skip"> {
  const t0 = performance.now();
  const synths: Synth[] = [];
  try {
    // One at a time: the first downloads the model the others then load.
    for (let i = 0; i < (e.renders ?? 1); i++) synths.push(await e.open(cache));
  } catch (err) {
    await Promise.all(synths.map((s) => s.close()));
    console.log(`SKIP ${e.id}: could not load its model (${(err as Error).message}). Offline? It downloads into ${cache} when there is a network.`);
    return "skip";
  }
  const texts = corpus.map((reply, r) => chunks(reply, r + 7));
  // Each render of the corpus on its own synth, all at once: a stochastic
  // engine's renders are independent, and the metrics pool them.
  const renders = await Promise.all(synths.map(async (synth) => {
    const ms: ReplyMetrics[] = [];
    try {
      for (const [r, reply] of corpus.entries()) {
        const parts: Float32Array[] = [];
        for (const text of texts[r]!) parts.push(await synth.say(text, false));
        const ref = await synth.say(toSpeech(stripMarkdown(reply), "en"), true);
        ms.push(compareReply(parts, ref, synth.sampleRate));
      }
    } finally { await synth.close(); }
    return ms;
  }));
  const ms = renders.flat();
  if (args.report) {
    const dir = resolve(process.env.INIT_CWD ?? ".", args.report);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${e.id}.json`), JSON.stringify(ms.map((m, r) => ({ chunks: texts[r % corpus.length], ...m })), null, 1));
  }
  const s = summarize(ms);
  const file = new URL(`baseline/${e.id}.json`, HERE);
  let base: Summary | null = null;
  try { base = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\n${e.id} (${e.license}, ${e.tier}) ${s.replies} replies, ${s.joins} joins${synths.length > 1 ? ` over ${synths.length} renders` : ""}, ${secs} s`);
  for (const k of Object.keys(METRICS) as (keyof typeof METRICS)[]) console.log(`  ${k.padEnd(13)} ${String(s[k]).padStart(8)}   baseline ${base ? base[k] : "-"}   max ${e.limits?.[k] ?? METRICS[k].max}`);
  if (args.update) {
    mkdirSync(new URL("baseline/", HERE), { recursive: true });
    writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
    console.log(`  baseline written: ${fileURLToPath(file)}`);
    return "pass";
  }
  const failures = check(s, base, e);
  for (const f of failures) console.log(`  FAIL ${f}`);
  return failures.length ? "fail" : "pass";
}

const picked = args.engine === "all" ? ENGINES.filter((e) => e.tier !== "local")
  : args.engine ? args.engine.split(",").map((id) => ENGINES.find((e) => e.id === id) ?? (() => { throw new Error(`unknown engine ${id}; known: ${ENGINES.map((e) => e.id).join(", ")}`); })())
  : ENGINES.filter((e) => e.tier === "pr");
const cache = cacheDir();
const results = [];
for (const e of picked) results.push(await regress(e, cache));
const failed = results.includes("fail") || (args.strict && results.includes("skip"));
console.log(`\n${results.filter((r) => r === "pass").length} passed, ${results.filter((r) => r === "fail").length} failed, ${results.filter((r) => r === "skip").length} skipped`);
process.exit(failed ? 1 : 0);
