// Pure text logic for the voice loop, split out from voiceEngine so it has no
// browser deps and can be unit-tested (see voiceText.test.ts). Covers: dropping
// Whisper silence-hallucinations, spotting a mid-thought pause, cleaning text
// before TTS, and chunking the reply stream into stable-length speakable pieces.

export { normalizeSpeech as toSpeech } from "@openlive/shared/speech/normalize";
import type { LanguageCode } from "@openlive/shared";

export const MIN_TTS_CHARS = 40; // don't hand Kokoro a tiny fragment — short
                                 // snippets render with an unstable timbre.
// The FIRST chunk of a reply speaks at a lower bar, so the agent starts talking
// while the rest still streams, but it still ends at a sentence end: every
// engine voices the end of its text as the end of an utterance. An opening cut
// at a comma, measured 2026-09-24 over 14 replies on Supertonic, Kokoro, Kitten
// and sherpa Kokoro, paused 0.35-0.78 s where one render pauses 0.07-0.33 s,
// and the words after it came 1.1-2.3 semitones off the pitch one render gives them.
export const FIRST_TTS_CHARS = 24;
// kokoro-js truncates its input to 510 phoneme tokens, and spoken numbers and
// "dot" names can more than double a chunk's length in phonemes. 200 characters
// stays clear of that for every engine and far under the agent's /tts cap.
export const MAX_CHUNK_CHARS = 200;

// Characters voiced per second at speed 1, measured 2026-09-24: Pocket TTS 16-18,
// Kitten TTS 10-14. The low end, so a caption never runs ahead of the voice.
// Only a sentence still streaming when it starts playing needs an estimate.
const SPOKEN_CHARS_PER_SEC: Record<string, number> = { pocket: 16, kitten: 10 };
const ENGLISH_CHARS_PER_SEC = 16;

/**
 * How each language is written, as far as chunking and pacing need it. `rate`
 * is characters voiced a second (the low end measured below), which also
 * scales the chunker's length bars: 40 English characters is about 2.5 s of
 * speech, 40 Chinese ones about 8 s. `spaced`: words are separated by spaces
 * (Chinese and Japanese are not). `maxChunk`: Supertonic's reference caps a
 * Japanese or Korean chunk at 120 characters (web/helper.js), and 120 Chinese
 * characters is already about 400 of Kokoro's 510 phoneme tokens.
 * Rates measured 2026-09-24 over two to four sentences each: Kokoro v1.0 fp32
 * on the agent es 18-20, fr 19-23, it 18, pt 18, hi 13, zh 4.6-5.1; Supertonic 3
 * in the browser es 17, fr 19, de 18, it 16, pt 17, hi 18, ja 7.3-12, ko 8-12.
 * The languages at or above English's 16 use English's numbers.
 * `maxSpoken`: the most of toSpeech's output one engine call gets. Spelled-out
 * numbers and names grow a chunk (twice over, for a line of prices), and
 * kokoro-js drops what passes 510 phoneme tokens: 400 English characters stay
 * under it, and for the unspaced scripts and Korean, 150, just past the
 * 120-character chunk.
 */
const LANG_TEXT: Record<string, { rate: number; spaced: boolean; maxChunk: number; maxSpoken: number }> = {
  en: { rate: ENGLISH_CHARS_PER_SEC, spaced: true, maxChunk: MAX_CHUNK_CHARS, maxSpoken: 2 * MAX_CHUNK_CHARS },
  hi: { rate: 13, spaced: true, maxChunk: MAX_CHUNK_CHARS, maxSpoken: 2 * MAX_CHUNK_CHARS },
  zh: { rate: 4.5, spaced: false, maxChunk: 120, maxSpoken: 150 },
  ja: { rate: 7, spaced: false, maxChunk: 120, maxSpoken: 150 },
  ko: { rate: 8, spaced: true, maxChunk: 120, maxSpoken: 150 },
};
const langText = (lang: string) => LANG_TEXT[lang] ?? LANG_TEXT.en!;

