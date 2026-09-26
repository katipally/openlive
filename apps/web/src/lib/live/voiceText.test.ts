// Guards the non-trivial voice string logic — chunk merging (voice stability),
// junk filtering (turn detection), and TTS scrubbing.
import assert from "node:assert";
import { test } from "vitest";
import { isJunk, isBackchannel, endsMidThought, stripMarkdown, toSpeech, speechPieces, SentenceChunker, MIN_TTS_CHARS, FIRST_TTS_CHARS, MAX_CHUNK_CHARS, splitLong, estimateSpeechMs, captionWindow } from "./voiceText.ts";
import { captionWords } from "@openlive/shared/speech/timing";

test("isJunk: silence artifacts dropped, real short answers kept", () => {
  assert.equal(isJunk("thank you for watching"), true);
  assert.equal(isJunk("you"), true);
  assert.equal(isJunk("i"), true);            // < 2 chars
  assert.equal(isJunk("okay"), false);        // real short answer
  assert.equal(isJunk("yeah"), false);
  assert.equal(isJunk("so"), false);
  assert.equal(isJunk("no"), false);
  // more Whisper silence-hallucinations dropped; real short turns kept.
  assert.equal(isJunk("thanks for watching!"), true);
  assert.equal(isJunk("please subscribe"), true);
  assert.equal(isJunk("bye"), false);
  assert.equal(isJunk("DCEN"), false);        // a real short answer / term
});

test("endsMidThought: trailing filler = keep listening; a complete clause = go", () => {
  assert.equal(endsMidThought("i want to"), true);
  assert.equal(endsMidThought("set it to 250"), false);
  assert.equal(endsMidThought("what's the duty cycle at"), true);   // trails on "at"
  assert.equal(endsMidThought("it's 240 volts"), false);            // complete, ends on a real word
  assert.equal(endsMidThought("connect the ground clamp to the"), true); // trails on "the"
  assert.equal(endsMidThought("What time is it?"), false);          // a question is finished, whatever its last word
  assert.equal(endsMidThought("What are you working on?"), false);
  assert.equal(endsMidThought("I want to..."), true);
  assert.equal(endsMidThought("what time is it"), false);           // unpunctuated streaming final
  assert.equal(endsMidThought("what is this"), false);
});

test("stripMarkdown: symbols gone, citations gone, photo-narration scrubbed", () => {
  assert.equal(stripMarkdown("Set it to **250** [p.18]."), "Set it to 250 .");
  assert.equal(stripMarkdown("In the image I see a dial"), "here I see a dial");
  assert.equal(stripMarkdown("The photo shows a knob"), "this shows a knob");
  assert.ok(!/image|photo|picture/i.test(stripMarkdown("Look at the picture and the image")));
  // Provider control-token noise (MiniMax leaks "[e[") is stripped from spoken text.
  assert.equal(stripMarkdown("Hey, what's up?[e["), "Hey, what's up?");
  assert.equal(stripMarkdown("Yeah, I'm here.[e[ [e["), "Yeah, I'm here.");
});

test("stripMarkdown: the transcript keeps file names, URLs and code spans as written", () => {
  assert.equal(stripMarkdown("I updated src/components/Foo.tsx for you"), "I updated src/components/Foo.tsx for you");
  assert.equal(stripMarkdown("open `my_config.json` or my_notes.md now"), "open my_config.json or my_notes.md now");
  assert.equal(stripMarkdown("run `a **b** # c` then **bold** and _it_"), "run a **b** # c then bold and it");
  assert.equal(stripMarkdown("see https://example.com/a_b#top for more"), "see https://example.com/a_b#top for more");
  assert.equal(stripMarkdown("see [the docs](https://example.com/docs)."), "see the docs.");
});

test("toSpeech: paths, file names and URLs are said as plain words", () => {
  assert.equal(toSpeech("I updated src/components/Foo.tsx for you"), "I updated Foo dot T S X for you");
  assert.equal(toSpeech("saved to app/main.py"), "saved to main dot P Y");
  assert.equal(toSpeech("You've got three files: alpha.txt, beta.md, and gamma.json."), "You've got three files: alpha dot T X T, beta dot M D, and gamma dot json.");
  assert.equal(toSpeech("see https://www.example.com/docs for more"), "see example dot com for more");
  assert.equal(toSpeech("visit docs.example.com today"), "visit docs dot example dot com today");
  // Plain prose passes through untouched; the golden set (packages/shared) covers the rest.
  for (const s of ["It's a lovely day, isn't it?", "Honestly, I think the second option is better."]) assert.equal(toSpeech(s), s);
});

