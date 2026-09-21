// A tolerant reader for tool arguments that are still streaming. Providers hand
// out raw JSON fragments, so the accumulated text is almost always mid-string,
// mid-key or mid-number. This turns the fragment into the best object available
// right now, which is what lets `insert_text` start landing characters in the
// user's app before the model has finished writing the call.
//
// Pure, dependency-free, and deliberately conservative: when a fragment cannot
// be repaired into an object it yields `{}`, never a guess at missing values.

interface Scan {
  /** Closers for every container still open at the end of the fragment. */
  closers: string;
  /** End index of the last prefix that is structurally complete, or -1. */
  safeEnd: number;
  /** Closers for the container stack at `safeEnd`. */
  safeClose: string;
}

/** Walk one string literal from its opening quote. */
function scanString(src: string, start: number): { end: number; complete: boolean } {
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") { i++; continue; }
    if (c === '"') return { end: i + 1, complete: true };
  }
  return { end: src.length, complete: false };
}

function scan(src: string): Scan {
  const stack: boolean[] = []; // true = object
  const closersOf = () => {
    let s = "";
    for (let i = stack.length - 1; i >= 0; i--) s += stack[i] ? "}" : "]";
    return s;
  };
  let expect: "value" | "key" | "colon" | "comma" = "value";
  let safeEnd = -1;
  let safeClose = "";
  const mark = (end: number) => { safeEnd = end; safeClose = closersOf(); };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\n" || c === "\t" || c === "\r") { i++; continue; }

    if (expect === "comma") {
      if (c === ",") { i++; expect = stack[stack.length - 1] ? "key" : "value"; continue; }
      if (c === "}" || c === "]") { stack.pop(); i++; mark(i); continue; }
      break;
    }
    if (expect === "colon") {
      if (c !== ":") break;
      i++; expect = "value"; continue;
    }
    if (expect === "key") {
      if (c === "}") { stack.pop(); i++; expect = "comma"; mark(i); continue; }
      if (c !== '"') break;
      const s = scanString(src, i);
      if (!s.complete) break;
      i = s.end; expect = "colon"; continue;
    }
    // expect === "value"
    // Opening a container is NOT a safe cut point: cutting there would invent an
    // empty element the model never wrote. Only a completed value is safe.
    if (c === "{" || c === "[") { stack.push(c === "{"); i++; expect = c === "{" ? "key" : "value"; continue; }
    if (c === "]") { if (!stack.length || stack[stack.length - 1]) break; stack.pop(); i++; expect = "comma"; mark(i); continue; }
    if (c === '"') {
      const s = scanString(src, i);
      if (!s.complete) break;
      i = s.end; expect = "comma"; mark(i); continue;
    }
    const lit = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
    if (!lit) break;
    i += lit[0].length;
    // A literal that runs to the end of the fragment may still be growing
    // ("12" could become "123"), so it is not a safe cut point.
    if (i < src.length) { expect = "comma"; mark(i); continue; }
    break;
  }
  return { closers: closersOf(), safeEnd, safeClose };
}

// Drop a trailing escape the fragment cut in half, so closing the string does
// not turn `\` into `\"` or leave `\u26` behind. A lone high surrogate goes too:
// it is half a character the consumer would render as a replacement glyph.
function trimStringTail(s: string): string {
  let out = s.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  const slashes = /(\\+)$/.exec(out);
  if (slashes && slashes[1]!.length % 2 === 1) out = out.slice(0, -1);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Best object available from an accumulated JSON fragment, `{}` when there is none.
 *
 * Callers must be defensive about what comes back: a string value may be
 * truncated mid-word, an array may be missing its last elements, and a key whose
 * value has not arrived yet is simply absent.
 */
export function parsePartialJson(src: string): Record<string, unknown> {
  // Not trimmed: trailing whitespace inside a half-written string is content the
  // user asked for, and JSON ignores it everywhere else anyway.
  const head = src ?? "";
  if (!head.trim()) return {};
  const { closers, safeEnd, safeClose } = scan(head);

  const candidates = [
    head + closers,
    trimStringTail(head) + '"' + closers,
    head.replace(/,\s*$/, "") + closers,
    head.replace(/[.eE+-]+\s*$/, "") + closers,
    safeEnd >= 0 ? head.slice(0, safeEnd) + safeClose : null,
  ];
  for (const c of candidates) {
    if (c === null) continue;
    try {
      const v = JSON.parse(c) as unknown;
      if (isPlainObject(v)) return v;
    } catch { /* try the next repair */ }
  }
  return {};
}
