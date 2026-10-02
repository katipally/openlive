import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "ol-notes-"));
process.env.OPENLIVE_HOME = dir;
const { getMemory, updateMemory } = await import("@openlive/db");
const { NOTES_BUDGET_CHARS, NOTES_MAX, noteCost } = await import("@openlive/shared");
const notes = await import("./notes.ts");
const { rememberedNotes } = await import("../prompt.ts");
const { ASSISTANT_TOOLS } = await import("../capabilities/assistant.ts");

afterAll(() => {
  delete process.env.OPENLIVE_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const stored = () => getMemory() as unknown[];
const seed = (v: unknown) => updateMemory(() => v);
const note = (text: string, id = text) => ({ id, text });
const remember = (n: string) => ASSISTANT_TOOLS.find((t) => t.name === "remember")!.execute({ note: n } as never, {} as never);
const said = async (n: string) => ((await remember(n)).content[0] as { text: string }).text;

beforeEach(() => seed([]));

describe("reading the stored notes", () => {
  it("reads the old array of strings, in order, with an id that does not move", () => {
    const a = notes.parseNotes(["Their name is Ada.", "They drink tea."]);
    expect(a.map((n) => n.text)).toEqual(["Their name is Ada.", "They drink tea."]);
    expect(a.every((n) => n.id && n.at === undefined)).toBe(true);
    expect(notes.parseNotes(["Their name is Ada.", "They drink tea."]).map((n) => n.id)).toEqual(a.map((n) => n.id));
    expect(new Set(a.map((n) => n.id)).size).toBe(2);
  });

  it("keeps a repeated string as its own note, and mixes both shapes", () => {
    const a = notes.parseNotes(["x", "x", { id: "k", text: "y", at: 5 }, "", 7, null, { text: "  " }]);
    expect(a.map((n) => n.text)).toEqual(["x", "x", "y"]);
    expect(new Set(a.map((n) => n.id)).size).toBe(3);
    expect(a[2]).toEqual({ id: "k", text: "y", at: 5 });
  });

  it("is empty for nothing and for anything that is not an array", () => {
    for (const raw of [undefined, "", "{", {}, 3, null]) expect(notes.parseNotes(raw)).toEqual([]);
  });

  it("stores the old array as notes on the next write and loses none", async () => {
    await seed(["Their name is Ada.", "They drink tea."]);
    const before = notes.readNotes();
    const r = await notes.addNote("They live in Oslo.");
    expect(r.ok).toBe(true);
    expect(stored().map((n: { text: string }) => n.text)).toEqual(["Their name is Ada.", "They drink tea.", "They live in Oslo."]);
    expect(stored().slice(0, 2).map((n: { id: string }) => n.id)).toEqual(before.map((n) => n.id));
    expect(stored()[2].at).toEqual(expect.any(Number));
  });
});

describe("saving a note", () => {
  it("cleans it to one line of at most 240 characters", async () => {
    await notes.addNote(`  Likes\n  tea ${"x".repeat(300)}`);
    expect(stored()[0].text).toHaveLength(240);
    expect(stored()[0].text.startsWith("Likes tea x")).toBe(true);
    expect(await notes.addNote(" \n ")).toEqual({ ok: false, reason: "empty" });
  });

  it("skips an exact, or a case and spacing, duplicate", async () => {
    expect((await notes.addNote("Likes tea.")).ok).toBe(true);
    for (const again of ["Likes tea.", "likes TEA.", "  Likes   tea.  ", "Likes\ttea."]) expect(await notes.addNote(again)).toEqual({ ok: false, reason: "duplicate" });
    expect((await notes.addNote("Likes tea")).ok).toBe(true);
    expect(stored()).toHaveLength(2);
  });

  it("is full at the limit, and says so rather than dropping the oldest", async () => {
    await seed(Array.from({ length: NOTES_MAX }, (_, i) => `fact ${i}`));
    expect(await notes.addNote("one more")).toEqual({ ok: false, reason: "full" });
    expect(stored()).toHaveLength(NOTES_MAX);
    expect(stored()[0].text).toBe("fact 0");
  });

  it("does not lose a note when two arrive together", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => notes.addNote(`fact ${i}`)));
    expect(stored()).toHaveLength(12);
  });
});