// Streams `text` in pieces of `size` and returns every chunk the chunker emits.
function chunked(text: string, size: number, lang = "en"): string[] {
  const c = new SentenceChunker();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...c.push(text.slice(i, i + size), lang));
  const tail = c.flush();
  return tail ? [...out, tail] : out;
}

test("SentenceChunker: dots inside names, versions, URLs, decimals, abbreviations and code never split or drop text", () => {
  const replies = [
    "You've got three files: alpha.txt, beta.md, and gamma.json.",
    "The release is v0.2.4 and it is live on example.com right now, so go and try it.",
    "It ran at 3.5 times the speed, e.g. faster than Dr. Lee expected from the U.S. team.",
    "Call `obj.run(). then()` first, and read https://example.com/a.b?c=1 before you do anything else.",
  ];
  for (const text of replies) {
    for (const size of [1, 2, 3, 5, 7, 11, 100]) {
      const out = chunked(text, size);
      assert.equal(out.join(" "), text, `size ${size}`);
    }
  }
});

test("streaming: no number, date, price, version or address splits across chunks, so each chunk reads as the whole reply does", () => {
  const replies: [lang: string, text: string][] = [
    ["en", "It costs $1,200.50 now. Version v1.2.3 shipped on 2026-09-25 at 3:30 PM, e.g. for 15% of users. Call 555-123-4567 or mail ops@example.com. See No. 5 for the 3.5 GHz part."],
    ["en", "The 1990s were wild. About 10k people, i.e. roughly 3/4 of them, paid 12.5 USD. Dr. Lee said 5-10 minutes. It ran at 60 mph!"],
    ["de", "Am 3. Oktober 1990 kamen 1.500 Leute. Es kostet 12,50 € und dauert ca. 3,5 Stunden, z. B. bis 15:30 Uhr."],
    ["es", "Cuesta 12,50 € hoy. El 1º de mayo llegan 1.500 personas a las 15:30, p. ej. con un 50% de descuento."],
    ["zh", "我有3个苹果。2026年9月25日下午3:05，价格是¥12.5，打了15%的折扣，共1,200个。"],
  ];
  for (const [lang, text] of replies) {
    const join = lang === "zh" ? "" : " ";
    const whole = toSpeech(stripMarkdown(text), lang);
    for (const size of [1, 2, 3, 5, 8, 13, 400]) {
      const out = chunked(text, size, lang);
      assert.equal(out.join(join), text, `${lang} size ${size}`);
      assert.equal(out.map((c) => toSpeech(stripMarkdown(c), lang)).join(join), whole, `${lang} size ${size}`);
      assert.ok(!out.some((c) => /\b(?:No|\d)\.$/.test(c)), `${lang} size ${size}: ${out.join(" | ")}`);
    }
  }
});

test("speechPieces: a chunk that grows past what one engine call takes is cut at a word", () => {
  const prices = "They cost $1,234,567.89, $2,345,678.90, $3,456,789.01 and $4,567,890.12 in total.";
  const said = toSpeech(prices, "en");
  assert.ok(prices.length <= MAX_CHUNK_CHARS && said.length > 2 * MAX_CHUNK_CHARS);
  const pieces = speechPieces(said, "en");
  assert.ok(pieces.length > 1 && pieces.every((p) => p.length <= 2 * MAX_CHUNK_CHARS));
  assert.equal(pieces.join(" "), said);
  assert.deepEqual(speechPieces("Short.", "ja"), ["Short."]);
});

test("SentenceChunker: real sentence boundaries still split for streaming", () => {
  const text = "The first sentence is long enough to be spoken by itself right away. The second one follows it and is also long enough to go. Then the end.";
  for (const size of [1, 4, 9, 200]) {
    const out = chunked(text, size);
    assert.equal(out.join(" "), text);
    assert.ok(out.length >= 2, `size ${size} should stream in several chunks`);
    assert.ok(out.includes("The second one follows it and is also long enough to go."), `size ${size}`);
  }
});

