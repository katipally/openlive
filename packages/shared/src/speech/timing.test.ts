import { expect, test } from "vitest";
import { normalizeAligned } from "./normalize";
import { captionOnsets, captionWords, heardOnsets, heardText, paceWords, placeWords, spokenWords, tokenOnsets, wordsHeard } from "./timing";

const words = (text: string) => captionWords(text).map(([a, b]) => text.slice(a, b));
const spoken = (caption: string, lang = "en") => {
  const { said, from } = normalizeAligned(caption, lang);
  return spokenWords(caption, said, from);
};

test("captionWords: spaces split words; each Chinese or Japanese character is one", () => {
  expect(words("Hello, world.")).toEqual(["Hello,", "world."]);
  expect(words("你好，世界。")).toEqual(["你", "好，", "世", "界。"]);
  expect(words("コーヒーを3杯")).toEqual(["コ", "ー", "ヒ", "ー", "を", "3", "杯"]);
  expect(words("用Python写代码")).toEqual(["用", "Python", "写", "代", "码"]);
  expect(words("안녕하세요, 반갑습니다.")).toEqual(["안녕하세요,", "반갑습니다."]);
  expect(words("")).toEqual([]);
  expect(words("   ")).toEqual([]);
});

test("spokenWords: a number weighs what it takes to say, and belongs to the word it was written as", () => {
  const w = spoken("It costs $1,200, sadly.");
  // "It costs one thousand two hundred dollars, sadly."
  expect(w.map((x) => x.unit)).toEqual([0, 1, 2, 2, 2, 2, 2, 3]);
  expect(w.filter((x) => x.unit === 2).reduce((s, x) => s + x.weight, 0)).toBe("onethousandtwohundreddollars".length);
  expect(w.map((x) => x.pause)).toEqual([false, false, false, false, false, false, true, true]);
  const zh = spoken("我有3只猫。", "zh"); // 我有三只猫。
  expect(zh.map((x) => x.unit)).toEqual([0, 1, 2, 3, 4]);
  expect(zh.at(-1)!.pause).toBe(true);
});

test("paceWords: onsets by weight over the length, evenly when nothing weighs", () => {
  const w = spoken("a bb cccc");
  expect(paceWords(w, 700)).toEqual([0, 100, 300]);
  expect(paceWords(spoken("- - -"), 300)).toEqual([0, 100, 200]);
  expect(paceWords([], 500)).toEqual([]);
});

/** Voice-like audio at 24 kHz: a tone for each [startMs, endMs), silence between. */
function audio(spans: [number, number][], totalMs: number): Float32Array {
  const rate = 24000, out = new Float32Array((totalMs * rate) / 1000);
  for (const [a, b] of spans) for (let i = (a * rate) / 1000; i < (b * rate) / 1000; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 180 * i) / rate);
  return out;
}

test("placeWords: pauses land on the punctuation, words share the voiced time between", () => {
  // "one two, three four. five": voiced 100-700, 900-1500, 1700-2000.
  const w = spoken("one two, three four. five");
  const at = placeWords(w, audio([[100, 700], [900, 1500], [1700, 2000]], 2200), 24000);
  expect(at[0]).toBe(100);
  expect(at[2]).toBe(900); // after the comma's pause, not where the weights alone put it
  expect(at[4]).toBe(1700);
  expect(at[1]).toBeGreaterThan(300);
  expect(at[1]).toBeLessThan(500);
  // A stop inside a phrase (80 ms, under a pause) is not a boundary.
  const run = placeWords(spoken("alpha beta gamma"), audio([[0, 400], [480, 900]], 900), 24000);
  expect(run[0]).toBe(0);
  expect(run[1]).toBeGreaterThan(200);
  expect(run[2]).toBeGreaterThan(run[1]!);
});

test("placeWords: silence, one word, no words, and a very long chunk", () => {
  const silent = new Float32Array(24000);
  expect(placeWords(spoken("a bb"), silent, 24000)).toEqual([0, 1000 / 3]);
  expect(placeWords(spoken("hello"), audio([[250, 600]], 700), 24000)).toEqual([250]);
  expect(placeWords([], audio([[0, 500]], 500), 24000)).toEqual([]);
  // 400 words, a pause after every sentence of 8: linear time, onsets in order.
  const text = Array.from({ length: 50 }, () => "the quick brown fox jumps over lazy dogs.").join(" ");
  const spans = Array.from({ length: 50 }, (_, i) => [i * 2000, i * 2000 + 1700] as [number, number]);
  const w = spoken(text);
  const t0 = performance.now();
  const at = placeWords(w, audio(spans, 100_000), 24000);
  expect(performance.now() - t0).toBeLessThan(1000);
  for (let s = 0; s < 50; s++) expect(at[s * 8]).toBe(s * 2000);
  for (let i = 1; i < at.length; i++) expect(at[i]!).toBeGreaterThanOrEqual(at[i - 1]!);
});