describe("the remember tool", () => {
  it("saves, and answers a repeat and an empty note plainly", async () => {
    expect(await said("They drink tea.")).toBe("Remembered.");
    expect(await said("they drink  TEA.")).toBe("Already remembered.");
    expect(await said("  ")).toBe("Nothing to remember.");
    expect(stored().map((n: { text: string }) => n.text)).toEqual(["They drink tea."]);
  });

  it("tells the model when memory is full", async () => {
    await seed(Array.from({ length: NOTES_MAX }, (_, i) => `fact ${i}`));
    expect(await said("one more")).toContain("Settings, Memory");
  });
});

describe("the prompt budget", () => {
  const long = (i: number) => `${String(i).padStart(3, "0")} ${"x".repeat(236)}`;

  it("takes the newest notes that fit, listed oldest first", () => {
    const all = Array.from({ length: 12 }, (_, i) => note(long(i)));
    const { inUse, used } = notes.budgeted(all);
    const fit = Math.floor(NOTES_BUDGET_CHARS / noteCost(long(0)));
    expect(inUse.map((n) => n.id)).toEqual(all.slice(12 - fit).map((n) => n.id));
    expect(fit).toBe(8);
    expect(used).toBe(fit * noteCost(long(0)));
  });

  it("holds everything while it fits, exactly to the cap, and nothing from an empty list", () => {
    const edge = [note("x".repeat(NOTES_BUDGET_CHARS - 3))];
    expect(notes.budgeted(edge)).toEqual({ inUse: edge, used: NOTES_BUDGET_CHARS });
    expect(notes.budgeted([note("a"), ...edge]).inUse).toEqual(edge);
    expect(notes.budgeted([])).toEqual({ inUse: [], used: 0 });
  });

  it("stops at the first note that does not fit instead of letting older small ones past it", () => {
    const all = [note("small old"), note("x".repeat(NOTES_BUDGET_CHARS)), note("small new")];
    expect(notes.budgeted(all).inUse.map((n) => n.text)).toEqual(["small new"]);
  });

  it("marks the rest as not in use on the wire, newest first, and keeps them stored", async () => {
    await seed(Array.from({ length: 12 }, (_, i) => long(i)));
    const w = notes.memoryWire();
    expect(w.notes.map((n) => n.inUse)).toEqual([...Array(8).fill(true), ...Array(4).fill(false)]);
    expect(w.notes[0]!.text).toBe(long(11));
    expect(w).toMatchObject({ used: 8 * noteCost(long(0)), budget: NOTES_BUDGET_CHARS, max: NOTES_MAX });
    expect(stored()).toHaveLength(12);
  });

  it("is what every prompt carries", async () => {
    expect(rememberedNotes()).toBe("");
    await seed(Array.from({ length: 12 }, (_, i) => long(i)));
    const p = rememberedNotes();
    expect(p).toContain(`- ${long(11)}`);
    expect(p).toContain(`- ${long(4)}`);
    expect(p).not.toContain(long(3));
    expect(p.indexOf(long(4))).toBeLessThan(p.indexOf(long(11)));
  });
});

describe("editing and deleting", () => {
  it("edits in place, keeping the id and time, and refuses what duplicates another note", async () => {
    await notes.addNote("Likes tea.");
    const b = await notes.addNote("Lives in Oslo.");
    const id = b.ok ? b.note.id : "";
    expect(await notes.editNote(id, "likes TEA.")).toEqual({ ok: false, reason: "duplicate" });
    expect(await notes.editNote(id, " ")).toEqual({ ok: false, reason: "empty" });
    expect(await notes.editNote("nope", "x")).toEqual({ ok: false, reason: "missing" });
    expect((await notes.editNote(id, "LIVES in Oslo.")).ok).toBe(true);
    expect(stored()[1]).toMatchObject({ id, text: "LIVES in Oslo.", at: expect.any(Number) });
  });

  it("deletes one by id, and clears all", async () => {
    await seed(["a", "b", "c"]);
    const [a, b] = notes.readNotes();
    expect(await notes.deleteNote(a!.id)).toBe(true);
    expect(await notes.deleteNote(a!.id)).toBe(false);
    expect(notes.readNotes().map((n) => n.id)).toContain(b!.id);
    await notes.clearNotes();
    expect(stored()).toEqual([]);
  });
});
