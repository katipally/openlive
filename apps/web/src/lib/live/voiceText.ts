// Pure text logic for the voice loop, split out from voiceEngine so it has no
// browser deps and can be unit-tested (see voiceText.test.ts). Covers: dropping
// Whisper silence-hallucinations, spotting a mid-thought pause, cleaning text
// before TTS, and chunking the reply stream into stable-length speakable pieces.

export const MIN_TTS_CHARS = 40; // don't hand Kokoro a tiny fragment — short
                                 // snippets render with an unstable timbre.
export const FIRST_TTS_CHARS = 24; // but the FIRST chunk of a reply speaks at a
                                   // lower bar (a clause boundary, or the opening
                                   // few words of a long sentence) so the agent
                                   // starts talking WHILE the rest still streams,
                                   // not after the whole reply is generated. Kept
                                   // ≥24 (not tiny): Kokoro renders a very short
                                   // opening fragment with a NOTICEABLY different
                                   // timbre — the "voice suddenly changes" bug —
                                   // so the opening chunk needs enough text to be
                                   // stable while still starting sub-sentence.
// A streamed engine (Pocket, Kitten) starts voicing as soon as it gets text and
// has no measured timbre drift on short input, so its opening only needs one
// clause: "Sure thing, " and not a sentence and a half.
export const STREAMED_FIRST_CHARS = 12;

// Characters voiced per second at speed 1, measured 2026-09-24: Pocket TTS 16-18,
// Kitten TTS 10-14. The low end, so a caption never runs ahead of the voice.
// Only a sentence still streaming when it starts playing needs an estimate.
const SPOKEN_CHARS_PER_SEC: Record<string, number> = { pocket: 16, kitten: 10 };

/** How long `text` takes `engine` to speak, for pacing a caption before its audio is all in. */
export const estimateSpeechMs = (text: string, engine: string, speed = 1) =>
  (text.length / (SPOKEN_CHARS_PER_SEC[engine] ?? 16) / speed) * 1000;

// Whisper hallucinates these on silence/ambient noise — never treat as a turn.
// Kept tight: only true silence artifacts. Real short answers ("okay", "yeah",
// "so", "bye", "no") must register as turns, so they are NOT here.
const HALLUCINATIONS = new Set(["", "you", "thank you", "thank you.", "thanks for watching", "thank you for watching", "thanks for watching!", "please subscribe", "subtitles by the amara.org community"]);

export function isJunk(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  return t.length < 2 || HALLUCINATIONS.has(t);
}

// Words that, at the very end of an utterance, usually mean "I'm not done yet".
const TRAILING = new Set(["to","the","a","an","and","but","so","or","of","for","with","my","your","is","are","it","that","this","on","at","in","because","if","when","then","like","about","into","um","uh"]);
export function endsMidThought(text: string): boolean {
  // Keep digits — "set it to 250" ends on "250", NOT on the filler "to" (stripping
  // numbers first made a complete sentence look unfinished and stalled the turn).
  const w = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/);
  const last = w[w.length - 1];
  return !!last && TRAILING.has(last);
}

