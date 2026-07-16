// Guards the non-trivial voice string logic — chunk merging (voice stability),
// junk filtering (turn detection), and TTS scrubbing.
import assert from "node:assert";
import { test } from "vitest";
import { isJunk, endsMidThought, stripMarkdown, SentenceChunker, MIN_TTS_CHARS } from "./voiceText.ts";

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
  assert.ok(spoken.length >= 2, "long sentence should stream in pieces, not one late chunk");
  assert.ok(spoken[0]!.length < 48 && !/[.!?]$/.test(spoken[0]!), "first chunk is the opening words, mid-sentence");
});

test("SentenceChunker: after the first chunk, later short sentences hold to the stable MIN bar", () => {
  const c = new SentenceChunker();
  c.push("Okay, here we go. ");                    // first chunk released
  const out = c.push("Yes. ");                     // 4 chars, under MIN → held
  assert.equal(out.length, 0);
});