test("SentenceChunker: a stray backtick does not hold back the rest of the reply", () => {
  const text = "Here is a ` stray tick in a sentence that is long enough to go. " + "Then another sentence arrives that is well over the bar in length. ".repeat(3);
  const c = new SentenceChunker();
  assert.ok(c.push(text).length >= 2);
});

test("SentenceChunker: full sentences emit; tiny trailing fragments merge, never alone", () => {
  const c = new SentenceChunker();
  const long = "This is a full first sentence that clears the length bar easily.";
  const out = c.push(long + " Yeah.");
  assert.equal(out.length, 1);                    // only the long one emits
  assert.ok(out[0]!.length >= MIN_TTS_CHARS);
  assert.equal(c.flush(), "Yeah.");               // the tiny bit is held for the tail
});

test("SentenceChunker: two short sentences merge on flush (no lone tiny fragment to TTS)", () => {
  const c = new SentenceChunker();
  const out = c.push("Hi. Yeah. ");
  assert.equal(out.length, 0);
  assert.equal(c.flush(), "Hi. Yeah.");
});

test("SentenceChunker: a first sentence with commas is never cut at one, it speaks whole when it ends", () => {
  const c = new SentenceChunker();
  const spoken: string[] = [];
  for (const d of ["The gas valve", ", which sits", " on the lower left, ", "controls the flow. ", "Turn it"]) spoken.push(...c.push(d));
  assert.deepEqual(spoken, ["The gas valve, which sits on the lower left, controls the flow."]);
});

test("SentenceChunker: a single short first sentence speaks whole on completion", () => {
  const c = new SentenceChunker();
  const out = c.push("The valve is on the left. ");
  assert.equal(out.length, 1);
  assert.equal(out[0], "The valve is on the left.");
});

test("SentenceChunker: an opening sentence with no early pause is never cut mid-clause", () => {
  const c = new SentenceChunker();
  const spoken: string[] = [];
  for (const d of ["I'll put ", "a simple labeled ", "diagram of the machine ", "on screen for you now. ", "Then we can go through it part by part."]) spoken.push(...c.push(d));
  assert.deepEqual(spoken, ["I'll put a simple labeled diagram of the machine on screen for you now."]);
});

test("SentenceChunker: the opening chunk always ends on a sentence boundary", () => {
  const replies = [
    "Sure, I can help with that, and it is quick. Yes.",
    "Okay so the thing you want to do first is open the settings panel and then pick voice.",
    "Right: the config lives in two places; the first one wins, always.",
    "Hi! " + "word ".repeat(30) + "done.",
  ];
  for (const text of replies) for (const size of [1, 3, 8, 500]) {
    const out = chunked(text, size);
    assert.equal(out.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " ").trim(), `${size}: ${text}`);
    assert.match(out[0]!, /[.!?]$/, `${size}: ${JSON.stringify(out)}`);
    assert.ok(out[0]!.length >= FIRST_TTS_CHARS || out.length === 1, `${size}: ${JSON.stringify(out)}`);
  }
});

test("SentenceChunker: after the first chunk, later short sentences hold to the stable MIN bar", () => {
  const c = new SentenceChunker();
  c.push("Okay, here we go. ");                    // first chunk released
  const out = c.push("Yes. ");                     // 4 chars, under MIN → held
  assert.equal(out.length, 0);
});

test("SentenceChunker: fenced code blocks are dropped from speech (incl. split across deltas)", () => {
  const c = new SentenceChunker();
  const spoken: string[] = [];
  // A fence that spans several deltas, with the ``` marker split at a delta boundary.
  for (const d of ["Here's the fix. ", "``", "`js\nconst x = arr[0];\nfoo();\n", "``", "` Done now."]) {
    spoken.push(...c.push(d));
  }
  const all = (spoken.join(" ") + " " + c.flush()).replace(/\s+/g, " ").trim();
  assert.ok(!all.includes("const x"), "code inside the fence must not be voiced");
  assert.ok(!all.includes("`"), "no stray backticks reach TTS");
  assert.ok(all.includes("Here's the fix"), "prose before the fence is kept");
  assert.ok(all.includes("Done now"), "prose after the fence is kept");
});

test("SentenceChunker: a flush before a tool voices the whole held tail, then the next step starts fresh", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("Let me look up the forecast for today."), []); // could still grow into a name
  assert.equal(c.flush(), "Let me look up the forecast for today.");
  assert.deepEqual(c.push("It is sunny all day in the city. "), ["It is sunny all day in the city."]); // fast first chunk again
});

