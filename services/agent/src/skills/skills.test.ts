import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "ol-skills-"));
const userDir = join(tmp, "user-skills");
process.env.OPENLIVE_HOME = join(tmp, "data");
process.env.OPENLIVE_SKILLS_DIR = userDir;
// Without the built-in skills: these cases are about the user's and a workspace's. bundled.test.ts covers those.
process.env.OPENLIVE_BUNDLED_SKILLS_DIR = join(tmp, "no-bundled");
const { parseSkill } = await import("./parse.ts");
const { catalog, rescan, resources } = await import("./catalog.ts");
const { skillTools, slashSkill } = await import("./tools.ts");
const { carriedSkills } = await import("./content.ts");
const { previewSkills, skillImportSources, copySkill } = await import("./import.ts");
const { scanRoot } = await import("./catalog.ts");
const { setSkillEnabled } = await import("@openlive/db");
const { ToolSet } = await import("../capabilities/dispatch.ts");

afterAll(() => {
  delete process.env.OPENLIVE_HOME;
  delete process.env.OPENLIVE_SKILLS_DIR;
  delete process.env.OPENLIVE_BUNDLED_SKILLS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

const md = (name: string, description: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
function skill(root: string, folder: string, text: string, files: Record<string, string> = {}): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}
const ctx = () => ({ signal: new AbortController().signal, context: null, callId: "c1" });
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

describe("parsing SKILL.md", () => {
  it("reads the fields the spec defines, and the body without its frontmatter", () => {
    const r = parseSkill("---\nname: pdf\ndescription: Work with PDFs.\nlicense: MIT\ncompatibility: Needs qpdf\nmetadata:\n  author: me\n  version: 2\nallowed-tools: Bash(qpdf:*) Read\n---\n\n# PDF\nSteps.\n", "pdf");
    expect(r).toEqual({
      ok: true, warnings: [],
      skill: { name: "pdf", description: "Work with PDFs.", license: "MIT", compatibility: "Needs qpdf", metadata: { author: "me", version: "2" }, allowedTools: ["Bash(qpdf:*)", "Read"], body: "# PDF\nSteps." },
    });
  });

  it("retries a value with an unquoted colon as a quoted one", () => {
    const r = parseSkill(md("pdf", "Use this skill when: the user asks about PDFs"), "pdf");
    expect(r.ok && r.skill.description).toBe("Use this skill when: the user asks about PDFs");
  });

  it("skips a name that breaks the character rule, and one with no description", () => {
    expect(parseSkill(md("PDF-Tools", "x"), "PDF-Tools")).toMatchObject({ ok: false, error: expect.stringContaining("not valid") });
    expect(parseSkill(md("pdf--tools", "x"), "pdf--tools").ok).toBe(false);
    expect(parseSkill("---\nname: pdf\n---\nbody", "pdf")).toMatchObject({ ok: false, error: expect.stringContaining("description") });
    expect(parseSkill("no frontmatter here", "pdf").ok).toBe(false);
    expect(parseSkill("---\nname: [unclosed\n---\n", "pdf").ok).toBe(false);
  });

  it("loads a name that does not match its folder, with a warning", () => {
    const r = parseSkill(md("pdf", "Work with PDFs."), "pdf-old");
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.join()).toContain('does not match its folder "pdf-old"');
  });

  it("keeps a long description to the spec's 1024 characters, with a warning", () => {
    const r = parseSkill(md("pdf", "a".repeat(3000)), "pdf");
    expect(r.ok && r.skill.description.length).toBe(1024);
    expect(r.ok && r.warnings.join()).toContain("1024");
  });
});

describe("finding skills", () => {
  const ws = join(tmp, "project");
  beforeEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rescan();
  });

  it("lets a workspace skill override the user's, and .agents/skills override .claude/skills", () => {
    skill(userDir, "review", md("review", "User review."));
    skill(userDir, "notes", md("notes", "User notes."));
    skill(join(ws, ".claude", "skills"), "review", md("review", "Claude-folder review."));
    skill(join(ws, ".agents", "skills"), "review", md("review", "Agents-folder review."));
    const { skills } = catalog(ws);
    expect(skills.map((s) => [s.name, s.source, s.description])).toEqual([["notes", "user", "User notes."], ["review", "workspace", "Agents-folder review."]]);
    expect(skills[1]!.warnings.join()).toContain("overrides");
    expect(catalog().skills.find((s) => s.name === "review")!.description).toBe("User review.");
  });

  it("lists a broken skill as a problem and ignores a folder without SKILL.md", () => {
    skill(userDir, "bad", "---\nname: bad\n---\n");
    mkdirSync(join(userDir, "not-a-skill"), { recursive: true });
    const c = catalog();
    expect(c.skills).toEqual([]);
    expect(c.problems).toEqual([{ dir: join(userDir, "bad"), source: "user", error: expect.stringContaining("description") }]);
  });

  it("lists resources with forward slashes and never SKILL.md itself", () => {
    const dir = skill(userDir, "pdf", md("pdf", "PDFs."), { "scripts/merge.py": "", "references/deep/spec.md": "", ".hidden": "" });
    expect(resources(dir)).toEqual({ files: ["references/deep/spec.md", "scripts/merge.py"], more: false });
  });
});