/** How long `text` takes `engine` to speak in `lang`, for pacing a caption before its audio is all in. */
export const estimateSpeechMs = (text: string, engine: string, speed = 1, lang = "en") =>
  (text.length / (lang === "en" ? SPOKEN_CHARS_PER_SEC[engine] ?? ENGLISH_CHARS_PER_SEC : langText(lang).rate) / speed) * 1000;

// The rolling agent caption holds five English words' width; a Chinese or
// Japanese character (a caption word of its own) is 0.4 of one, about 12 to the line.
const CAPTION_WIDTH = 5;
const UNSPACED_CHAR = /^[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}]/u;
/** The caption's last words heard: `units` (captionWords of `text`) up to the
 *  `heard`th, as many as fit CAPTION_WIDTH. The whole text when it all fits. O(window). */
export function captionWindow(text: string, units: readonly [number, number][], heard: number): string {
  if (!units.length) return text;
  const end = Math.max(1, Math.min(units.length, heard));
  let from = end - 1, width = 0;
  for (let k = end - 1; k >= 0; k--) {
    width += UNSPACED_CHAR.test(text.slice(units[k]![0], units[k]![1])) ? 0.4 : 1;
    if (width > CAPTION_WIDTH) break;
    from = k;
  }
  return text.slice(units[from]![0], units[end - 1]![1]);
}

// Whisper hallucinates these on silence/ambient noise — never treat as a turn.
// Kept tight: only true silence artifacts. Real short answers ("okay", "yeah",
// "so", "bye", "no") must register as turns, so they are NOT here. The last
// four are multilingual Whisper's, as isJunk leaves them (punctuation gone).
const HALLUCINATIONS = new Set(["", "you", "thank you", "thank you.", "thanks for watching", "thank you for watching", "thanks for watching!", "please subscribe", "subtitles by the amara.org community",
  "ご視聴ありがとうございました", "시청해주셔서 감사합니다", "字幕由amaraorg社区提供", "subtítulos realizados por la comunidad de amaraorg"]);
// One of these is a whole answer ("好", "네"); one Latin letter is noise.
const SYLLABIC = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

export function isJunk(text: string): boolean {
  const t = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, "").trim();
  return t.length < (SYLLABIC.test(t) ? 1 : 2) || HALLUCINATIONS.has(t);
}

// Words that, at the very end of an utterance, usually mean "I'm not done yet".
// Not "it" or "this": "what time is it" and "what is this" are whole questions,
// and the streaming engines write no question mark to tell them apart.
const TRAILING = new Set(["to","the","a","an","and","but","so","or","of","for","with","my","your","is","are","that","on","at","in","because","if","when","then","like","about","into","um","uh"]);
/** English only: the word list is English. Every other language leaves a pause
 *  to Smart-Turn, plus a trailing comma or ellipsis the transcriber wrote. */
export function endsMidThought(text: string, lang = "en"): boolean {
  if (lang !== "en") return /(?:[,，、…]|\.\.\.)\s*$/.test(text);
  // A question mark closes the thought: "what time is it?" ends on "it" and is done.
  if (/\?\s*$/.test(text)) return false;
  // Keep digits — "set it to 250" ends on "250", NOT on the filler "to" (stripping
  // numbers first made a complete sentence look unfinished and stalled the turn).
  const w = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/);
  const last = w[w.length - 1];
  return !!last && TRAILING.has(last);
}

