// Dictate's on-device cleanup: the words as said become the words as meant,
// with no brain and no network. Each rule is its own switch and one left to
// right pass over the words, each looking at most a few words ahead, so the
// whole is O(n) in the length of the text.
//
// Every rule leans conservative: a sentence it is unsure of is left exactly as
// heard, because a wrong "fix" typed into someone's document costs more than a
// missed one. The rules are English; any other language passes through as the
// speech engine wrote it.

export interface CleanupRules {
  /** Sentence capitals, "I", day and month names, and a closing period the engine left off. */
  punctuation: boolean;
  /** um, uh, er; "you know" and "like" only when set off by pauses. */
  fillers: boolean;
  /** "scratch that" takes back the sentence; "actually" and "no wait" swap the last few words. */
  backtrack: boolean;
  /** "One, milk. Two, eggs." as numbered lines. */
  lists: boolean;
  /** "twenty five" as 25. One to nine stay words. */
  numbers: boolean;
}

interface Tok {
  pre: string;
  core: string;
  post: string;
  /** Starts a new line (a list item). */
  line?: boolean;
}

const ENDS = /[.!?…]$/;
const PAUSE = /([,;:—–]|\.\.\.|…)$/;
const lc = (t: Tok | undefined) => t?.core.toLowerCase() ?? "";

function tokenize(text: string): Tok[] {
  return (text.match(/\S+/g) ?? []).map((raw) => {
    const m = /^([("'“‘[]*)(.*?)([.,!?;:)"'”’\]…]*)$/.exec(raw)!;
    return { pre: m[1]!, core: m[2]!, post: m[3]! };
  });
}

const join = (ts: Tok[]) =>
  ts.filter((t) => t.pre || t.core || t.post).map((t, i) => (i ? (t.line ? "\n" : " ") : "") + t.pre + t.core + t.post).join("");

const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "er", "erm", "hmm", "hm", "mm"]);

function dropFillers(ts: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!, prev = out[out.length - 1];
    const atPause = !prev || PAUSE.test(prev.post) || ENDS.test(prev.post);
    let n = 0;
    if (FILLERS.has(lc(t))) n = 1;
    // Set off by pauses on both sides, or it is part of the sentence: "do you know him", "I like it".
    else if (lc(t) === "you" && lc(ts[i + 1]) === "know" && atPause && /^[,.]?$/.test(ts[i + 1]!.post) && (ts[i + 1]!.post || i + 2 === ts.length)) n = 2;
    else if (lc(t) === "like" && prev && /,$/.test(prev.post) && t.post === ",") n = 1;
    if (!n) { out.push({ ...t }); continue; }
    const last = ts[i + n - 1]!;
    if (prev && ENDS.test(last.post)) prev.post = prev.post.replace(/[,;:]+$/, "") + last.post.replace(/^[,;:]+/, "");
    else if (prev && /,/.test(last.post)) prev.post = prev.post.replace(/,$/, "");
    i += n - 1;
  }
  return out;
}

// One word that is not a correction of the word before it.
const NOT_A_SWAP = new Set(["no", "yes", "not", "never", "nothing", "wait", "please", "sorry", "okay", "ok", "so", "and", "but", "i", "it", "that", "this"]);
const MAX_SWAP = 3;

