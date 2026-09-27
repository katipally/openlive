// Side talk eval: how well each candidate sentence embedding model, with a
// logistic head fitted on the training split and the context rules of
// @openlive/shared/speech/addressee, tells speech said to the app from side talk.
//   tsx src/run.ts [--models id,id] [--rate 0.01] [--json <file>] [--write]
// Data (data/*.json) is synthetic, written for this eval: no openly licensed
// corpus of people talking to a voice assistant and to each other in the same
// room was found. The head and its threshold come from train.en.json only
// (the threshold ignores at most --rate of its addressed rows, scored out of
// fold); test.en.json and test.multi.json (nine other languages) are held out.
// Embeddings go through the agent's worker (native-worker.ts "embed"), as the
// app computes them. Models download into the OS cache dir. --write saves the
// first model's head as packages/shared/src/speech/addressee-head.ts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { isSideTalk, sideScore } from "../../../packages/shared/src/speech/addressee";
import type { WorkerEvent, WorkerRequest } from "../../../services/agent/src/voice/native-worker";
import { probeDevice, threadsFor } from "../../../services/agent/src/voice/device";
import { auc, fit, outOfFold, quantile, rates, thresholdAt, type Head } from "./head";
import { synthetic, type Row } from "./data";

const { values: args } = parseArgs({ options: { models: { type: "string" }, rate: { type: "string" }, json: { type: "string" }, write: { type: "boolean" } } });
const RATE = Number(args.rate ?? 0.01);

// Multilingual sentence encoders with an int8 ONNX export, all ten app
// languages and an open license, pinned with their sha256 (2026-09-26). Also tried
// (through transformers.js, docs/ARCHITECTURE.md): paraphrase-multilingual-
// MiniLM-L12-v2 and multilingual-e5-small scored below this one on the
// English test split, Qwen2.5-0.5B-Instruct asked zero-shot near chance.
const HF = "https://huggingface.co";
const MODELS: Record<string, { repo: string; rev: string; license: string; sha: Record<string, string> }> = {
  "mpnet-multi": {
    repo: "Xenova/paraphrase-multilingual-mpnet-base-v2", rev: "e5d116277351513fd260955ece953ecddde7046e", license: "Apache-2.0",
    sha: { "onnx/model_quantized.onnx": "280b5fe103cc79d891d672f47826067835b7feed8b0b1865e34ed38f21719b49", "tokenizer.json": "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441" },
  },
};
// The model the app ships (native-models.ts "addressee-mpnet-multi-int8").
const SHIPPED = "mpnet-multi";

const cache = process.env.ADDRESSEE_CACHE ?? join(
  process.platform === "darwin" ? join(homedir(), "Library", "Caches")
    : process.platform === "win32" ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "openlive-addressee");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function fetchModel(id: string): string {
  const spec = MODELS[id]!, dir = join(cache, id);
  for (const f of ["onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json"]) {
    const dest = join(dir, f);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    console.log(`downloading ${spec.repo} ${f}...`);
    const r = spawnSync("curl", ["-sSLf", "-o", `${dest}.part`, `${HF}/${spec.repo}/resolve/${spec.rev}/${f}`], { stdio: "inherit" });
    if (r.status) throw new Error(`${f}: curl exited ${r.status}`);
    if (spec.sha[f] && sha256(`${dest}.part`) !== spec.sha[f]) throw new Error(`${spec.repo} ${f}: sha256 mismatch`);
    renameSync(`${dest}.part`, dest);
  }
  return dir;
}

// ── data ─────────────────────────────────────────────────────────────────────
const all = synthetic();
const splits = ["train", "en", "multi"] as const;
console.log(splits.map((s) => { const r = all.filter((x) => x.split === s); return `${s}: ${r.filter((x) => !x.side).length} addressed, ${r.filter((x) => x.side).length} side talk`; }).join(" · "));

