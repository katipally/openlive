import { describe, expect, it } from "vitest";
import { filterCommands, type Command } from "./commandPalette";

const cmd = (id: string, label: string, group: string, keywords?: string): Command => ({ id, label, group, keywords, run: () => {} });

const ALL = [
  cmd("new", "New chat", "Actions", "call conversation"),
  cmd("theme", "Toggle theme", "Actions", "dark light appearance"),
  cmd("general", "General", "Settings", "appearance speech"),
  cmd("models", "Models", "Settings"),
];

const ids = (q: string) => filterCommands(ALL, q).map((g) => [g.group, g.items.map((c) => c.id)]);

describe("filterCommands", () => {
  it("returns everything, grouped in first-seen order, for an empty or blank query", () => {
    expect(ids("")).toEqual([["Actions", ["new", "theme"]], ["Settings", ["general", "models"]]]);
    expect(ids("   ")).toEqual(ids(""));
  });
  it("matches label, group and keywords, ignoring case and outer spaces", () => {
    expect(ids("  CHAT ")).toEqual([["Actions", ["new"]]]);
    expect(ids("settings")).toEqual([["Settings", ["general", "models"]]]);
    expect(ids("appearance")).toEqual([["Actions", ["theme"]], ["Settings", ["general"]]]);
  });
  it("drops groups left empty and returns nothing when nothing matches", () => {
    expect(ids("model")).toEqual([["Settings", ["models"]]]);
    expect(filterCommands(ALL, "zzz")).toEqual([]);
    expect(filterCommands([], "")).toEqual([]);
  });
  it("matches a substring anywhere, not only at a word start", () => {
    expect(ids("ogg")).toEqual([["Actions", ["theme"]]]);
  });
  it("ranks a label match above a keyword-only match", () => {
    const list = [cmd("flow", "Flow", "Settings", "trigger voice typing"), cmd("voice", "Voice", "Settings")];
    expect(filterCommands(list, "voice")[0].items.map((c) => c.id)).toEqual(["voice", "flow"]);
  });
});