function backtrack(ts: Tok[]): Tok[] {
  const out: Tok[] = [];
  // Where each sentence in `out` begins, ascending.
  const starts = [0];
  const push = (t: Tok) => { out.push({ ...t }); if (ENDS.test(t.post)) starts.push(out.length); };
  const cut = (to: number) => { out.length = to; while (starts.length > 1 && starts[starts.length - 1]! > to) starts.pop(); };
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!, w = lc(t), next = ts[i + 1];
    // "scratch that", closed by a pause: the sentence so far goes, or the last one if this one has not begun.
    if (w === "scratch" && lc(next) === "that" && (next!.post || i + 2 === ts.length)) {
      const cur = starts[starts.length - 1]!;
      cut(out.length > cur ? cur : starts[starts.length - 2] ?? 0);
      i += 1;
      continue;
    }
    const k = w === "actually" ? 1 : (w === "no" && lc(next) === "wait") || (w === "wait" && lc(next) === "no") ? 2 : 0;
    const prev = out[out.length - 1];
    if (k && prev && PAUSE.test(prev.post) && !ENDS.test(ts[i + k - 1]!.post)) {
      // The correction runs to the next pause, and is only a swap when it is short.
      const fix: Tok[] = [];
      for (let j = i + k; j < ts.length && fix.length <= MAX_SWAP; j++) {
        fix.push({ ...ts[j]! });
        if (/[,.!?;…]/.test(ts[j]!.post)) break;
      }
      const n = fix.length, said = out.length - starts[starts.length - 1]!;
      const swap = n >= 1 && n <= MAX_SWAP && said > n
        && (n === 1 ? !NOT_A_SWAP.has(lc(fix[0])) : lc(fix[0]) === lc(out[out.length - n]) || lc(fix[n - 1]) === lc(prev));
      if (swap) {
        cut(out.length - n);
        // The pause that closed the correction was only a pause.
        fix[n - 1]!.post = fix[n - 1]!.post.replace(/,$/, "");
        fix.forEach(push);
        i += k + n - 1;
        continue;
      }
    }
    push(t);
  }
  return out;
}

const CARDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** The item number a marker at `i` says, its kind and how many words it takes, or null. */
function marker(ts: Tok[], i: number): { n: number; kind: string; len: number } | null {
  const w = lc(ts[i]);
  if (w === "number" && !ts[i]!.post) {
    const n = CARDINALS.indexOf(lc(ts[i + 1])) + 1;
    return n ? { n, kind: "number", len: 2 } : null;
  }
  // Said as a heading, it is followed by a pause: "One, milk." "First, open it."
  if (!/[,.:]/.test(ts[i]!.post)) return null;
  const c = CARDINALS.indexOf(w) + 1;
  if (c) return { n: c, kind: "cardinal", len: 1 };
  const o = ORDINALS.indexOf(w) + 1;
  return o ? { n: o, kind: "ordinal", len: 1 } : null;
}

function lists(ts: Tok[]): Tok[] {
  // Pass one: the markers that count up from one at a pause, two or more in a row.
  const items = new Map<number, number>(); // token index -> item number
  let run: { at: number; n: number }[] = [], kind = "";
  const close = () => { if (run.length >= 2) for (const m of run) items.set(m.at, m.n); run = []; };
  for (let i = 0; i < ts.length; i++) {
    const atPause = i === 0 || PAUSE.test(ts[i - 1]!.post) || ENDS.test(ts[i - 1]!.post);
    const m = atPause ? marker(ts, i) : null;
    if (!m) continue;
    if (run.length && m.kind === kind && m.n === run[run.length - 1]!.n + 1) run.push({ at: i, n: m.n });
    else if (m.n === 1) { close(); run = [{ at: i, n: 1 }]; kind = m.kind; }
    i += m.len - 1;
  }
  close();
  if (!items.size) return ts;
  // Pass two: each marker becomes a numbered line, and what ended an item is dropped.
  const out: Tok[] = [];
  for (let i = 0; i < ts.length; i++) {
    const n = items.get(i);
    if (n === undefined) { out.push({ ...ts[i]! }); continue; }
    const before = out[out.length - 1];
    if (before) before.post = n === 1 ? before.post.replace(/[,.;:]*$/, ":") : before.post.replace(/[,.;]+$/, "");
    i += lc(ts[i]) === "number" ? 1 : 0;
    const head = ts[i + 1];
    if (!head) break;
    out.push({ ...head, pre: `${n}. ${head.pre}`, line: true });
    i += 1;
  }
  const last = out[out.length - 1]!;
  last.post = last.post.replace(/[,.;]+$/, "");
  return out;
}

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = new Map([["thousand", 1e3], ["million", 1e6], ["billion", 1e9]]);
const isTens = (w: string) => TENS.indexOf(w) >= 2;
const isNumberWord = (w: string) => SMALL.includes(w) || isTens(w) || w === "hundred" || SCALES.has(w)
  || w.split("-").length === 2 && isTens(w.split("-")[0]!) && SMALL.indexOf(w.split("-")[1]!) > 0;

/** Reads number words from `i` on. `broken`: the run ran into a number word it
 *  could not take, so it is not one number ("twenty twenty six", a phone number). */