test("SentenceChunker: the opening waits for a sentence of 24+ characters, then later chunks keep the MIN bar", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("Sure, "), []);
  assert.deepEqual(c.push("I can help with that, and "), []);  // a comma past the bar is no place to cut
  assert.deepEqual(c.push("it is quick. Yes. "), ["Sure, I can help with that, and it is quick."]);
  assert.equal(c.flush(), "Yes.");
  assert.deepEqual(new SentenceChunker().push("Sure. Okay! "), []); // too short to open on, held for the next sentence
  assert.deepEqual(new SentenceChunker().push("Sure thing, okay. "), []); // held for the next sentence
});

test("SentenceChunker: line breaks end a chunk, so a list without periods still streams", () => {
  const c = new SentenceChunker();
  const out = c.push("Here is what changed:\n- the parser handles empty input\n- the cache expires after an hour\n- logs are quieter\n");
  assert.ok(out.length >= 2, `got ${JSON.stringify(out)}`);
  assert.ok(out.every((x) => x.length <= MAX_CHUNK_CHARS));
});

test("SentenceChunker: text with no boundary at all never builds a chunk over the cap", () => {
  const words = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(" "); // ~13k chars, no punctuation
  for (const size of [1, 7, 64, 20_000]) {
    const out = chunked(words, size);
    assert.ok(out.every((x) => x.length <= MAX_CHUNK_CHARS + MIN_TTS_CHARS), `size ${size}`);
    assert.equal(out.join(" "), words, `size ${size}`);
  }
  const blob = "x".repeat(1000); // one "word" longer than the cap
  assert.ok(chunked(blob, 50).every((x) => x.length <= MAX_CHUNK_CHARS));
  assert.equal(chunked(blob, 50).join(""), blob);
  // A giant sentence arriving in one delta is cut too.
  assert.ok(new SentenceChunker().push(words + ". ").every((x) => x.length <= MAX_CHUNK_CHARS));
});

test("splitLong: word boundaries, empty input, and exact fits", () => {
  assert.deepEqual(splitLong(""), []);
  assert.deepEqual(splitLong("  hi  "), ["hi"]);
  assert.deepEqual(splitLong("a".repeat(MAX_CHUNK_CHARS)), ["a".repeat(MAX_CHUNK_CHARS)]);
  const two = `${"a".repeat(150)} ${"b".repeat(150)}`;
  assert.deepEqual(splitLong(two), ["a".repeat(150), "b".repeat(150)]);
});

test("estimateSpeechMs: scales with length, inversely with speed, at each engine's rate", () => {
  assert.equal(estimateSpeechMs("", "pocket"), 0);
  assert.equal(estimateSpeechMs("x".repeat(32), "pocket"), 2000);
  assert.equal(estimateSpeechMs("x".repeat(32), "pocket", 2), 1000);
  assert.equal(estimateSpeechMs("x".repeat(30), "kitten"), 3000);
  assert.equal(estimateSpeechMs("x".repeat(32), "kokoro"), 2000); // one-piece engines: exact duration is used instead
});

// ── languages other than English ────────────────────────────────────────────

// Like chunked(), in a language.
function chunkedIn(lang: string, text: string, size: number): string[] {
  const c = new SentenceChunker();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...c.push(text.slice(i, i + size), lang));
  const tail = c.flush();
  return tail ? [...out, tail] : out;
}

test("SentenceChunker: Chinese and Japanese end sentences with no space after, and drop nothing", () => {
  const zh = "好的。我检查了文件，并修复了登录页面的错误。现在可以再试一次吗？谢谢！";
  const out = chunkedIn("zh", zh, 3);
  assert.equal(out.join(""), zh);
  // "好的。" alone is under the opening bar, so it merges with the next sentence.
  assert.deepEqual(out, ["好的。我检查了文件，并修复了登录页面的错误。", "现在可以再试一次吗？谢谢！"]);
  const ja = "わかりました。ファイルを確認して、ログインページのバグを直しました。もう一度試してみてください。";
  const jaOut = chunkedIn("ja", ja, 4);
  assert.equal(jaOut.join(""), ja);
  assert.ok(jaOut.length >= 2 && jaOut.every((s) => /[。、]$/.test(s)), JSON.stringify(jaOut));
});