// ── models ───────────────────────────────────────────────────────────────────
const device = await probeDevice();
const numThreads = threadsFor(device);
const worker = new Worker(new URL("../../../services/agent/src/voice/native-worker.ts", import.meta.url));
let nextId = 0;
function embed(ref: object, text: string): Promise<Float32Array> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const on = (ev: WorkerEvent) => {
      if (ev.id !== id) return;
      worker.off("message", on);
      if (ev.type === "embedding") resolve(ev.embedding); else reject(new Error(ev.type === "error" ? ev.message : ev.type));
    };
    worker.on("message", on);
    worker.postMessage({ op: "embed", id, ...ref, text } as WorkerRequest);
  });
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`.padStart(7);
const report: Record<string, unknown> = {};
const ids = args.models?.split(",") ?? Object.keys(MODELS);
for (const id of ids) {
  const spec = MODELS[id];
  if (!spec) { console.log(`unknown model ${id}; known: ${Object.keys(MODELS).join(", ")}`); continue; }
  const ref = { engine: `eval-${id}`, type: "addressee", config: { dir: fetchModel(id), provider: "cpu", numThreads } };
  await embed(ref, "warm up"); // load
  const ms: number[] = [];
  const e: Float32Array[] = [];
  for (const r of all) {
    const t0 = performance.now();
    e.push(await embed(ref, r.said));
    ms.push(performance.now() - t0);
  }
  worker.postMessage({ op: "unload", engine: ref.engine } satisfies WorkerRequest);

  const train = all.map((r, i) => i).filter((i) => all[i]!.split === "train");
  const x = train.map((i) => e[i]!), y = train.map((i) => Number(all[i]!.side));
  const head: Head = fit(x, y);
  const oof = outOfFold(x, y);
  const score = all.map((r, i) => (r.split === "train" ? oof[train.indexOf(i)]! : sideScore(e[i]!, head)));
  // Rows a rule already calls addressed (the agent asked back) are left out of the
  // threshold's count: the rule, not the score, decides them.
  const scene = (r: Row, speaker = true) => ({ reply: r.reply, speaker: speaker ? r.speaker : undefined });
  const ruledAddressed = (r: Row) => !isSideTalk(r.said, Infinity, scene(r, false), 0);
  const t = thresholdAt(train.filter((i) => !all[i]!.side && !ruledAddressed(all[i]!)).map((i) => score[i]!), RATE);

  // Operating points: the score alone; with the rules and no voiceprint; with the
  // voiceprint labelling voices. Its gate mode drops other voices before this
  // check, so there only the user's own side talk is left to catch.
  const modes = {
    "score only": (r: Row, s: number) => s > t,
    "rules, voiceprint off": (r: Row, s: number) => isSideTalk(r.said, s, scene(r, false), t),
    "rules, voiceprint labels": (r: Row, s: number) => isSideTalk(r.said, s, scene(r), t),
  };
  console.log(`\n${id} (${spec.license}), ${numThreads} threads, threshold ${t.toFixed(3)} (at most ${(100 * RATE).toFixed(1)}% of training addressed rows ignored, out of fold)`);
  console.log(`${"split / mode".padEnd(46)}${"AUC".padStart(7)}${"false ign".padStart(10)}${"caught".padStart(8)}${"prec".padStart(7)}${"you".padStart(7)}${"other".padStart(7)}`);
  const out: Record<string, unknown> = {};
  for (const split of splits) {
    const idx = all.map((_, i) => i).filter((i) => all[i]!.split === split);
    const a = auc(idx.filter((i) => all[i]!.side).map((i) => score[i]!), idx.filter((i) => !all[i]!.side).map((i) => score[i]!));
    for (const [mode, judge] of Object.entries(modes)) {
      const ign = idx.map((i) => judge(all[i]!, score[i]!));
      const r = rates(idx.map((i) => all[i]!.side), ign);
      const by = (who: string) => rates(idx.map((i) => all[i]!.side && all[i]!.speaker === who), idx.map((i, k) => ign[k]! && all[i]!.speaker === who)).caught;
      out[`${split} ${mode}`] = { auc: a, ...r, caughtYou: by("you"), caughtOther: by("other") };
      console.log(`${`${split === "train" ? "train (out of fold)" : `test ${split}`} ${mode}`.padEnd(46)}${a.toFixed(3).padStart(7)}${pct(r.falseIgnore).padStart(10)}${pct(r.caught).padStart(8)}${pct(r.precision)}${pct(by("you"))}${pct(by("other"))}`);
    }
  }
  const missed = all.filter((r, i) => r.split !== "train" && !r.side && modes["rules, voiceprint labels"](r, score[i]!)).map((r) => `${r.lang} ${r.speaker}: ${r.said}`);
  if (missed.length) console.log(`addressed sentences ignored in the test splits (voiceprint labels): ${missed.join(" | ")}`);
  const lat = { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) };
  console.log(`embedding ms per sentence (worker round trip, p50/p95): ${lat.p50.toFixed(1)}/${lat.p95.toFixed(1)}`);
  report[id] = { license: spec.license, threshold: t, results: out, latencyMs: lat, missed };

  if (args.write && id === SHIPPED) {
    const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
    const file = new URL("../../../packages/shared/src/speech/addressee-head.ts", import.meta.url);
    writeFileSync(file, `// Written by tools/addressee (pnpm addressee:eval --write) on ${new Date().toISOString().slice(0, 10)}: the logistic
// head over ${spec.repo}'s sentence embeddings, fitted on its training
// split, and the threshold that ignored at most ${(100 * RATE).toFixed(1)}% of that split's addressed
// sentences out of fold. Do not edit by hand.
export const HEAD = {
  model: "addressee-mpnet-multi-int8",
  threshold: ${r5(t)},
  b: ${r5(head.b)},
  w: [${head.w.map(r5).join(", ")}],
};
`);
    console.log(`wrote ${file.pathname}`);
  }
}
if (args.json) writeFileSync(args.json, JSON.stringify({ date: new Date().toISOString(), device: device.cpu, numThreads, rate: RATE, report }, null, 2));
await worker.terminate();
