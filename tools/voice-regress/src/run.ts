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
import { chunks as chunksWith, METRICS, round, summarize, type Summary } from "./summary";

const { values: args } = parseArgs({ options: {
  engine: { type: "string" }, update: { type: "boolean" }, strict: { type: "boolean" }, chunker: { type: "string" }, report: { type: "string" },
} });
const HERE = new URL("../", import.meta.url);
const corpus: string[] = JSON.parse(readFileSync(new URL("corpus.json", HERE), "utf8"));
const Chunker: typeof AppChunker = args.chunker ? (await import(pathToFileURL(resolve(process.env.INIT_CWD ?? ".", args.chunker)).href)).SentenceChunker : AppChunker;
const chunks = (reply: string, seed: number) => chunksWith(reply, seed, Chunker);

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
