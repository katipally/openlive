import { describe, expect, it } from "vitest";
import type { ToolGroupWire } from "@openlive/shared";
import { asksFirst, chipOverflow, filterGroups, toolCount } from "./capabilities";

const group = (id: string, name: string, tools: [string, boolean][]): ToolGroupWire =>
  ({ id, name, icon: id, description: `${name} things`, enabled: true, tools: tools.map(([n, a]) => ({ name: n, description: `${n}.`, asksFirst: a })) });

const groups = [
  group("files", "Files", [["read_file", false], ["write_file", true], ["edit_file", true]]),
  group("shell", "Shell", [["shell", true]]),
];

describe("the Tools subtab", () => {
  it("shows the first chips and counts the rest", () => {
    expect(chipOverflow(["a", "b", "c", "d", "e"], 4)).toEqual({ shown: ["a", "b", "c", "d"], more: 1 });
    expect(chipOverflow(["a"], 4)).toEqual({ shown: ["a"], more: 0 });
    expect(chipOverflow([], 4)).toEqual({ shown: [], more: 0 });
  });

  it("finds a group by its name, its words or one of its tools", () => {
    expect(filterGroups(groups, "SHELL").map((g) => g.id)).toEqual(["shell"]);
    expect(filterGroups(groups, "edit_").map((g) => g.id)).toEqual(["files"]);
    expect(filterGroups(groups, "things")).toHaveLength(2);
    expect(filterGroups(groups, " ")).toHaveLength(2);
    expect(filterGroups(groups, "nothing")).toEqual([]);
  });

  it("counts every tool and those that ask first", () => {
    expect(toolCount(groups)).toBe(4);
    expect(toolCount([])).toBe(0);
    expect(groups.map(asksFirst)).toEqual([2, 1]);
  });
});
