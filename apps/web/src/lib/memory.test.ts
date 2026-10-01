import { describe, expect, it } from "vitest";
import type { MemoryWire, NoteWire } from "@openlive/shared";
import { budgetMeter, filterNotes, noteProblem } from "./memory";

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