describe("the skill tools", () => {
  beforeEach(() => { rmSync(userDir, { recursive: true, force: true }); rescan(); });

  it("are not offered at all with no skill enabled", async () => {
    expect(skillTools()({})).toEqual([]);
    skill(userDir, "pdf", md("pdf", "PDFs."));
    await setSkillEnabled("pdf", false);
    expect(skillTools()({})).toEqual([]);
    await setSkillEnabled("pdf", true);
    expect(skillTools()({}).map((t) => t.name)).toEqual(["activate_skill", "read_skill_file"]);
  });

  it("carry the catalog in activate_skill, and load a skill once per session", async () => {
    const dir = skill(userDir, "pdf", md("pdf", "Merge <and> split PDFs.", "Use qpdf."), { "scripts/merge.py": "print(1)" });
    const [activate] = skillTools()({});
    expect(activate!.description).toContain("<name>pdf</name>");
    expect(activate!.description).toContain("Merge &lt;and&gt; split PDFs.");
    expect((activate!.parameters as any).properties.name.enum).toEqual(["pdf"]);
    const first = textOf(await activate!.execute({ name: "pdf" }, ctx()));
    expect(first).toMatch(/^<skill_content name="pdf">\nUse qpdf\./);
    expect(first).toContain(`Skill directory: ${dir}`);
    expect(first).toContain("<file>scripts/merge.py</file>");
    expect(first).not.toContain("print(1)");
    expect(first.endsWith("</skill_content>")).toBe(true);
    expect(textOf(await activate!.execute({ name: "pdf" }, ctx()))).toContain("already active");
    // A new session starts with nothing loaded.
    const [fresh] = skillTools()({});
    expect(textOf(await fresh!.execute({ name: "pdf" }, ctx()))).toContain("<skill_content");
  });

  it("read files inside the skill's folder and nothing outside it", async () => {
    const dir = skill(userDir, "pdf", md("pdf", "PDFs."), { "references/a.md": "inside" });
    writeFileSync(join(tmp, "secret.txt"), "outside");
    symlinkSync(join(tmp, "secret.txt"), join(dir, "escape.txt"));
    const read = skillTools()({})[1]!;
    expect(textOf(await read.execute({ name: "pdf", path: "references/a.md" }, ctx()))).toBe("inside");
    await expect(read.execute({ name: "pdf", path: "../../secret.txt" }, ctx())).rejects.toThrow(/outside/);
    await expect(read.execute({ name: "pdf", path: join(tmp, "secret.txt") }, ctx())).rejects.toThrow(/outside/);
    await expect(read.execute({ name: "pdf", path: "escape.txt" }, ctx())).rejects.toThrow(/outside/);
    await expect(read.execute({ name: "pdf", path: "missing.md" }, ctx())).rejects.toThrow(/no file/);
  });

  it("load a typed /skill-name before the turn, and leave anything else alone", async () => {
    skill(userDir, "pdf", md("pdf", "PDFs.", "Use qpdf."));
    const tools = new ToolSet(skillTools()({}));
    const hit = await slashSkill("/pdf merge a and b", tools, ctx());
    expect(hit).toMatchObject({ name: "pdf", rest: "merge a and b" });
    expect(hit!.content).toContain("Use qpdf.");
    expect(await slashSkill("/review this", tools, ctx())).toBe(null);
    expect(await slashSkill("please /pdf", tools, ctx())).toBe(null);
  });
});

describe("compaction", () => {
  it("carries the skills in what is dropped, unless they are also kept", () => {
    const block = (n: string) => `<skill_content name="${n}">\n${n} body\n</skill_content>`;
    const dropped = [{ role: "tool" as const, callId: "1", name: "activate_skill", result: block("a") }, { role: "user" as const, text: `note\n${block("b")}` }];
    const kept = [{ role: "tool" as const, callId: "2", name: "activate_skill", result: block("b") }];
    expect(carriedSkills(dropped, kept)).toBe(block("a"));
  });
});

describe("importing from other tools", () => {
  const home = join(tmp, "home");
  beforeEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(userDir, { recursive: true, force: true }); rescan(); });

  it("finds each tool's folder under the home folder, honoring CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    expect(skillImportSources({}, home).map((s) => s.path)).toEqual([
      join(home, ".claude", "skills"), join(home, ".agents", "skills"), join(home, ".codex", "skills"), join(home, ".gemini", "skills"),
    ]);
    expect(skillImportSources({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" }, home).map((s) => s.path).slice(0, 3)).toEqual([join("/c", "skills"), join(home, ".agents", "skills"), join("/x", "skills")]);
  });

  it("previews every source, marking duplicates by name, and copies a folder in", async () => {
    skill(userDir, "notes", md("notes", "Mine."));
    skill(join(home, ".claude", "skills"), "pdf", md("pdf", "PDFs."), { "scripts/x.sh": "echo" });
    skill(join(home, ".claude", "skills"), "notes", md("notes", "Theirs."));
    skill(join(home, ".agents", "skills"), "pdf", md("pdf", "PDFs again."));
    skill(join(home, ".codex", "skills"), "broken", "---\nname: broken\n---\n");
    const sources = previewSkills(skillImportSources({}, home));
    expect(sources.map((s) => [s.source, s.found, s.skills.map((k) => [k.name, k.duplicateOf ?? null])])).toEqual([
      ["claude-code", true, [["notes", "your OpenLive skills"], ["pdf", null]]],
      ["agents", true, [["pdf", "Claude Code"]]],
      ["codex", true, []],
      ["gemini", false, []],
    ]);
    expect(sources[2]!.problems[0]!.error).toContain("description");

    const pdf = scanRoot(join(home, ".claude", "skills"), "user").skills.find((s) => s.name === "pdf")!;
    await copySkill(pdf);
    expect(catalog().skills.map((s) => s.name)).toEqual(["notes", "pdf"]);
    expect(resources(join(userDir, "pdf")).files).toEqual(["scripts/x.sh"]);
    await expect(copySkill(pdf)).rejects.toThrow("already added");
  });
});
