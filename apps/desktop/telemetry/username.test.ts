import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { usernameOf, ADJECTIVES, ANIMALS } = require("./username.cjs");
const { validateCommon } = require("./validate.cjs");

// A UUID-shaped ID for each number, spread the way random ones are.
const id = (n: number) => {
  const h = createHash("sha256").update(String(n)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const SHAPE = /^[a-z]{3,12}-[a-z]{3,12}-[0-9a-f]{8}$/;

// Roots that must not show up in a word, or where two words meet.
const BANNED = [
  "ass", "anal", "anus", "bitch", "boob", "butt", "cock", "cum", "cunt", "damn", "dick", "dyke", "fag", "fuck", "hell",
  "homo", "horny", "kill", "kkk", "nazi", "nig", "porn", "pube", "puss", "rape", "sex", "shit", "slut", "tit", "turd",
  "twat", "wank", "whore", "piss", "poo", "fart", "nude", "naked", "dead", "die", "hate", "gay", "jew", "jap", "paki",
  "spic", "coon", "chink", "tard", "drug", "weed", "meth", "crack", "gun", "bomb", "nsfw", "xxx",
];
// First names and nicknames that a word could be mistaken for.
const NAMES = [
  "amber", "ginger", "rusty", "sandy", "misty", "sunny", "ruby", "hazel", "olive", "ivy", "jade", "willow", "rose", "violet",
  "daisy", "lily", "penny", "sage", "dawn", "summer", "autumn", "faith", "hope", "joy", "grace", "coral", "scarlet", "frank",
  "ernest", "robin", "jay", "wren", "raven", "drake", "ray", "martin", "dory", "marlin", "chase", "hunter", "jasper", "buddy",
];

describe("usernameOf", () => {
  it("is adjective-animal plus the first eight characters of the ID, and the same every time", () => {
    const uuid = "6ee826eb-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const name = usernameOf(uuid);
    expect(name).toMatch(SHAPE);
    expect(name.endsWith("-6ee826eb")).toBe(true);
    expect(usernameOf(uuid)).toBe(name);
  });

  it("does not care about the case of the ID", () => {
    expect(usernameOf("6EE826EB-1C2D-4E5F-8A9B-0C1D2E3F4A5B")).toBe(usernameOf("6ee826eb-1c2d-4e5f-8a9b-0c1d2e3f4a5b"));
  });

  it("gives different IDs different names", () => {
    const names = new Set(Array.from({ length: 20_000 }, (_, i) => usernameOf(id(i))));
    expect(names.size).toBe(20_000);
    expect(usernameOf(id(1))).not.toBe(usernameOf(id(2)));
  });

  it("names nothing that is not an ID", () => {
    for (const v of ["", "not-an-id", "6ee826eb", null, undefined, 5, {}]) expect(usernameOf(v)).toBe("");
  });

  it("uses the words evenly, so no name is far more common than another", () => {
    const count = (words: string[], side: 0 | 1) => {
      const seen = new Map<string, number>(words.map((w) => [w, 0]));
      for (let i = 0; i < 40_000; i++) {
        const w = usernameOf(id(i)).split("-")[side]!;
        seen.set(w, seen.get(w)! + 1);
      }
      return [...seen.values()];
    };
    for (const [words, side] of [[ADJECTIVES, 0], [ANIMALS, 1]] as const) {
      const counts = count(words, side);
      const mean = 40_000 / words.length;
      expect(Math.min(...counts)).toBeGreaterThan(mean / 2);
      expect(Math.max(...counts)).toBeLessThan(mean * 2);
    }
  });

  it("carries over 46 bits, so 100,000 installs almost never share a name", () => {
    expect(Math.log2(ADJECTIVES.length * ANIMALS.length) + 32).toBeGreaterThan(46);
  });

  it("always fits the schema's pattern for the common username", () => {
    for (let i = 0; i < 2_000; i++) expect(validateCommon({ username: usernameOf(id(i)) })).toEqual({ username: usernameOf(id(i)) });
  });
});

describe("the word lists", () => {
  it.each([["adjectives", ADJECTIVES], ["animals", ANIMALS]])("%s: at least 128, unique, lowercase letters only, short", (_, words: string[]) => {
    expect(words.length).toBeGreaterThanOrEqual(128);
    expect(new Set(words).size).toBe(words.length);
    for (const w of words) expect(w, w).toMatch(/^[a-z]{3,12}$/);
  });

  it("share no word, so a name never repeats itself", () => {
    expect(ADJECTIVES.filter((w: string) => ANIMALS.includes(w))).toEqual([]);
  });

  it("hold no banned root, alone or where an adjective meets an animal", () => {
    const hits: string[] = [];
    for (const a of ADJECTIVES) for (const n of ANIMALS) for (const b of BANNED) if (`${a}${n}`.includes(b)) hits.push(`${a}-${n} has ${b}`);
    expect(hits).toEqual([]);
  });

  it("hold no first name a word could be taken for", () => {
    expect([...ADJECTIVES, ...ANIMALS].filter((w) => NAMES.includes(w))).toEqual([]);
  });
});
