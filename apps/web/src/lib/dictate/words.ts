// Dictate's word lists, on this machine: the dictionary spells the user's
// names and jargon their way, a snippet said alone types its text, and a
// spoken command at the end of what was said presses a key instead of typing
// its words. Each is a lookup in a map keyed by a normalized form, built once
// per list, so a dictation costs O(n) in its words whatever the lists hold.
// All of it leans conservative, as cleanup does: unsure, the words go in as said.

/** Letters and digits only, lower case: "Open-Live" and "open live" are both "openlive". */
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** Lower case words with the punctuation gone: "My address!" is "my address". */
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, "").trim().split(/\s+/).filter(Boolean).join(" ");

/** Built once per list: the settings hand over the same array until they change. */
function memo<K extends object, V>(build: (k: K) => V) {
  const cache = new WeakMap<K, V>();
  return (k: K) => { let v = cache.get(k); if (!v) cache.set(k, v = build(k)); return v; };
}

// ── dictionary ────────────────────────────────────────────────────────────

/** The longest run of spoken words one entry may be heard as ("kati pally yashwanth reddy"). */
const MAX_SPAN = 5;
/** Words common enough that a capital on them is more likely wrong than a name:
 *  an entry "Will" must not turn every "will" into one. */
const COMMON = new Set(("a an and are as at be but by can do for from go had has have he her him his how i if in is it its just "
  + "me my no not of on or our out she so than that the their them then there these they this to too up us was we were what when "
  + "where which who will with would you your may might must shall should could did does get got make made new now one two all "
  + "any some more most very well good great back over only also into like time day way year mark bill grace hope joy rose sue "
  + "pat max art june august april chase hunter faith summer autumn dawn guy sky will bob jack page ray rich frank miles").split(" "));

/** Whether swapping only the case of one word to `entry` is safe: a capital
 *  inside it (OpenLive, tRPC), all capitals (GSAP), or a word too rare to be
 *  anything but the name. */
const caseSafe = (entry: string) => /\p{Ll}\p{Lu}/u.test(entry) || entry === entry.toUpperCase() || !COMMON.has(entry.toLowerCase());

const dictionary = memo((entries: readonly string[]) => {
  const map = new Map<string, string>();
  for (const e of entries) { const k = squash(e); if (k.length > 1) map.set(k, e); }
  return map;
});

const POSSESSIVE = /['’]s$/i;

/**
 * Each run of up to MAX_SPAN words whose letters and digits, joined, match an
 * entry is written as that entry: "open live" and "Openlive" become "OpenLive".
 * A run never crosses a comma, a period or a line, and a lone common word only
 * changes case when caseSafe says so. Longest match first.
 * O(n x MAX_SPAN) map lookups for n words.
 */
export function applyDictionary(text: string, entries: readonly string[]): string {
  const map = dictionary(entries);
  if (!map.size) return text;
  // Words at even indexes, the whitespace between them at odd ones.
  const parts = text.split(/(\s+)/);
  const word = (i: number) => /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(parts[i]!)!;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const first = word(i);
    let hit: { end: number; entry: string; tail: string } | null = null;
    let key = "";
    for (let j = i, n = 0; j < parts.length && n < MAX_SPAN; j += 2, n++) {
      const w = word(j);
      if (j > i && (parts[j - 1]!.includes("\n") || w[1] || word(j - 2)[3])) break;
      const core = w[2]!.replace(POSSESSIVE, "");
      key += squash(core);
      const entry = map.get(key);
      if (entry && entry !== first[2] && (n > 0 || entry.toLowerCase() !== core.toLowerCase() || caseSafe(entry))) {
        hit = { end: j, entry, tail: w[2]!.slice(core.length) + w[3] };
      }
    }
    if (!hit) { out.push(parts[i]!, parts[i + 1] ?? ""); continue; }
    out.push(first[1] + hit.entry + hit.tail, parts[hit.end + 1] ?? "");
    i = hit.end;
  }
  return out.join("");
}

// ── snippets ──────────────────────────────────────────────────────────────

export interface Snippet { trigger: string; text: string }

const snippetMap = memo((list: readonly Snippet[]) => new Map(list.map((s) => [words(s.trigger), s.text] as const).filter(([k]) => k)));

/** The snippet's text when the whole of `said` is its trigger, case and
 *  punctuation aside ("My address." for "my address"), else null. O(n). */
export function snippetFor(said: string, snippets: readonly Snippet[]): string | null {
  return snippets.length ? snippetMap(snippets).get(words(said)) ?? null : null;
}

// ── spoken commands ───────────────────────────────────────────────────────

export type SpokenCommand = "enter" | "newLine" | "newParagraph" | "undo" | "stop";

const PHRASES: [SpokenCommand, string][] = [
  ["enter", "press enter"], ["enter", "press return"],
  ["newLine", "new line"], ["newLine", "newline"],
  ["newParagraph", "new paragraph"],
  ["undo", "undo that"],
  ["stop", "stop dictating"], ["stop", "stop dictation"],
];
/** Taking back the last insertion only makes sense said on its own. */
const ALONE_ONLY = new Set<SpokenCommand>(["undo"]);
/** A pause or a sentence end before a command at the tail: "Sounds good. Press enter." */
const BOUNDARY = /[.,!?;:…]$/;

/**
 * The command `said` ends with, and what was said before it, when the command
 * is all of it or follows a sentence end or a pause. "I will press enter later"
 * and "tell him to press enter" are words, not commands. `on` are the ones
 * switched on. English only, as cleanup is. O(n).
 */
export function spokenCommand(said: string, on: ReadonlySet<SpokenCommand>): { command: SpokenCommand; before: string } | null {
  const tokens = said.trim().split(/\s+/).filter(Boolean);
  const cores = tokens.map(words);
  for (const [command, phrase] of PHRASES) {
    if (!on.has(command)) continue;
    const k = phrase.split(" ").length;
    const n = tokens.length;
    if (n < k || cores.slice(n - k).join(" ") !== phrase) continue;
    if (n === k) return { command, before: "" };
    if (ALONE_ONLY.has(command) || !BOUNDARY.test(tokens[n - k - 1]!)) continue;
    return { command, before: tokens.slice(0, n - k).join(" ") };
  }
  return null;
}
