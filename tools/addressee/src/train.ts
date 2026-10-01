// Trains the user's own side talk head on the synthetic set plus the agent's
// judgment log (Settings, Side talk, "Keep a judgment log"), and writes it to
// the agent's data dir (HEAD_FILE), never over the shipped head in the repo.
//   pnpm addressee:train [--rate 0.01] [--dry]
// OPENLIVE_HOME points it at another OpenLive home, as the agent. The sentence
// model is the one the app downloaded there; nothing else is fetched.
//
// A log row's label is the user's correction when there is one ("Send it":
// addressed, "Not for you": side talk), else what happened to it: answered
// (judging only, or judged addressed) is addressed, dropped and never sent is
// side talk. A correction counts LABELLED_WEIGHT synthetic rows, an unmarked
// row IMPLICIT_WEIGHT: a drop nobody undid partly repeats the model's own call.
// Log rows are scored out of fold, a sentence's repeats always in one fold, with
// the whole synthetic training split trained on in every fold. The threshold
// is the one ignoring at most --rate of the user's own addressed log sentences
// (voiceprint "you" or off), out of fold. The runtime takes the head only when
// `eval.pass`: at least MIN_TO such sentences and MIN_SIDE side talk ones, more
// side talk caught than the shipped head at the same false-ignore rate, and no
// more than --rate (or the shipped head's share, if higher) of either synthetic
// held-out split's addressed sentences ignored.
import { renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { featureVector, FEATURES, isSideTalk, sideScore, type Feats, type Scene } from "../../../packages/shared/src/speech/addressee";
import { HEAD } from "../../../packages/shared/src/speech/addressee-head";
import { ADDRESSEE_MODEL, HEAD_FILE, LOG_FILE, readLog, type PersonalHead } from "../../../services/agent/src/voice/addressee";
import { engineInstalled } from "../../../services/agent/src/voice/native-models";
import { embed } from "../../../services/agent/src/voice/native";
import { auc, fit, outOfFold, rates, thresholdAt } from "./head";
import { synthetic } from "./data";

const { values: args } = parseArgs({ options: { rate: { type: "string" }, dry: { type: "boolean" } } });
const RATE = Number(args.rate ?? 0.01);
const LABELLED_WEIGHT = 4, IMPLICIT_WEIGHT = 1;
const MIN_TO = 100, MIN_SIDE = 20, K = 5;

if (!engineInstalled(ADDRESSEE_MODEL)) {
  console.log(`The side talk model is not in this OpenLive home: download it in Settings, Voice, Side talk (or set OPENLIVE_HOME).`);
  process.exit(1);
}

interface Item { text: string; side: boolean; scene: Scene; feats?: Feats; weight: number; fold: number; log: boolean; labelled: boolean; split?: string }
const syn = synthetic();
const log = [...readLog().values()];
console.log(`${LOG_FILE}: ${log.length} judged, ${log.filter((e) => e.label).length} marked by you`);

// Same sentence, same fold: a repeated phrase must not be scored by a head that saw it. O(length).
const foldOf = (text: string) => { let h = 5381; for (const c of text.toLowerCase().trim()) h = (h * 33 + c.charCodeAt(0)) >>> 0; return h % K; };
const items: Item[] = [
  ...syn.map((r) => ({ text: r.said, side: r.side, scene: { reply: r.reply, speaker: r.speaker }, weight: 1, fold: -1, log: false, labelled: true, split: r.split })),
  ...log.map((e) => ({
    text: e.text, side: e.label ? e.label === "side" : e.side && e.mode === "ignore", scene: { reply: e.reply, speaker: e.speaker }, feats: e.feats,
    weight: e.label ? LABELLED_WEIGHT : IMPLICIT_WEIGHT, fold: foldOf(e.text), log: true, labelled: !!e.label,
  })),
];

// Embeddings through the agent's own worker and model, each distinct sentence once.
const cache = new Map<string, Float32Array>();
const t0 = performance.now();
for (const it of items) if (!cache.has(it.text)) cache.set(it.text, await embed(ADDRESSEE_MODEL, it.text));
console.log(`${cache.size} sentences embedded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// Each feature standardized on the log rows that have it; a missing one (and
// every synthetic row's) sits at the mean, adding nothing. O(rows x features).
const vecs = items.map((it) => (it.feats ? featureVector(it.feats) : FEATURES.map(() => null)));
const mean: number[] = [], sd: number[] = [];
FEATURES.forEach((_, j) => {
  const v = vecs.map((x) => x[j]).filter((x): x is number => x != null);
  const m = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  const s = v.length ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) : 0;
  mean.push(m); sd.push(s > 1e-6 ? s : 1);
});
const std = vecs.map((x) => x.map((v, j) => (v == null ? 0 : (v - mean[j]!) / sd[j]!)));

const trained = items.map((it, i) => i).filter((i) => items[i]!.log || items[i]!.split === "train");
const X = { text: trained.map((i) => cache.get(items[i]!.text)!), full: trained.map((i) => [...cache.get(items[i]!.text)!, ...std[i]!]) };
const y = trained.map((i) => Number(items[i]!.side)), wt = trained.map((i) => items[i]!.weight), fold = trained.map((i) => items[i]!.fold);
const logAt = trained.filter((i) => items[i]!.log);
const logIdx = trained.map((i, k) => (items[i]!.log ? k : -1)).filter((k) => k >= 0);

// Rows a rule decides (the agent asked back, the app named) leave the threshold's count, as in run.ts.
const ruled = (it: Item) => !isSideTalk(it.text, Infinity, it.scene, 0);
const own = (it: Item) => !it.side && !ruled(it) && (!it.scene.speaker || it.scene.speaker === "you");
const pct = (x: number) => `${(100 * x).toFixed(1)}%`.padStart(7);

/** The operating point of `scores` (one per log row) on the log: threshold from the user's own addressed rows. */
function operate(scores: number[], threshold?: number) {
  const side = logAt.map((i) => items[i]!.side);
  const t = threshold ?? thresholdAt(scores.filter((_, k) => own(items[logAt[k]!]!)), RATE);
  const r = rates(side, logAt.map((i, k) => isSideTalk(items[i]!.text, scores[k]!, items[i]!.scene, t)));
  return { t, auc: auc(scores.filter((_, k) => side[k]), scores.filter((_, k) => !side[k])), ...r };
}

const nOwn = logAt.filter((i) => own(items[i]!)).length, nSide = logAt.filter((i) => items[i]!.side).length;
const shippedScores = logAt.map((i) => sideScore(cache.get(items[i]!.text)!, HEAD));
const results: Record<string, ReturnType<typeof operate>> = {};
let chosen: "text" | "full" = "text";
if (logAt.length >= 2 * K) {
  results["shipped head"] = operate(shippedScores);
  results["shipped head, its own threshold"] = operate(shippedScores, HEAD.threshold);
  for (const v of ["text", "full"] as const) {
    const s = outOfFold(X[v], y, K, fold, wt);
    results[v === "text" ? "yours, words only" : "yours, words + sound"] = operate(logIdx.map((k) => s[k]!));
  }
  if (results["yours, words + sound"]!.caught > results["yours, words only"]!.caught) chosen = "full";
  console.log(`\nOn your log, out of fold (${logAt.length} sentences: ${nOwn} addressed by you and not decided by a rule, ${nSide} side talk):`);
  console.log(`${"head".padEnd(34)}${"AUC".padStart(7)}${"false ign".padStart(10)}${"caught".padStart(8)}${"prec".padStart(7)}${"thresh".padStart(8)}`);
  for (const [k, r] of Object.entries(results)) console.log(`${k.padEnd(34)}${r.auc.toFixed(3).padStart(7)}${pct(r.falseIgnore).padStart(10)}${pct(r.caught).padStart(8)}${pct(r.precision)}${r.t.toFixed(2).padStart(8)}`);
} else console.log("\nToo few logged sentences to score out of fold: the head below is fitted, but cannot pass.");

// The head itself: every trained row, the chosen inputs.
const h = fit(X[chosen], y, wt);
const d = HEAD.w.length;
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const best = results[chosen === "full" ? "yours, words + sound" : "yours, words only"];
const shippedAtRate = results["shipped head"];
const head: PersonalHead = {
  model: ADDRESSEE_MODEL.id, threshold: r5(best?.t ?? Infinity), b: r5(h.b), w: h.w.slice(0, d).map(r5),
  ...(chosen === "full" && { feats: { mean: mean.map(r5), sd: sd.map(r5), w: h.w.slice(d).map(r5) } }),
  eval: { pass: false },
};

// The held-out synthetic splits, judged on words alone (they have no sound), by
// the new head and the shipped one. A log in one language must not buy its
// catch with addressed sentences ignored in the others.
console.log(`\nSynthetic held-out splits, words only (${chosen === "full" ? "words + sound" : "words only"} head, threshold ${head.threshold}):`);
const synthetics: Record<string, { auc: number; falseIgnore: number; shippedFalseIgnore: number }> = {};
for (const split of ["en", "multi"]) {
  const at = items.map((it, i) => i).filter((i) => items[i]!.split === split);
  const judged = (hd: typeof HEAD | PersonalHead) => {
    const s = at.map((i) => sideScore(cache.get(items[i]!.text)!, hd));
    const r = rates(at.map((i) => items[i]!.side), at.map((i, k) => isSideTalk(items[i]!.text, s[k]!, items[i]!.scene, hd.threshold)));
    return { auc: auc(s.filter((_, k) => items[at[k]!]!.side), s.filter((_, k) => !items[at[k]!]!.side)), ...r };
  };
  const r = judged(head), shipped = judged(HEAD);
  synthetics[split] = { ...r, shippedFalseIgnore: shipped.falseIgnore };
  console.log(`${`test ${split}`.padEnd(34)}${r.auc.toFixed(3).padStart(7)}${pct(r.falseIgnore).padStart(10)}${pct(r.caught).padStart(8)}${pct(r.precision)}`);
  console.log(`${`test ${split}, shipped head`.padEnd(34)}${shipped.auc.toFixed(3).padStart(7)}${pct(shipped.falseIgnore).padStart(10)}${pct(shipped.caught).padStart(8)}${pct(shipped.precision)}`);
}
const regressed = Object.entries(synthetics).find(([, r]) => r.falseIgnore > Math.max(RATE, r.shippedFalseIgnore));
const why = nOwn < MIN_TO ? `needs ${MIN_TO} of your addressed sentences logged (has ${nOwn})`
  : nSide < MIN_SIDE ? `needs ${MIN_SIDE} side talk sentences logged (has ${nSide})`
    : best!.falseIgnore > RATE ? `ignored ${pct(best!.falseIgnore).trim()} of your addressed sentences`
      : best!.caught <= shippedAtRate!.caught ? "caught no more side talk than the shipped head"
        : regressed ? `ignored ${pct(regressed[1].falseIgnore).trim()} of the synthetic ${regressed[0]} split's addressed sentences, more than the shipped head` : "";
head.eval.pass = !why;
if (chosen === "full") console.log(`\nSound weights (log-odds per standard deviation): ${FEATURES.map((f, j) => `${f} ${head.feats!.w[j]!.toFixed(2)}`).join(", ")}`);
console.log(`\n${why ? `Does not pass: ${why}. The shipped head keeps judging.` : "Passes: the agent judges with it from the next sentence."}`);

if (args.dry) process.exit(0);
Object.assign(head.eval, { date: new Date().toISOString(), rate: RATE, why, log: results, synthetic: synthetics, n: { log: logAt.length, own: nOwn, side: nSide } });
writeFileSync(`${HEAD_FILE}.tmp`, JSON.stringify(head));
renameSync(`${HEAD_FILE}.tmp`, HEAD_FILE);
console.log(`wrote ${HEAD_FILE}`);
process.exit(0);
