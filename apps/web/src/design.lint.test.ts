import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// The design system's guard rail (docs/DESIGN.md). Every value comes from the
// tokens in app/globals.css and lib/motion.ts, and every shared control from
// components/ui. This reads apps/web/src once, O(total source), and names each
// place that drifts, so a new screen cannot quietly bring back its own button,
// colour or z-index. An exception is one ALLOW row with the reason it has to be.
//
// Text scanning, not a parser: the repo's TypeScript is the native compiler,
// which has no JS API. Comments are blanked first, so prose never trips it.

const SRC = import.meta.dirname;
const UI = "components/ui/";

type Rule =
  | "native-title" | "native-control" | "color-literal" | "arbitrary-value" | "off-scale"
  | "raw-duration" | "gsap" | "kit-deep-import" | "kit-shadow" | "icon-node-key";

const ALLOW: { rule: Rule; file: string; reason: string }[] = [
  { rule: "color-literal", file: "lib/waveOrb.ts", reason: "The orb's canvas palettes: pixels, not CSS, and the orb's look is deferred." },
  { rule: "color-literal", file: "app/global-error.tsx", reason: "Renders when the app itself failed, so it cannot lean on globals.css." },
  { rule: "color-literal", file: "components/live/Composer.tsx", reason: "A canvas fill under a pasted picture, so a transparent PNG does not turn black as a JPEG." },
  { rule: "arbitrary-value", file: "components/flow/FlowOrb.tsx", reason: "The orb window's look is deferred (build plan)." },
  { rule: "raw-duration", file: "components/settings/VoicesSettings.tsx", reason: "duration-1000 is the one-second recording clock the bar follows, not a motion choice." },
];

const RULES: Record<Rule, string> = {
  "native-title": "native title= tooltips (use the kit Tooltip; aria-label names an icon)",
  "native-control": "native <select> or <input type=range|checkbox|radio> outside components/ui",
  "color-literal": "raw colour literals (hex, rgb, hsl, oklch): use a colour token",
  "arbitrary-value": "hand-picked [..] values for radius, type, z-index, shadow, colour or motion: use a token",
  "off-scale": "Tailwind defaults off our scale (text-lg, rounded-2xl, shadow-md, z-50, bg-red-500, bare shadow or rounded)",
  "raw-duration": "raw durations or curves (duration-300, { duration: 0.3 }): use lib/motion.ts or a --dur token",
  "gsap": "gsap outside the Flow orb",
  "kit-deep-import": "deep imports into components/ui: import from @/components/ui",
  "kit-shadow": "a local component named like a kit one",
  "icon-node-key": "a createLucideIcon node without a key (React warns: lucide renders the nodes as a list)",
};

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return files(p);
  return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
});

