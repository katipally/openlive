// Guards the non-trivial voice string logic — chunk merging (voice stability),
// junk filtering (turn detection), and TTS scrubbing.
import assert from "node:assert";
import { test } from "vitest";
import { isJunk, endsMidThought, stripMarkdown, toSpeech, SentenceChunker, MIN_TTS_CHARS, STREAMED_FIRST_CHARS, estimateSpeechMs } from "./voiceText.ts";

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

test("SentenceChunker: fast start — a long first sentence releases its opening clause early", () => {
  const c = new SentenceChunker();
  const spoken: string[] = [];
  for (const d of ["The gas valve", ", which sits", " on the lower left, ", "controls the flow."]) spoken.push(...c.push(d));
  assert.ok(spoken.length >= 1, "should emit before flush");
  assert.equal(spoken[0], "The gas valve,");       // opening clause released early
  assert.ok(spoken[0]!.length < MIN_TTS_CHARS);    // small enough to start fast
});

test("SentenceChunker: a single short first sentence speaks whole on completion", () => {
  const c = new SentenceChunker();
  const out = c.push("The valve is on the left. ");
  assert.equal(out.length, 1);
  assert.equal(out[0], "The valve is on the left.");
});

test("SentenceChunker: a LONG opening sentence with no early pause streams in pieces", () => {
  const c = new SentenceChunker();
  const spoken: string[] = [];
  for (const d of ["I'll put ", "a simple labeled ", "diagram of the machine ", "on screen for you now."]) spoken.push(...c.push(d));
  assert.ok(spoken.length >= 1, "the opening speaks before the sentence is done");
  spoken.push(c.flush()); // the closing "now." could still grow into "now.txt" until the turn ends
  assert.ok(spoken.length >= 2, "long sentence should stream in pieces, not one late chunk");
  assert.ok(spoken[0]!.length < 48 && !/[.!?]$/.test(spoken[0]!), "first chunk is the opening words, mid-sentence");
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

test("SentenceChunker: a streamed engine opens on the first clause of 12+ characters", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("Sure, ", STREAMED_FIRST_CHARS), []);                 // too short to open on
  assert.deepEqual(c.push("I can help with that, and ", STREAMED_FIRST_CHARS), ["Sure, I can help with that,"]);
  // Later chunks keep the stable MIN bar, so the rest does not come out choppy.
  assert.deepEqual(c.push("it is quick. Yes. ", STREAMED_FIRST_CHARS), []);
  assert.equal(c.flush(), "and it is quick. Yes.");
  // The default bar is unchanged: the same opening waits for 24 characters.
  const k = new SentenceChunker();
  assert.deepEqual(k.push("Sure thing, okay. "), []);
  assert.deepEqual(new SentenceChunker().push("Sure thing, okay. ", STREAMED_FIRST_CHARS), ["Sure thing, okay."]);
});

test("estimateSpeechMs: scales with length, inversely with speed, at each engine's rate", () => {
  assert.equal(estimateSpeechMs("", "pocket"), 0);
  assert.equal(estimateSpeechMs("x".repeat(32), "pocket"), 2000);
  assert.equal(estimateSpeechMs("x".repeat(32), "pocket", 2), 1000);
  assert.equal(estimateSpeechMs("x".repeat(30), "kitten"), 3000);
  assert.equal(estimateSpeechMs("x".repeat(32), "kokoro"), 2000); // one-piece engines: exact duration is used instead
});
