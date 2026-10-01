import { describe, expect, it } from "vitest";
import type { MemoryWire, NoteWire } from "@openlive/shared";
import { budgetMeter, budgetSegments, filterNotes, noteProblem } from "./memory";

const n = (text: string, inUse = true, id = text): NoteWire => ({ id, text, inUse });
const wire = (notes: NoteWire[], used: number, budget = 2000): MemoryWire => ({ notes, used, budget, max: 300 });

describe("finding a note", () => {
  const all = [n("Their name is Ada."), n("They drink tea."), n("Lives in Oslo.")];
  it("matches the text, ignoring case and outer spacing", () => {
    expect(filterNotes(all, "  TEA ").map((x) => x.text)).toEqual(["They drink tea."]);
    expect(filterNotes(all, "xyz")).toEqual([]);
    expect(filterNotes(all, " ")).toHaveLength(3);
    expect(filterNotes([], "a")).toEqual([]);
  });
});

describe("a note being typed", () => {
  const all = [n("Likes tea.", true, "a"), n("Lives in Oslo.", true, "b")];
  it("says nothing while it is empty", () => {
    expect(noteProblem("   ", all)).toBe("");
  });
  it("counts the length after spacing is tidied, as the server does", () => {
    expect(noteProblem(`a${" ".repeat(50)}b`, all)).toBe("");
    expect(noteProblem("x".repeat(240), all)).toBe("");
    expect(noteProblem("x".repeat(241), all)).toBe("Keep it to 240 characters; this is 241.");
  });
  it("refuses a duplicate in other case or spacing, but not the note's own text", () => {
    expect(noteProblem("  likes   TEA. ", all)).toBe("That is already remembered.");
    expect(noteProblem("LIKES tea.", all, "a")).toBe("");
    expect(noteProblem("likes tea.", all, "b")).toBe("That is already remembered.");
  });
});

describe("the budget meter", () => {
  it("reads empty, and a budget of nothing, as zero", () => {
    expect(budgetMeter(wire([], 0))).toEqual({ pct: 0, unused: 0, tone: "ok" });
    expect(budgetMeter(wire([], 5, 0)).pct).toBe(0);
  });
  it("turns to near at 80% and to full once a note is left out", () => {
    expect(budgetMeter(wire([n("a")], 1599)).tone).toBe("ok");
    expect(budgetMeter(wire([n("a")], 1600))).toMatchObject({ pct: 80, tone: "near" });
    expect(budgetMeter(wire([n("a"), n("b", false), n("c", false)], 1990))).toEqual({ pct: 100, unused: 2, tone: "full" });
  });
  it("never reads past 100%", () => {
    expect(budgetMeter(wire([n("a")], 9000)).pct).toBe(100);
  });
});

describe("the budget bar", () => {
  it("draws each note in use by its cost, what is left, then each note past the budget", () => {
    const segs = budgetSegments(wire([n("abc"), n("de"), n("old", false)], 9, 20));
    expect(segs).toEqual([
      { key: "abc", weight: 6, kind: "used" },
      { key: "de", weight: 5, kind: "used" },
      { key: "free", weight: 11, kind: "free" },
      { key: "old", weight: 6, kind: "unused" },
    ]);
  });

  it("is all free with no notes, and has no free part once the budget is spent", () => {
    expect(budgetSegments(wire([], 0))).toEqual([{ key: "free", weight: 2000, kind: "free" }]);
    expect(budgetSegments(wire([n("a")], 2000)).map((x) => x.kind)).toEqual(["used"]);
  });

  it("folds hundreds of notes into a bounded bar, keeping the total", () => {
    const many = Array.from({ length: 300 }, (_, i) => n(`note ${i}`, i < 100, `id${i}`));
    const segs = budgetSegments(wire(many, 2000), 40);
    expect(segs.filter((x) => x.kind === "used")).toHaveLength(40);
    expect(segs.filter((x) => x.kind === "unused")).toHaveLength(40);
    expect(segs.at(-1)).toMatchObject({ key: "unused-rest" });
    const cost = (list: NoteWire[]) => list.reduce((w, x) => w + x.text.length + 3, 0);
    expect(segs.filter((x) => x.kind === "used").reduce((w, x) => w + x.weight, 0)).toBe(cost(many.slice(0, 100)));
  });
});