test("SentenceChunker: the Devanagari danda ends a sentence", () => {
  const hi = "ठीक है। मैंने फ़ाइल देखी और लॉगिन पेज की गलती ठीक कर दी। अब फिर से कोशिश करें।";
  const out = chunkedIn("hi", hi, 5);
  assert.equal(out.join(" "), hi);
  assert.ok(out.length >= 2 && out.every((s) => s.endsWith("।")), JSON.stringify(out));
});

test("SentenceChunker: an unspaced reply with no punctuation still never builds a chunk over the cap", () => {
  const zh = "我".repeat(500);
  const out = chunkedIn("zh", zh, 7);
  assert.equal(out.join(""), zh);
  assert.ok(out.every((s) => s.length <= 120), JSON.stringify(out.map((s) => s.length)));
});

test("SentenceChunker: English is unchanged by a CJK mark in the reply", () => {
  const text = "The word for thanks is 谢谢。 And that's all there is to it, really.";
  assert.equal(chunked(text, 4).join(" "), text);
});

test("splitLong: unspaced text cuts after a clause mark, else inside the run", () => {
  assert.deepEqual(splitLong("一二三，四五六七八", 6, false), ["一二三，", "四五六七八"]);
  assert.deepEqual(splitLong("一二三四五六七八", 6, false), ["一二三四五六", "七八"]);
});

test("endsMidThought: the English word list applies only to English", () => {
  assert.equal(endsMidThought("i want to", "en"), true);
  assert.equal(endsMidThought("quiero ir a", "es"), false);       // "a" is Spanish, not filler
  assert.equal(endsMidThought("je veux the", "fr"), false);
  assert.equal(endsMidThought("quiero ir al parque,", "es"), true); // a trailing comma still holds
  assert.equal(endsMidThought("明日は、", "ja"), true);
  assert.equal(endsMidThought("我想去...", "zh"), true);
  assert.equal(endsMidThought("明日は晴れです。", "ja"), false);
});

test("toSpeech: outside English the dot is said in the language", () => {
  assert.equal(toSpeech("revisa src/app/main.py ahora", "es"), "revisa main punto P Y ahora");
  assert.equal(toSpeech("ve a https://www.example.com/docs", "es"), "ve a example punto com");
  assert.equal(toSpeech("va sur example.com", "fr"), "va sur example point com");
  assert.equal(toSpeech("saved to app/main.py", "en"), "saved to main dot P Y");
});

test("isJunk: a one-syllable CJK answer is a turn, multilingual Whisper's silence lines are not", () => {
  assert.equal(isJunk("好"), false);
  assert.equal(isJunk("네"), false);
  assert.equal(isJunk("はい"), false);
  assert.equal(isJunk("हाँ"), false);
  assert.equal(isJunk("ご視聴ありがとうございました。"), true);
  assert.equal(isJunk("字幕由Amara.org社区提供"), true);
  assert.equal(isJunk("a"), true);
});

test("estimateSpeechMs: a language's own rate, the engine's in English", () => {
  assert.equal(estimateSpeechMs("x".repeat(9), "kokoro-native", 1, "zh"), 2000);
  assert.equal(estimateSpeechMs("x".repeat(14), "piper", 2, "ja"), 1000);
  assert.equal(estimateSpeechMs("x".repeat(32), "pocket", 1, "es"), 2000); // Spanish speaks at English's pace
  assert.equal(estimateSpeechMs("x".repeat(30), "kitten", 1, "en"), 3000);
});

test("captionWindow: the last words heard, five English words or about twelve characters wide", () => {
  const win = (text: string, heard: number) => captionWindow(text, captionWords(text), heard);
  const en = "one two three four five six seven";
  assert.equal(win(en, 1), "one");
  assert.equal(win(en, 3), "one two three");
  assert.equal(win(en, 7), "three four five six seven");
  assert.equal(win(en, 99), "three four five six seven");
  assert.equal(win(en, 0), "one"); // the first word shows from the start
  assert.equal(win("short caption", 1), "short");
  assert.equal(win("short caption", 2), "short caption"); // fits whole
  const zh = "今天天气很好，我们去公园散步吧。";
  assert.equal(win(zh, 3), "今天天");
  assert.equal(win(zh, 14), "天气很好，我们去公园散步吧。"); // the last 12 of 14
  assert.equal(win("", 1), "");
});

