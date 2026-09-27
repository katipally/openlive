import { expect, it } from "vitest";
import { askedBack, featureVector, FEATURES, isSideTalk, OTHER_SHIFT, sideScore, speechStats, type Feats } from "./addressee";
import { HEAD } from "./addressee-head";

it("hears a reply that ends on a question, in any script", () => {
  for (const r of ["Do you want me to push it?", "¿Quieres que lo suba?", "要不要我推上去？", "Shall I? ", 'He asked, "ready?"']) expect(askedBack(r)).toBe(true);
  for (const r of ["", "Done.", "Is it? No. It is done."]) expect(askedBack(r)).toBe(false);
});

it("scores an embedding by the head: bias plus weights", () => {
  expect(sideScore([1, 2], { w: [0.5, -1], b: 0.25 })).toBeCloseTo(-1.25);
});

it("calls side talk only past the threshold, sooner for another voice", () => {
  const t = 1;
  expect(isSideTalk("did you feed the dog", 1.5, { reply: "" }, t)).toBe(true);
  expect(isSideTalk("did you feed the dog", 0.5, { reply: "" }, t)).toBe(false);
  expect(isSideTalk("did you feed the dog", 0.5, { reply: "", speaker: "you" }, t)).toBe(false);
  expect(isSideTalk("did you feed the dog", t - OTHER_SHIFT + 0.1, { reply: "", speaker: "other 1" }, t)).toBe(true);
});

it("never calls the answer to the agent's question side talk, unless another voice gives it, nor a sentence naming the app", () => {
  expect(isSideTalk("Yes.", 9, { reply: "Should I push it?" }, 1)).toBe(false);
  expect(isSideTalk("Yes.", 9, { reply: "Should I push it?", speaker: "other 2" }, 1)).toBe(true);
  expect(isSideTalk("Hey OpenLive, what time is it", 9, { reply: "" }, 1)).toBe(false);
});

it("ships a fitted head for the addressee model's 768-dimensional embeddings", () => {
  expect(HEAD.model).toBe("addressee-mpnet-multi-int8");
  expect(HEAD.w).toHaveLength(768);
  expect(Number.isFinite(HEAD.threshold)).toBe(true);
});

const tone = (hz: number, s: number, amp: number) => Float32Array.from({ length: s * 16000 }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / 16000));
const NONE: Feats = { relDb: null, energySd: null, pitch: null, pitchSd: null, gapS: null, cut: 0, change: null, durS: 1, rate: null };

it("reads a voice's level, pitch and rate from its audio", () => {
  const s = speechStats(tone(200, 2, 0.1), "one two three four");
  expect(s.db).toBeCloseTo(20 * Math.log10(0.1 / Math.SQRT2), 0);
  expect(s.pitch).toBeCloseTo(12, 0); // 200 Hz is an octave over 100
  expect(s.pitchSd).toBeLessThan(0.5);
  expect(s.rate).toBeCloseTo(2, 0);
  expect(speechStats(tone(200, 2, 0.1), "今日はいい天気ですね").rate).toBeGreaterThan(0); // words without spaces
  expect(speechStats(tone(200, 0.05, 0.1), "hi")).toMatchObject({ pitch: null, rate: null }); // too little to say
  expect(speechStats(new Float32Array(0), "").db).toBeNull();
});

it("reads only the last 8 s of a long segment", () => {
  const long = new Float32Array(60 * 16000);
  long.set(tone(150, 8, 0.2), 52 * 16000);
  expect(speechStats(long, "").pitch).toBeCloseTo(12 * Math.log2(1.5), 0);
});

it("puts gaps and lengths on a log scale and leaves the unknown out", () => {
  const v = featureVector({ ...NONE, gapS: 1e6, durS: 0 });
  expect(v).toHaveLength(FEATURES.length);
  expect(v[FEATURES.indexOf("gapS")]).toBeCloseTo(Math.log1p(60));
  expect(v[FEATURES.indexOf("durS")]).toBeCloseTo(Math.log(0.1));
  expect(v[FEATURES.indexOf("relDb")]).toBeNull();
});

it("adds a personal head's standardized features, and nothing for a missing one", () => {
  const w = FEATURES.map((k) => (k === "relDb" ? -1 : 0));
  const head = { w: [0], b: 0, feats: { mean: FEATURES.map(() => 0), sd: FEATURES.map((k) => (k === "relDb" ? 2 : 1)), w } };
  expect(sideScore([0], head, { ...NONE, relDb: -6 })).toBeCloseTo(3);
  expect(sideScore([0], head, NONE)).toBe(0);
  expect(sideScore([0], head)).toBe(0);
});
