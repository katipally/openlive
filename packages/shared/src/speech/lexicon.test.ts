// The pronunciation dictionary: what matches, what wins, and that a respelling
// reaches the voice exactly as the user typed it.
import { expect, test } from "vitest";
import { compileLexicon, type LexiconEntry } from "./lexicon";
import { normalizeSpeech } from "./normalize";

const entry = (from: string, to: string, more: Partial<LexiconEntry> = {}): LexiconEntry => ({ from, to, lang: "", matchCase: false, wholeWord: true, ...more });
const say = (text: string, entries: LexiconEntry[], lang = "en") => normalizeSpeech(text, lang, compileLexicon(entries, lang));

test("no entries, no matcher", () => {
  expect(compileLexicon([], "en")).toBeNull();
  expect(compileLexicon([entry("Nginx", "engine x", { lang: "fr" })], "en")).toBeNull();
  expect(say("Nginx is up", [])).toBe("Nginx is up");
});

test("whole words by default, inside words when asked, any case unless exact", () => {
  const e = [entry("Kai", "Kye")];
  expect(say("Kai and KAI and kai", e)).toBe("Kye and Kye and Kye");
  expect(say("Kaiser", e)).toBe("Kaiser");
  expect(say("Kaiser", [entry("Kai", "Kye", { wholeWord: false })])).toBe("Kyeser");
  expect(say("iOS and IOS", [entry("iOS", "eye oh ess", { matchCase: true })])).toBe("eye oh ess and IOS");
});

test("the longest key wins, exact case before any case, the last duplicate wins", () => {
  expect(say("GitHub Actions on GitHub", [entry("GitHub", "git hub"), entry("GitHub Actions", "git hub actions")])).toBe("git hub actions on git hub");
  expect(say("Sam and SAM", [entry("sam", "sahm"), entry("SAM", "S A M", { matchCase: true })])).toBe("sahm and S A M");
  expect(say("Nginx", [entry("nginx", "first"), entry("Nginx", "engine x")])).toBe("engine x");
});

test("keys match the text as written, and respellings are spoken as typed", () => {
  // Before normalization would spell GPU or read the 3 of S3.
  expect(say("the GPU on S3", [entry("GPU", "graphics card"), entry("S3", "ess three")])).toBe("the graphics card on ess three");
  expect(say("Web3 at 5%", [entry("Web3", "web 3")])).toBe("web 3 at five percent");
  expect(say("say .NET and C++", [entry(".NET", "dot net"), entry("C++", "see plus plus")])).toBe("say dot net and see plus plus");
  expect(say("Ok, skip um this", [entry("um", "")])).toBe("Ok, skip this");
});

test("per-language entries, and whole words in scripts without spaces", () => {
  const e = [entry("OpenLive", "오픈라이브", { lang: "ko" }), entry("北京", "Běijīng", { lang: "zh" })];
  expect(say("OpenLive를 켜요", e, "ko")).toBe("오픈라이브를 켜요");
  expect(say("OpenLive", e, "en")).toBe("OpenLive");
  expect(say("我在北京住", e, "zh")).toBe("我在Běijīng住");
  expect(say("Café Olé", [entry("café", "kah-fay")], "fr")).toBe("kah-fay Olé");
});

test("a thousand entries compile once and match fast", () => {
  const many = Array.from({ length: 1000 }, (_, i) => entry(`name${i}x`, `said ${i}`));
  const t0 = performance.now();
  const lex = compileLexicon(many, "en")!;
  const text = "name1x and name999x and name500x ".repeat(2000);
  const out = normalizeSpeech(text, "en", lex);
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(out.startsWith("said 1 and said 999 and said 500")).toBe(true); // respellings are not normalized
});
