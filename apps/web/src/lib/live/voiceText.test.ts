// Guards the non-trivial voice string logic — chunk merging (voice stability),
// junk filtering (turn detection), and TTS scrubbing.
import assert from "node:assert";
import { test } from "vitest";
import { isJunk, endsMidThought, stripMarkdown, toSpeech, SentenceChunker, MIN_TTS_CHARS, FIRST_TTS_CHARS, MAX_CHUNK_CHARS, splitLong, estimateSpeechMs } from "./voiceText.ts";

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
  assert.equal(toSpeech("I updated src/components/Foo.tsx for you"), "I updated Foo dot tsx for you");
  assert.equal(toSpeech("saved to app/main.py"), "saved to main dot py");
  assert.equal(toSpeech("You've got three files: alpha.txt, beta.md, and gamma.json."), "You've got three files: alpha dot txt, beta dot md, and gamma dot json.");
  assert.equal(toSpeech("see https://www.example.com/docs for more"), "see example dot com for more");
  assert.equal(toSpeech("visit docs.example.com today"), "visit docs dot example dot com today");
  // Versions, decimals, abbreviations and ordinary slashes are left for the TTS engine.
  for (const s of ["it's either and/or both", "open 24/7 tomorrow", "e.g. the third one", "ship v0.2.4 at 3.5 GHz", "Dr. Lee said so."]) {
    assert.equal(toSpeech(s), s);
  }
});

// Streams `text` in pieces of `size` and returns every chunk the chunker emits.
function chunked(text: string, size: number): string[] {
  const c = new SentenceChunker();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...c.push(text.slice(i, i + size)));
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

test("SentenceChunker: fast start: a long first sentence releases its opening clause early", () => {
  const c = new SentenceChunker();
  const spoken: string[] = [];
  for (const d of ["The gas valve", ", which sits", " on the lower left, ", "controls the flow."]) spoken.push(...c.push(d));
  assert.ok(spoken.length >= 1, "should emit before flush");
  assert.equal(spoken[0], "The gas valve, which sits on the lower left,"); // the first clause past the bar
  assert.ok(spoken[0]!.length >= FIRST_TTS_CHARS);
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

test("SentenceChunker: the opening chunk always ends on a clause or sentence boundary", () => {
  const replies = [
    "Sure, I can help with that, and it is quick. Yes.",
    "Okay so the thing you want to do first is open the settings panel and then pick voice.",
    "Right: the config lives in two places; the first one wins, always.",
    "Hi! " + "word ".repeat(30) + "done.",
  ];
  for (const text of replies) for (const size of [1, 3, 8, 500]) {
    const out = chunked(text, size);
    assert.equal(out.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " ").trim(), `${size}: ${text}`);
    assert.match(out[0]!, /[,;:.!?]$/, `${size}: ${JSON.stringify(out)}`);
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

test("SentenceChunker: the opening waits for a clause of 24+ characters, then later chunks keep the MIN bar", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("Sure, "), []);                 // too short to open on
  assert.deepEqual(c.push("I can help with that, and "), ["Sure, I can help with that,"]);
  assert.deepEqual(c.push("it is quick. Yes. "), []);
  assert.equal(c.flush(), "and it is quick. Yes.");
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

test("toSpeech: outside English file names keep their dot", () => {
  assert.equal(toSpeech("revisa src/app/main.py ahora", "es"), "revisa main.py ahora");
  assert.equal(toSpeech("ve a https://www.example.com/docs", "es"), "ve a example.com");
  assert.equal(toSpeech("saved to app/main.py", "en"), "saved to main dot py");
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