// Strip markdown so the voice never reads out "-", "*", "#", or "[p.18]" symbols,
// and scrub photo-narration ("the image/photo/…") into natural spoken language as
// a backstop to the prompt — with the camera on the agent should talk about
// "what I'm seeing", not "the image". The result is what the transcript SHOWS, so
// words are kept as written: code spans and URLs pass through untouched, and an
// underscore inside a word (my_file.txt) is not emphasis. toSpeech() then adapts
// it for the voice.
export function stripMarkdown(s: string): string {
  const kept: string[] = [];
  const keep = (t: string) => `\u0000${kept.push(t) - 1}\u0000`;
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")   // links → text
    .replace(/`([^`]*)`|\bhttps?:\/\/[^\s)\]]+/gi, (m, code?: string) => keep(code ?? m))
    .replace(/[*~#>]+|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "") // bold/italic/heading/quote marks
    .replace(/^\s*[-•]\s+/gm, "")               // list bullets
    .replace(/^\s*\d+\.\s+/gm, "")              // numbered lists
    .replace(/\[p\.\s*\d+\]/gi, "")             // citation tokens
    // Strip provider control-token noise (e.g. MiniMax leaks "[e[" fragments into
    // its text stream). Spoken text never has legitimate square brackets — the
    // prompt forbids symbols — so any that remain after links/citations are junk.
    .replace(/[[\]][a-z0-9~!]{0,3}[[\]]/gi, " ")
    .replace(/[[\]]/g, "")
    .replace(/\bin (?:the|this|your) (?:image|photo|picture|frame)\b/gi, "here")
    .replace(/\b(?:the|this|that|your) (?:image|photo|picture|frame)\b/gi, "this")
    // Repair a missing space at a sentence join ("now.Right" → "now. Right"): a
    // lowercase word, sentence punctuation, then a capital. Narrow enough to leave
    // "e.g.", "U.S.", and decimals alone.
    .replace(/([a-z])([.!?])([A-Z])/g, "$1$2 $3")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[+i]!)
    .replace(/\s+/g, " ")
    .trim();
}

// Agents (esp. coding agents) narrate file paths, filenames and URLs. Read aloud
// they're symbol soup ("src slash foo dot tsx", "h-t-t-p-s colon…"), and Kokoro
// turns "alpha.txt" into "alpha txt". Say a URL as its site, a path as its file
// name, and the dot in a file name or domain as "dot". Conservative: a name needs a
// known extension or domain ending, so versions (v0.2.4), decimals and "e.g." are
// left for the TTS engine's own number and abbreviation reading.
const NAME_END = "tsx?|jsx?|mjs|cjs|json|css|scss|less|html?|md|mdx|py|rs|go|rb|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|zsh|yml|yaml|toml|xml|sql|php|lock|txt|csv|ipynb|pdf|png|jpe?g|com|org|net|io|dev|ai|app|co|edu|gov";
const DOTTED_NAME = new RegExp(`\\b[\\w-]+(?:\\.[\\w-]+)*\\.(?:${NAME_END})\\b`, "gi");
export function toSpeech(s: string): string {
  return s
    .replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#]+)\S*/gi, "$1")
    .replace(/\/?(?:[\w.-]+\/)+([\w-]+\.\w{1,6})\b/g, "$1")
    .replace(DOTTED_NAME, (m) => m.replace(/\./g, " dot "));
}

// A sentence ends at . ! or ? (and any closing quote or bracket) followed by
// whitespace. A dot glued to the next character (alpha.txt, v0.2.4, example.com,
// 3.5) never ends one, and neither does the end of the buffer: mid-stream
// "gamma." may still become "gamma.json".
const SENTENCE_END = /[.!?]+["')\]]*(?=\s)/g;
// "Dr. Smith", "e.g. this", "U.S. law", "A. Lincoln": the dot belongs to the word.
const ABBREVIATION = /(?:^|[\s(])(?:[a-z]|(?:[a-z]\.)+[a-z]|dr|mr|mrs|ms|prof|st|jr|sr|vs|etc|approx|fig)\.$/i;
// An odd number of backticks before i opens a code span, unless the last one is far
// back: code spans are short, and a stray backtick must not hold the rest of the
// reply unspoken until the turn ends.
function inCodeSpan(s: string, i: number): boolean {
  const open = s.lastIndexOf("`", i);
  return open >= 0 && i - open < 80 && s.slice(0, i).split("`").length % 2 === 0;
}

// Split a growing text stream into speakable chunks (keep decimals/abbrevs).
// Completed sentences shorter than MIN_TTS_CHARS are held and merged with the
// next one before emitting — so Kokoro always gets enough text to keep a single,
// consistent voice instead of re-rendering tiny fragments oddly. EXCEPTION: the
// FIRST chunk of a reply is released fast (a clause boundary, or the opening few
// words of a long sentence) so speech begins as text streams, not after the
// whole reply is generated — the difference between "talks as it thinks" and a
// long silence then a wall of speech.
export class SentenceChunker {
  private buf = "";      // text after the last completed sentence
  private ready = "";    // completed sentences not yet long enough to speak
  private started = false; // has the first speakable chunk of THIS turn gone out?
  private inFence = false;  // inside a ``` code block — suppress it from speech
  private btTail = "";      // held trailing backticks that may start a ``` split across deltas