function readNumber(ts: Tok[], i: number): { value: number; len: number; broken: boolean } {
  let total = 0, cur = 0, j = i, scale = Infinity, last = "";
  for (; j < ts.length; j++) {
    const t = ts[j]!, w = lc(t);
    if (t.pre && j > i) break;
    const parts = w.split("-");
    if (w === "and" && (last === "hundred" || last === "scale") && isNumberWord(lc(ts[j + 1])) && !ts[j + 1]!.pre && !t.post) { last = "and"; continue; }
    const small = SMALL.indexOf(w), tens = TENS.indexOf(parts[0]!);
    if (parts.length === 2 && tens >= 2 && SMALL.indexOf(parts[1]!) > 0 && SMALL.indexOf(parts[1]!) < 10 && cur % 100 === 0) { cur += tens * 10 + SMALL.indexOf(parts[1]!); last = "small"; }
    else if (small >= 10 && cur % 100 === 0 && last !== "small") { cur += small; last = "small"; }
    else if (small >= 0 && small < 10 && cur % 10 === 0 && last !== "small" && !(small === 0 && cur)) { cur += small; last = "small"; }
    else if (parts.length === 1 && tens >= 2 && cur % 100 === 0 && last !== "small" && last !== "tens") { cur += tens * 10; last = "tens"; }
    else if (w === "hundred" && cur > 0 && cur < 10) { cur *= 100; last = "hundred"; }
    else if (SCALES.has(w) && cur > 0 && SCALES.get(w)! < scale) { scale = SCALES.get(w)!; total += cur * scale; cur = 0; last = "scale"; }
    else return { value: total + cur, len: j - i, broken: j > i && isNumberWord(w) };
    if (t.post) { j++; break; }
  }
  if (last === "and") j--;
  return { value: total + cur, len: j - i, broken: false };
}

function numbers(ts: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (!isNumberWord(lc(ts[i]))) { out.push(ts[i]!); continue; }
    const { value, len, broken } = readNumber(ts, i);
    if (broken) {
      // The whole stretch of number words stays as said.
      let j = i;
      while (j < ts.length && isNumberWord(lc(ts[j]))) out.push(ts[j++]!);
      i = j - 1;
      continue;
    }
    if (len === 0 || (len === 1 && value < 10)) { out.push(ts[i]!); continue; }
    const digits = value >= 10_000 ? value.toLocaleString("en-US") : String(value);
    out.push({ pre: ts[i]!.pre, core: digits, post: ts[i + len - 1]!.post });
    i += len - 1;
  }
  return out;
}

// "may" and "march" are verbs far more often than they are months.
const PROPER = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "april", "june", "july", "august", "september", "october", "november", "december"]);
const capital = (s: string) => s.replace(/\p{L}/u, (c) => c.toUpperCase());
/** Short enough to be a name, a search or a field, where a period would be in the way. */
const PERIOD_MIN_WORDS = 3;

function punctuate(ts: Tok[]): Tok[] {
  ts.forEach((t, i) => {
    const w = lc(t);
    if (w === "i" || w.startsWith("i'") || w.startsWith("i’") || PROPER.has(w)) t.core = capital(t.core);
    if (i === 0 || t.line || ENDS.test(ts[i - 1]!.post)) t.core = capital(t.core);
  });
  const last = ts[ts.length - 1];
  if (!last) return ts;
  last.post = last.post.replace(/[,;:]+$/, "");
  if (!ENDS.test(last.post) && !ts.some((t) => t.line) && ts.length >= PERIOD_MIN_WORDS && /\p{L}|\d/u.test(last.core)) last.post += ".";
  return ts;
}

/** `lang` is the speech language setting: "en", "auto" or another code. */
export function cleanup(text: string, rules: CleanupRules, lang = "en"): string {
  const trimmed = text.trim();
  if (lang !== "auto" && !lang.startsWith("en")) return trimmed;
  let ts = tokenize(trimmed);
  if (rules.fillers) ts = dropFillers(ts);
  if (rules.backtrack) ts = backtrack(ts);
  if (rules.lists) ts = lists(ts);
  if (rules.numbers) ts = numbers(ts);
  if (rules.punctuation) ts = punctuate(ts);
  return join(ts);
}