// What a listener says to keep a speaker going, and the sounds a thought
// starts on. Over the agent's voice none of it asks the agent to stop; as a
// turn of its own ("yeah" to a question) it is an answer and is sent as one.
// Whisper writes a cough or a laugh as "(coughs)" or "[laughs]", or as nothing,
// or spells it (SOUND below).
const FILLERS = ["ok", "okay", "mm", "mhm", "hmm", "uh", "um", "ah", "oh", "eh", "aha", "huh"];
const BACKCHANNELS: Record<LanguageCode, string[]> = {
  en: ["yeah", "yea", "ya", "yep", "yup", "yes", "kay", "right", "all right", "alright", "sure", "got it", "gotcha", "i see", "cool", "nice", "great", "wow", "exactly", "totally", "true", "uh huh", "mm hmm"],
  es: ["sí", "si", "vale", "claro", "ajá", "aja", "ya", "bueno", "exacto", "de acuerdo", "entiendo", "vaya"],
  fr: ["oui", "ouais", "d'accord", "voilà", "bien", "bon", "ah bon", "euh", "hein", "exactement", "c'est ça", "je vois", "tout à fait", "super"],
  de: ["ja", "jo", "jap", "genau", "gut", "klar", "stimmt", "richtig", "äh", "ähm", "achso", "ach so", "verstehe", "alles klar", "super"],
  it: ["sì", "si", "certo", "esatto", "vero", "va bene", "d'accordo", "capito", "già", "ecco", "bene"],
  pt: ["sim", "é", "tá", "ta", "certo", "claro", "isso", "exato", "beleza", "entendi", "uhum", "aham", "pois", "tá bom"],
  hi: ["हाँ", "हां", "हा", "जी", "हाँजी", "अच्छा", "ठीक", "ठीक है", "सही", "बिल्कुल", "हम्म", "हूँ", "हूं", "ओके", "haan", "han", "ji", "accha", "acha", "theek hai", "thik hai"],
  zh: ["嗯", "恩", "对", "对的", "是", "是的", "好", "好的", "好吧", "行", "哦", "噢", "啊", "呃", "嗯哼", "没错", "明白", "明白了", "知道了"],
  ja: ["はい", "うん", "ええ", "ああ", "あ", "え", "えー", "ん", "そう", "そうそう", "そうですね", "そっか", "そうか", "ですね", "ね", "なるほど", "へえ", "ほう", "ふーん", "確かに", "たしかに", "了解", "オッケー"],
  ko: ["네", "예", "응", "어", "음", "아", "오", "그래", "그래요", "그렇죠", "그렇구나", "맞아", "맞아요", "맞습니다", "알겠어", "알겠어요", "좋아", "좋아요", "오케이", "흠", "아하"],
};
// Lowercase, bracketed sound notes and punctuation out, then every run of one
// letter down to one, so "Mmmm-hmm!" and "mm hmm" both read "m hm".
const fold = (s: string) => s.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").replace(/(\p{L})\1+/gu, "$1").trim();
const FOLDED = Object.fromEntries(Object.entries(BACKCHANNELS).map(([l, w]) => [l, [...new Set([...w, ...FILLERS].map(fold))]])) as Record<LanguageCode, string[]>;
// Laughs and throat sounds as a transcriber spells them, after fold(): a laugh
// is one syllable repeated ("Hahaha", "jajaja", "ahah", "hihi", "哈哈", "ははは",
// "ㅋㅋㅋ", "हाहा", Portuguese "kkkk"), a throat sound "ugh", "ahem", "hck",
// "hmph". Real words that Whisper makes of an "ahem" ("A ham", "hand") are left:
// they voice as long as "stop" or "no" (480 ms against 416-512 ms, Silero v6),
// so nothing tells them apart from a real one-word interruption.
const SOUND = String.raw`[ae]?([hj][aeiouéè])\1+h?|(?:[ae]h){2,}|[hj]ah?|heh|lol|lmao|(?:rs){2,}|(?:h?c?kh?)+|[au]r?gh|[aeä]h[aeä]m|[aeä] h[eä]m|h[eä]m|[aeä]hm|ejem|hmp[hf]|h?m(?:h?m)*|pft?|tsk|[pw]hew|(?:ह[ािीेो]){2,}|[哈呵嘿嘻咳]|[あえ]?[はハへヘふフ]|(?:ゴホ)+|[하허히흐호크킥ㅋㅎ]|에헴|어흠|크흠`;
const SOUND_WORD = new RegExp(`(?:${SOUND})(?= |$)`, "uy"), SOUND_ANY = new RegExp(SOUND, "uy");
/** Nothing but backchannels, fillers, laughs and throat sounds, or no words at
 *  all. Chinese and Japanese write no spaces, so their entries may meet
 *  anywhere; elsewhere only at a space. O(n·(k + m)): n characters, k entries,
 *  m the longest sound spelled at one position. */