  // Drop fenced code blocks (```…```) from the SPOKEN stream — a code dump read
  // aloud is symbol soup. Stateful because a fence spans many streamed deltas, and
  // the ``` marker itself can split across two deltas (hence btTail). Inline code and
  // other markdown are handled per-chunk by stripMarkdown.
  private stripFences(t: string): string {
    let s = this.btTail + t;
    this.btTail = "";
    // Hold back a trailing run of 1–2 backticks: it might be the start of a ```.
    const m = /`+$/.exec(s);
    if (m && m[0].length < 3) { this.btTail = m[0]; s = s.slice(0, s.length - m[0].length); }
    let out = "";
    while (true) {
      const i = s.indexOf("```");
      if (i === -1) { if (!this.inFence) out += s; break; }
      if (!this.inFence) out += s.slice(0, i);
      this.inFence = !this.inFence;
      s = s.slice(i + 3);
    }
    return out;
  }

  // `firstMin` is the opening chunk's length bar: STREAMED_FIRST_CHARS for an
  // engine that streams its audio.
  push(t: string, firstMin = FIRST_TTS_CHARS): string[] {
    this.buf += this.stripFences(t);
    const out: string[] = [];
    // Fast start — only when nothing is already held (`ready` empty) so we never
    // speak the opening ahead of an earlier short sentence waiting to merge.
    if (!this.started && !this.ready) {
      const first = this.takeFirst(firstMin);
      if (first) { out.push(first); this.started = true; }
    }
    let last = 0;
    for (const m of this.buf.matchAll(SENTENCE_END)) {
      const end = m.index + m[0].length;
      if (m[0][0] === "." && ABBREVIATION.test(this.buf.slice(last, m.index + 1))) continue;
      if (inCodeSpan(this.buf, m.index)) continue;
      this.ready += this.buf.slice(last, end);
      last = end;
      // First chunk clears the low bar so even a short single sentence speaks
      // now; every chunk after keeps the stable MIN_TTS_CHARS timbre bar.
      const bar = this.started ? MIN_TTS_CHARS : firstMin;
      if (this.ready.trim().length >= bar) { out.push(this.ready.trim()); this.ready = ""; this.started = true; }
    }
    if (last) this.buf = this.buf.slice(last);
    return out;
  }
  // Release the opening of a reply as soon as there's something natural to say:
  // an early clause boundary, else — for a LONG opening sentence with no early
  // pause — the first few words at a word boundary. A short sentence (terminal
  // within reach) is left for the sentence loop to emit whole.
  private takeFirst(min: number): string | null {
    const s = this.buf;
    if (s.trim().length < min) return null;
    const clause = /^([\s\S]{12,}?[,;:—–])\s/.exec(s);
    if (clause) { this.buf = s.slice(clause[0].length); return clause[1]!.trim(); }
    if (/[.!?](\s|$)/.test(s.slice(0, 90))) return null; // a full sentence ends soon — don't chop it
    const window = s.slice(0, 48);
    const sp = window.lastIndexOf(" ");
    if (sp < FIRST_TTS_CHARS) return null;
    this.buf = s.slice(sp + 1);
    return window.slice(0, sp).trim();
  }
  // flush() ends the turn (called on `done` and on barge-in) — reset `started`
  // so the next reply gets its own fast first chunk.
  flush(): string {
    // Emit any held backtick tail only if we're not inside a fence (it was real text,
    // not a fence marker). Reset all state so the next reply starts clean.
    const tail = this.inFence ? "" : this.btTail;
    const s = (this.ready + this.buf + tail).trim();
    this.ready = ""; this.buf = ""; this.started = false; this.inFence = false; this.btTail = "";
    return s;
  }
}
