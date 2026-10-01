import { describe, expect, it } from "vitest";
import type { SkillImportSource, SkillWire } from "@openlive/shared";
import { filterSkills, initialPicks, newSkillProblem, pickKey, pickedItems } from "./skills";

const s = (name: string, description: string): SkillWire => ({ name, description, source: "user", dir: `/s/${name}`, enabled: true, resources: 0, warnings: [] });

describe("finding a skill", () => {
  const all = [s("pdf", "Merge PDFs."), s("review", "Review a pull request."), s("notes", "Meeting notes in the house style.")];
  it("matches the name or the description, ignoring case", () => {
    expect(filterSkills(all, "PULL").map((k) => k.name)).toEqual(["review"]);
    expect(filterSkills(all, "pd").map((k) => k.name)).toEqual(["pdf"]);
    expect(filterSkills(all, "  ")).toHaveLength(3);
    expect(filterSkills([], "x")).toEqual([]);
  });
});

describe("a new skill", () => {
  it("checks the name rule as it is typed, and nothing while it is empty", () => {
    expect(newSkillProblem("", "", [])).toEqual({ name: "", description: "" });
    expect(newSkillProblem("My Skill", "", []).name).toContain("lowercase");
    expect(newSkillProblem("-pdf", "", []).name).toContain("hyphen");
    expect(newSkillProblem("pdf--x", "", []).name).toContain("two hyphens");
    expect(newSkillProblem("a".repeat(65), "", []).name).toContain("64");
    expect(newSkillProblem("pdf", "", ["pdf"]).name).toContain("already");
    expect(newSkillProblem("pdf-tools", "ok", ["pdf"])).toEqual({ name: "", description: "" });
  });

  it("caps the description at the spec's 1024 characters", () => {
    expect(newSkillProblem("pdf", "a".repeat(1024), []).description).toBe("");
    expect(newSkillProblem("pdf", "a".repeat(1025), []).description).toContain("1025");
  });
});

describe("import picks", () => {
  const sources: SkillImportSource[] = [
    { source: "claude-code", label: "Claude Code", path: "/h/.claude/skills", found: true, problems: [], skills: [
      { name: "pdf", description: "", warnings: [] }, { name: "notes", description: "", warnings: [], duplicateOf: "your OpenLive skills" },
    ] },
    { source: "agents", label: "Shared", path: "/h/.agents/skills", found: true, problems: [], skills: [{ name: "pdf", description: "", warnings: [], duplicateOf: "Claude Code" }] },
  ];
  it("starts with everything but duplicates checked", () => {
    expect([...initialPicks(sources)]).toEqual([pickKey("claude-code", "pdf")]);
  });
  it("sends one pick per name, the first listed", () => {
    const all = new Set([pickKey("claude-code", "pdf"), pickKey("agents", "pdf"), pickKey("claude-code", "notes")]);
    expect(pickedItems(sources, all)).toEqual([{ source: "claude-code", name: "pdf" }, { source: "claude-code", name: "notes" }]);
  });
});