export function isBackchannel(text: string, lang: LanguageCode): boolean {
  const s = fold(text), words = FOLDED[lang], unspaced = lang === "zh" || lang === "ja";
  const sound = unspaced ? SOUND_ANY : SOUND_WORD;
  const reach = new Array<boolean>(s.length + 1).fill(false); // reach[i]: s[0, i) is all backchannel
  reach[0] = true;
  for (let i = 0; i < s.length; i++) {
    if (!reach[i]) continue;
    if (s[i] === " ") { reach[i + 1] = true; continue; }
    for (const w of words) if (s.startsWith(w, i) && (unspaced || i + w.length === s.length || s[i + w.length] === " ")) reach[i + w.length] = true;
    sound.lastIndex = i;
    if (sound.test(s)) reach[sound.lastIndex] = true;
  }
  return reach[s.length]!;
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
    // Bold, italic, strikethrough, heading and quote marks. A mark that means
    // something in prose stays for the voice to say: "#1", "~5", "> 10", "C#".
    .replace(/\*+|~+(?!\d)|(?<!\S)#+(?!\S)|>+(?!\s?\d)|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "")
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

/** `said`, toSpeech's output, cut into pieces one engine call takes whole
 *  (LANG_TEXT maxSpoken); almost always the one piece. O(n). */
export function speechPieces(said: string, lang = "en"): string[] {
  const { spaced, maxSpoken } = langText(lang);
  return splitLong(said, maxSpoken, spaced);
}

// A sentence ends at . ! or ? (and any closing quote or bracket) followed by
// whitespace, or at a line break (list items and headings carry no period). A dot glued to the next character (alpha.txt, v0.2.4, example.com,
// 3.5) never ends one, and neither does the end of the buffer: mid-stream
// "gamma." may still become "gamma.json". The Chinese and Japanese enders and
// the Devanagari danda end one wherever they are: no space follows them there,
// and they mean nothing else.
const SENTENCE_END = /[.!?]+["')\]]*(?=\s)|[。！？．।॥]+["'”’」』）)\]]*|\n/g;
// Where a sentence of unspaced text may be cut: after a clause mark.
const CLAUSE_MARK = /[、，；：,;:。！？．]/;
// "Dr. Smith", "e.g. this", "U.S. law", "A. Lincoln": the dot belongs to the word.
const ABBREVIATION = /(?:^|[\s(])(?:[a-z]|(?:[a-z]\.)+[a-z]|dr|mr|mrs|ms|prof|st|jr|sr|vs|etc|approx|fig|inc|ltd|corp|dept|aka|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec|sra|srta|dra|mme|mlle|bzw|usw|ecc|ej|ex)\.$/i;
// Abbreviations only before a number ("No. 5", "vol. 2"): elsewhere "no." ends
// a sentence. German writes an ordinal with a dot ("am 3. Oktober"). Both wait
// for the next word before they decide.
const BEFORE_NUMBER = /(?:^|[\s(])(?:no|nr|nos|vol|ch|pp)\.$/i;
const ORDINAL_DOT = /(?:^|[\s(])\d{1,2}\.$/;
const DE_MONTH_AHEAD = /^\s+(?:Jan|Feb|Mär|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez)/;
// An odd number of backticks before i opens a code span, unless the last one is far
// back: code spans are short, and a stray backtick must not hold the rest of the
// reply unspoken until the turn ends.
function inCodeSpan(s: string, i: number): boolean {
  const open = s.lastIndexOf("`", i);
  return open >= 0 && i - open < 80 && s.slice(0, i).split("`").length % 2 === 0;
}

/** The last index in `t` before `end` (and after `from`) a piece may end at: a
 *  space, or in unspaced text just past a clause mark; -1 when there is none. O(end - from). */
function lastBreak(t: string, from: number, end: number, spaced: boolean): number {
  if (spaced) return t.lastIndexOf(" ", end);
  // Not inside a number: the comma of 1,200 or the colon of 3:30.
  for (let j = end - 1; j > from; j--) if (CLAUSE_MARK.test(t[j]!) && !(/[,:]/.test(t[j]!) && /\d/.test(t[j - 1]!) && /\d/.test(t[j + 1] ?? ""))) return j + 1;
  return -1;
}

/** `s` cut at word boundaries (clause marks, in unspaced text) into pieces of
 *  at most `max` characters; a word longer than that is cut inside it. O(n). */
export function splitLong(s: string, max = MAX_CHUNK_CHARS, spaced = true): string[] {
  const t = s.trim();
  const out: string[] = [];
  let i = 0;
  while (t.length - i > max) {
    const sp = lastBreak(t, i, i + max, spaced);
    const cut = sp > i ? sp : i + max;
    const piece = t.slice(i, cut).trim();
    if (piece) out.push(piece);
    i = cut;
  }
  const rest = t.slice(i).trim();
  if (rest) out.push(rest);
  return out;
}

// Split a growing text stream into speakable chunks (keep decimals/abbrevs).
// Completed sentences shorter than MIN_TTS_CHARS are held and merged with the
// next one before emitting — so Kokoro always gets enough text to keep a single,
// consistent voice instead of re-rendering tiny fragments oddly. The FIRST
// chunk of a reply clears the lower FIRST_TTS_CHARS bar, so speech begins as
// text streams, not after the whole reply is generated.
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

  // The length bars are English characters, scaled to `lang` by how fast it is spoken.
  push(t: string, lang = "en"): string[] {
    this.buf += this.stripFences(t);
    const out: string[] = [];
    const { rate, spaced, maxChunk } = langText(lang);
    const bar = (n: number) => Math.max(1, Math.round((n * rate) / ENGLISH_CHARS_PER_SEC));
    const split = (x: string) => splitLong(x, maxChunk, spaced);
    let last = 0;
    for (const m of this.buf.matchAll(SENTENCE_END)) {
      const end = m.index + m[0].length;
      const upTo = this.buf.slice(last, m.index + 1);
      if (m[0][0] === "." && ABBREVIATION.test(upTo)) continue;
      const ahead = m[0][0] !== "." ? null : BEFORE_NUMBER.test(upTo) ? /^\s+\d/ : lang === "de" && ORDINAL_DOT.test(upTo) ? DE_MONTH_AHEAD : null;
      if (ahead) {
        if (!/^\s+(?:\S{3}|\S+\s)/.test(this.buf.slice(end))) break;
        if (ahead.test(this.buf.slice(end))) continue;
      }
      if (inCodeSpan(this.buf, m.index)) continue;
      this.ready += this.buf.slice(last, end);
      last = end;
      // First chunk clears the low bar so even a short single sentence speaks
      // now; every chunk after keeps the stable MIN_TTS_CHARS timbre bar.
      if (this.ready.trim().length >= bar(this.started ? MIN_TTS_CHARS : FIRST_TTS_CHARS)) { out.push(...split(this.ready)); this.ready = ""; this.started = true; }
    }
    if (last) this.buf = this.buf.slice(last);
    // No boundary in sight: speak all but the last piece now, so no chunk, and
    // no flushed tail beyond one held short sentence, exceeds the chunk cap.
    if (this.buf.length > maxChunk) {
      const pieces = split(this.ready + this.buf);
      this.buf = this.buf.slice(this.buf.lastIndexOf(pieces.pop()!)); // keeps a trailing space for the next delta
      if (pieces.length) { out.push(...pieces); this.ready = ""; this.started = true; }
    }
    return out;
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