const PALETTE = "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
const VARIANTS = String.raw`(?<![\w-])(?:[\w-]+(?:-\[[^\]\s]*\])?:)*!?-?`;
// Families whose value must be a token: any [..] or (--..) value is hand-picked.
const ARBITRARY = new RegExp(VARIANTS + String.raw`(?:rounded(?:-[a-z]{1,2})?|text|z|shadow|drop-shadow|inset-shadow|bg|border(?:-[a-z])?|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|placeholder|ease|duration|delay|animate)-[[(][^\s"'\`]*`, "g");
const OFF_SCALE = new RegExp(VARIANTS + String.raw`(?:rounded(?:-[a-z]{1,2})?-(?:xs|2xl|3xl|4xl)|text-(?:xs|sm|base|lg|xl|[2-9]xl)|shadow-(?:sm|md|lg|xl|2xl|inner)|z-(?:[4-9]\d|\d{3,})|[a-z-]+-(?:${PALETTE})-\d{2,3})(?![\w-])`, "g");
const DURATION = new RegExp(VARIANTS + String.raw`(?:duration|delay)-\d+(?![\w-])`, "g");
const MOTION_LITERAL = /\b(?:duration|visualDuration|bounce):\s*\d[\d.]*|\bease:\s*\[/g;
const COLOR = /#[0-9a-fA-F]{3,8}(?![\w-])|\b(?:rgba?|hsla?|oklch|oklab|lch|color-mix)\(/g;
// A class list that says just "shadow" or "rounded": both are Tailwind's default, not ours.
const BARE = /["'`\s](?:[\w-]+:)*(?:shadow|rounded)(?=["'`\s])/g;
// One ["tag", { ...attrs }] entry of a hand-made lucide icon.
const ICON_NODE = /\[\s*"[a-z]+",\s*\{[^}]*\}\s*\]/g;
const CLASS_STRING = /(?:className=|cn\(|clsx\()[^;]*?["'`][^"'`]*["'`]/g;

/** Comments become spaces, so offsets (and line numbers) survive. */
const blankComments = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

/** The text of the JSX tag opening at `i`, with every {...} expression blanked,
 *  so an attribute holding an arrow (`=>`) or a nested tag does not end it early. */
function tagAt(s: string, i: number): string {
  let depth = 0, quote = "", out = "";
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (quote) { if (c === quote) quote = ""; if (!depth) out += c; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (!depth && (c === '"' || c === "'")) quote = c;
    else if (!depth && c === ">") return out + c;
    if (depth && (c === '"' || c === "'" || c === "`")) quote = c;
    if (!depth) out += c;
  }
  return out;
}

interface Hit { rule: Rule; file: string; line: number; text: string }

function lint(): Hit[] {
  const kitNames = new Set<string>();
  for (const f of files(join(SRC, UI))) for (const m of readFileSync(f, "utf8").matchAll(/^export (?:function|const) ([A-Z]\w*)/gm)) kitNames.add(m[1]!);

  const hits: Hit[] = [];
  for (const abs of files(SRC)) {
    const file = relative(SRC, abs).split(sep).join("/");
    // The kit itself is held to the same values; only it may wrap the native controls.
    const kit = file.startsWith(UI);
    const s = blankComments(readFileSync(abs, "utf8"));
    const lineOf = (i: number) => s.slice(0, i).split("\n").length;
    const all = (rule: Rule, re: RegExp, text = s, base = 0) => {
      for (const m of text.matchAll(re)) hits.push({ rule, file, line: lineOf(base + m.index!), text: m[0].trim() });
    };

    all("color-literal", COLOR);
    all("arbitrary-value", ARBITRARY);
    all("off-scale", OFF_SCALE);
    all("raw-duration", DURATION);
    if (file !== "lib/motion.ts" && file !== "lib/gsap.ts") all("raw-duration", MOTION_LITERAL);
    for (const m of s.matchAll(CLASS_STRING)) all("off-scale", BARE, m[0], m.index);
    for (const m of s.matchAll(/createLucideIcon\([\s\S]*?\]\s*\)/g))
      for (const n of m[0].matchAll(ICON_NODE)) if (!/\bkey:/.test(n[0])) hits.push({ rule: "icon-node-key", file, line: lineOf(m.index! + n.index!), text: n[0].slice(0, 40) });

    for (const m of s.matchAll(/(?<![\w.$])<([a-z][a-z0-9]*)(?=[\s/>])/g)) {
      const tag = tagAt(s, m.index!);
      const at = { file, line: lineOf(m.index!) };
      // A native tooltip is slow, unstyled and unreachable by touch or keyboard.
      if (m[1] !== "iframe" && /\stitle=/.test(tag)) hits.push({ rule: "native-title", ...at, text: `<${m[1]} title>` });
      if (!kit && (m[1] === "select" || m[1] === "input" && /\stype="(range|checkbox|radio)"/.test(tag))) hits.push({ rule: "native-control", ...at, text: tag.slice(0, 60) });
    }

    for (const m of s.matchAll(/^import [^;]*?from "([^"]+)"/gm)) {
      const from = m[1]!;
      if (/^(gsap|@gsap\/react|@\/lib\/gsap)$/.test(from) && file !== "lib/gsap.ts" && file !== "components/flow/FlowOrb.tsx") hits.push({ rule: "gsap", file, line: lineOf(m.index!), text: from });
      if (from.startsWith("@/components/ui/")) hits.push({ rule: "kit-deep-import", file, line: lineOf(m.index!), text: from });
    }
    if (!kit) for (const m of s.matchAll(/(?:^|\s)(?:function|const|let|class)\s+([A-Z]\w*)\b/g))
      if (kitNames.has(m[1]!)) hits.push({ rule: "kit-shadow", file, line: lineOf(m.index!), text: m[1]! });
  }
  return hits;
}

describe("design lint", () => {
  const raw = lint();
  const hits = raw.filter((h) => !ALLOW.some((a) => a.rule === h.rule && a.file === h.file));
  for (const [rule, what] of Object.entries(RULES) as [Rule, string][]) {
    it(`has no ${what}`, () => {
      expect(hits.filter((h) => h.rule === rule).map((h) => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
    });
  }

  it("keeps every exception live, so a fixed one leaves the list", () => {
    for (const a of ALLOW) expect(raw.some((h) => h.rule === a.rule && h.file === a.file), `${a.rule} ${a.file}`).toBe(true);
  });

  it("catches what it is meant to", () => {
    const probe = blankComments(`// text-lg rounded-2xl\nconst a = "z-[99] shadow-[0_0_1px_red] md:hover:rounded-[5px] bg-red-500/40 duration-300 text-body";`);
    expect([...probe.matchAll(ARBITRARY)].map((m) => m[0].trim())).toEqual(["z-[99]", "shadow-[0_0_1px_red]", "md:hover:rounded-[5px]"]);
    expect([...probe.matchAll(OFF_SCALE)].map((m) => m[0].trim())).toEqual(["bg-red-500"]);
    expect([...probe.matchAll(DURATION)].map((m) => m[0].trim())).toEqual(["duration-300"]);
    expect([...`createLucideIcon("x", [["path", { d: "M1 1" }], ["circle", { r: "2", key: "k" }]])`.matchAll(ICON_NODE)].map((m) => /\bkey:/.test(m[0]))).toEqual([false, true]);
    expect(tagAt(`<input onChange={(e) => go(e)} type="range" />`, 0)).toMatch(/type="range"/);
  });
});
