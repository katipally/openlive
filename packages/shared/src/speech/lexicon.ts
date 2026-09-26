// The user's pronunciation dictionary: words and phrases as the assistant
// writes them, each with a respelling the voice says instead ("Nginx" →
// "engine x"). Respelling only: no engine the app runs takes phonemes mixed
// into its text (kokoro-js 1.2.1 phonemizes all of it through espeak-ng; the
// sherpa-onnx engines take text or a lexicon file, not inline phonemes).

export interface LexiconEntry {
  from: string;
  to: string;
  /** ISO 639-1, or "" for every language. */
  lang: string;
  /** "iOS" only as written, not "IOS" or "ios". */
  matchCase: boolean;
  /** Only as a whole word: "Kai" leaves "Kaiser" alone. Off, it matches inside words too. */
  wholeWord: boolean;
}

/** Replaces every entry's match in `text` with `hold(respelling, match)`. */
export type Lexicon = (text: string, hold: (said: string, written: string) => string) => string;

interface Trie { next: Map<string, Trie>; end: boolean }
const escape = (c: string) => c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
/** The keys as one regex, their shared prefixes merged ("git(?:hub|lab)"), so
 *  a match costs O(L) at each position for the longest key L, however many
 *  keys there are. A longer key is tried before its own prefix. */
function trieSource(keys: Iterable<string>): string {
  const root: Trie = { next: new Map(), end: false };
  for (const k of keys) {
    let t = root;
    for (const c of k) { let u = t.next.get(c); if (!u) t.next.set(c, u = { next: new Map(), end: false }); t = u; }
    t.end = true;
  }
  const src = (t: Trie): string => {
    const alts = [...t.next].map(([c, u]) => escape(c) + src(u));
    if (!alts.length) return "";
    const body = alts.length === 1 ? alts[0]! : `(?:${alts.join("|")})`;
    return t.end ? `(?:${body})?` : body;
  };
  return src(root);
}

// A word character for whole-word matching. Chinese, Japanese and Korean are
// left out: they write no spaces, and Korean particles attach to the word.
const WORD = String.raw`(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}])[\p{L}\p{M}\p{N}_])`;

/**
 * One matcher for the entries that apply to `lang`. Exact-case entries go
 * first, then the rest in a second pass, each pass one regex: whole-word keys
 * before part-of-word keys at a position, the longest key first. A key listed
 * twice keeps its last respelling. Null when nothing applies.
 * Building is O(total key length); applying is O(n · L) per pass.
 */
export function compileLexicon(entries: readonly LexiconEntry[], lang: string): Lexicon | null {
  const passes = [true, false].map((matchCase) => {
    const word = new Map<string, string>(), part = new Map<string, string>();
    for (const e of entries) {
      if (e.matchCase !== matchCase || (e.lang && e.lang !== lang) || !e.from) continue;
      (e.wholeWord ? word : part).set(matchCase ? e.from : e.from.toLowerCase(), e.to);
    }
    if (!word.size && !part.size) return null;
    // (?!) never matches: an empty group keeps the capture numbering fixed.
    const group = (m: Map<string, string>) => (m.size ? trieSource(m.keys()) : "(?!)");
    const re = new RegExp(`(?<!${WORD})(${group(word)})(?!${WORD})|(${group(part)})`, matchCase ? "gu" : "giu");
    const key = (m: string) => (matchCase ? m : m.toLowerCase());
    return { re, say: (w: string | undefined, p: string | undefined) => (w !== undefined ? word.get(key(w)) : part.get(key(p!))) };
  }).filter((p) => p !== null);
  if (!passes.length) return null;
  return (text, hold) => passes.reduce((t, { re, say }) =>
    t.replace(re, (m: string, w?: string, p?: string) => { const said = say(w, p); return said === undefined ? m : hold(said, m); }), text);
}