test("isBackchannel: acknowledgements, fillers and no words at all, in every language", () => {
  const yes: [string, string][] = [
    ["en", ""], ["en", "(coughs)"], ["en", "[laughter]"], ["en", "Mm-hmm."], ["en", "Mmmm hmm"], ["en", "uh-huh"], ["en", "Yeah, yeah, okay."], ["en", "Oh, I see. Right."], ["en", "All right, got it"],
    ["es", "Sí, sí, vale."], ["es", "Ajá, claro"], ["fr", "Ouais, d'accord."], ["fr", "Oui oui, c'est ça"], ["de", "Ja ja, genau."], ["de", "Alles klar, mhm"],
    ["it", "Sì, sì, va bene."], ["pt", "Uhum, tá bom."], ["hi", "हाँ हाँ, ठीक है।"], ["hi", "accha, theek hai"],
    ["zh", "嗯嗯，对对对。"], ["zh", "好的好的"], ["ja", "うんうん、なるほど。"], ["ja", "はい、そうですね"], ["ko", "네 네, 맞아요."], ["ko", "아 그렇구나"],
  ];
  for (const [lang, t] of yes) assert.equal(isBackchannel(t, lang as never), true, `${lang}: ${t}`);
  const no: [string, string][] = [
    ["en", "mm-hmm wait stop"], ["en", "no"], ["en", "yeah but the other one"], ["en", "okay stop"], ["en", "right now"], ["en", "I see it"],
    ["es", "sí, pero espera"], ["fr", "non"], ["de", "ja, aber warte"], ["it", "no, aspetta"], ["pt", "não"], ["hi", "रुको"],
    ["zh", "对不对"], ["zh", "等一下"], ["ja", "ちょっと待って"], ["ja", "そうじゃない"], ["ko", "잠깐만요"],
  ];
  for (const [lang, t] of no) assert.equal(isBackchannel(t, lang as never), false, `${lang}: ${t}`);
});

test("isBackchannel: laughs of any length and throat sounds are no words, real words still are", () => {
  const yes: [string, string][] = [
    ["en", "Hahaha"], ["en", "ha"], ["en", "Ha ha ha!"], ["en", "Hahahahahaha."], ["en", "hehe"], ["en", "heh"], ["en", "hah, okay"], ["en", "lol"], ["en", "Ugh."], ["en", "Uggh"], ["en", "argh"],
    ["en", "Ahem."], ["en", "ahem"], ["en", "A hem"], ["en", "Aham"], ["en", "Hck Hck"], ["en", "HCKHCK"], ["en", "Hmm."], ["en", "Hmmmm"], ["en", "hmph"], ["en", "tsk"], ["en", "phew"], ["en", "Ah."],
    ["es", "jajaja"], ["es", "jeje, sí"], ["es", "ejem"], ["fr", "hihi"], ["fr", "héhé"], ["de", "ähem"], ["de", "hehe, ja"], ["it", "ahahah"], ["it", "ehm"], ["pt", "kkkkk"], ["pt", "rsrsrs"], ["pt", "hahaha"],
    ["hi", "हाहाहा"], ["hi", "haha"], ["zh", "哈哈哈"], ["zh", "呵呵，好的"], ["zh", "咳咳"], ["ja", "ははは"], ["ja", "あはは、なるほど"], ["ja", "ふふふ"], ["ja", "えへへ"], ["ko", "하하하"], ["ko", "ㅋㅋㅋ"], ["ko", "에헴"], ["ko", "크흠"],
  ];
  for (const [lang, t] of yes) assert.equal(isBackchannel(t, lang as never), true, `${lang}: ${t}`);
  const no: [string, string][] = [
    ["en", "ugh wait stop"], ["en", "haha no"], ["en", "stop"], ["en", "wait"], ["en", "no"], ["en", "hey"], ["en", "hi"], ["en", "he"], ["en", "hack"], ["en", "hand"], ["en", "A ham"], ["en", "ahem, what about the tests"],
    ["es", "hija"], ["es", "jaja espera"], ["pt", "kkk para"], ["de", "haha, halt"], ["zh", "哈哈等一下"], ["ja", "ははは、ちょっと待って"], ["ko", "하하 잠깐만요"], ["hi", "हाहा रुको"],
  ];
  for (const [lang, t] of no) assert.equal(isBackchannel(t, lang as never), false, `${lang}: ${t}`);
});