test("captionOnsets: a caption word shows with its first spoken word, an unsaid one with the next", () => {
  const caption = "Costs $1,200 🎉 today";
  const w = spoken(caption); // Costs one thousand two hundred dollars today
  const at = w.map((_, i) => i * 100);
  expect(captionOnsets(caption, w, at)).toEqual([0, 100, 600, 600]);
  expect(captionOnsets("🎉", [], [])).toEqual([0]);
});

test("tokenOnsets: a word starts with the token its first letter is in, spaces or none", () => {
  // Parakeet 0.6B v2 on "So I was thinking..." (sherpa-onnx 1.13.8, 2026-09-25).
  const text = "So I was thinking we could move.";
  expect(tokenOnsets(text, [" So", " I", " was", " think", "ing", " we", " could", " mo", "ve", "."], [0, 0.32, 0.48, 0.64, 0.8, 0.96, 1.12, 1.28, 1.44, 1.52]))
    .toEqual([0, 320, 480, 640, 960, 1120, 1280]);
  // Nemotron 3.5 on Chinese: a token per character, a bare space first, punctuation of its own.
  expect(tokenOnsets("我们，请", [" ", "我", "们", "，", "请"], [0.64, 0.64, 0.8, 0.96, 1.2], -300)).toEqual([340, 500, 900]);
  // The engine's spacing need not match the text's.
  expect(tokenOnsets("don't stop", [" don", "'", "t", " st", "op"], [1, 1.1, 1.2, 1.5, 1.6])).toEqual([1000, 1500]);
});

test("tokenOnsets: no times, no words, and a long transcript", () => {
  expect(tokenOnsets("so I was", [" So", " I", " was"], [])).toBeUndefined(); // moonshine, canary
  expect(tokenOnsets("so", [], [])).toBeUndefined();
  expect(tokenOnsets("", [], [])).toEqual([]);
  expect(tokenOnsets("  ", [" "], [0.5])).toEqual([]);
  const tokens = Array.from({ length: 20_000 }, (_, i) => ` w${i}`);
  const text = tokens.join("").trim();
  const t0 = performance.now();
  const at = tokenOnsets(text, tokens, tokens.map((_, i) => i / 10))!;
  expect(performance.now() - t0).toBeLessThan(500);
  expect(at.length).toBe(20_000);
  expect(at[19_999]).toBeCloseTo(1_999_900);
});

test("heardOnsets: the speaker's own pauses place the words, from the first sample", () => {
  const text = "one two, three";
  const at = heardOnsets(text, normalizeAligned(text, "en"), audio([[800, 1300], [1500, 1900]], 2100), 24000);
  expect(at[0]).toBe(800);
  expect(at[2]).toBe(1500);
  expect(heardOnsets("", normalizeAligned("", "en"), audio([[0, 100]], 100), 24000)).toEqual([]);
  expect(heardOnsets("你好", normalizeAligned("你好", "zh"), audio([[200, 700]], 800), 24000)).toHaveLength(2);
});

test("wordsHeard: the words begun by a time, cut short on barge-in", () => {
  const at = [0, 250, 250, 900];
  expect(wordsHeard(at, 0)).toBe(1);
  expect(wordsHeard(at, 249)).toBe(1);
  expect(wordsHeard(at, 250)).toBe(3);
  expect(wordsHeard(at, 5000)).toBe(4);
  // Barge-in at 600 ms: the reveal stops with the three words voiced by then.
  expect(wordsHeard(at, 600)).toBe(3);
  expect(wordsHeard([], 10)).toBe(Infinity);
});

test("captionOnsets: a caption the voice reads much longer than it is written still reveals word by word", () => {
  // Three written words, a table bar between: spoken "one thousand ... cents, September ... twenty-six".
  const caption = "$1,200.50 | 2026-09-25";
  const w = spoken(caption);
  const on = captionOnsets(caption, w, paceWords(w, 4000));
  expect(on).toHaveLength(3);
  expect(on[0]).toBe(0);
  expect(on[2]!).toBeGreaterThan(1500); // the date starts once the money is said
  expect(on[1]).toBe(on[2]); // the bar is a pause, shown with the next word
  expect(wordsHeard(on, 100)).toBe(1);
});

test("heardText: the caption up to the last word begun, whole once it all has", () => {
  const text = "It costs $1,200 today.";
  const at = [0, 200, 400, 2200];
  expect(heardText(text, at, 0)).toBe("It");
  expect(heardText(text, at, 1000)).toBe("It costs $1,200");
  expect(heardText(text, at, 9000)).toBe(text);
  expect(heardText(text, [], 0)).toBe(text);
  expect(heardText("", [], 0)).toBe("");
  expect(heardText("你好世界", [0, 100, 200, 300], 150)).toBe("你好");
});
