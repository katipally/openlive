import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// The skills OpenLive ships: where they are found in each kind of build, how
// they parse, that they are locked, and save_skill, which writes beside them.

const tmp = mkdtempSync(join(tmpdir(), "ol-bundled-"));
const userDir = join(tmp, "user-skills");
process.env.OPENLIVE_HOME = join(tmp, "data");
process.env.OPENLIVE_SKILLS_DIR = userDir;
delete process.env.OPENLIVE_BUNDLED_SKILLS_DIR;
const { bundledSkillsDir, catalog, rescan, scanRoot, shippedSkillsDir } = await import("./catalog.ts");
const { parseSkill } = await import("./parse.ts");
const { skillRoutes } = await import("./routes.ts");
const { saveSkill, skillTools } = await import("./tools.ts");
const { previewSkills } = await import("./import.ts");
const { ToolSet, dispatchAll } = await import("../capabilities/dispatch.ts");
const { allowAll } = await import("../capabilities/approval.ts");
const { computerTools } = await import("../computer/tools.ts");

afterAll(() => {
  delete process.env.OPENLIVE_HOME;
  delete process.env.OPENLIVE_SKILLS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

const SHIPPED = ["computer-use", "connector-setup", "research", "skill-creator"];
const repoSkills = fileURLToPath(new URL("../../skills/", import.meta.url));
const md = (name: string, description: string, body = "Mine.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await skillRoutes.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: r.status, json: (await r.json()) as any };
};
const ctx = () => ({ signal: new AbortController().signal, context: null });
const run = (args: unknown, approve = allowAll) => dispatchAll([{ id: "c1", name: "save_skill", args }], new ToolSet([saveSkill]), ctx(), { approve });

beforeEach(() => { rmSync(userDir, { recursive: true, force: true }); rescan(); });

describe("where the built-in skills are found", () => {
  it("in dev, at services/agent/skills", () => {
    expect(bundledSkillsDir()).toBe(repoSkills);
    expect(scanRoot(bundledSkillsDir(), "bundled").skills.map((s) => s.name).sort()).toEqual(SHIPPED);
  });

  it("beside agent.mjs in the bundled agent and the packaged app, where pack-agent.cjs copies them", () => {
    const resources = join(tmp, "resources");
    cpSync(repoSkills, join(resources, "agent", "skills"), { recursive: true });
    const dir = shippedSkillsDir(pathToFileURL(join(resources, "agent", "agent.mjs")).href);
    expect(dir.replace(/[\\/]$/, "")).toBe(join(resources, "agent", "skills"));
    expect(scanRoot(dir, "bundled").skills.map((s) => s.name).sort()).toEqual(SHIPPED);
    const pack = readFileSync(fileURLToPath(new URL("../../../../apps/desktop/scripts/pack-agent.cjs", import.meta.url)), "utf8");
    expect(pack).toContain(`fs.cpSync(path.join(root, "services/agent/skills"), skills, { recursive: true })`);
  });
});

describe("each built-in skill", () => {
  for (const name of SHIPPED) {
    it(`${name} parses cleanly, with a one-line description and a body within budget`, () => {
      const raw = readFileSync(join(repoSkills, name, "SKILL.md"), "utf8");
      const r = parseSkill(raw, name);
      if (!r.ok) throw new Error(r.error);
      expect(r.warnings).toEqual([]);
      expect(r.skill.name).toBe(name);
      expect(r.skill.description.length).toBeLessThanOrEqual(1024);
      expect(r.skill.description).not.toContain("\n");
      // About 5k tokens, the spec's budget for a body, at four characters a token.
      expect(r.skill.body.length).toBeLessThan(20_000);
      expect(raw).not.toMatch(/[\u2013\u2014]/);
    });
  }

  it("computer-use credits Orca, and the tool keeps the safety lines in every prompt", () => {
    expect(readFileSync(join(repoSkills, "computer-use", "SKILL.md"), "utf8")).toContain("Orca");
    const look = computerTools({ computer: {} as never, device: {} as never }).find((t) => t.name === "get_app_state")!;
    const lines = look.promptGuidelines!.join("\n");
    expect(lines).toContain("Do not send, submit, buy, delete, or change account settings unless the user asked for exactly that.");
    expect(lines).toContain("Password managers are off limits.");
    expect(lines).toContain("Never tell the user something was sent, saved, bought or deleted unless the window's state shows it.");
    expect(lines).toContain("computer-use skill");
  });
});

describe("built-in skills in the catalog", () => {
  it("are listed as built in, and offered", async () => {
    const list = await call("GET", "/");
    expect(list.json.skills.filter((s: any) => s.source === "bundled").map((s: any) => s.name)).toEqual(SHIPPED);
    const names = (skillTools()({})[0]!.parameters as any).properties.name.enum;
    expect(names).toEqual(SHIPPED);
  });

  it("switch off by name, like any skill", async () => {
    expect((await call("POST", "/skill/research/enabled", { enabled: false })).json).toMatchObject({ name: "research", source: "bundled", enabled: false });
    expect((skillTools()({})[0]!.parameters as any).properties.name.enum).not.toContain("research");
    await call("POST", "/skill/research/enabled", { enabled: true });
  });

  it("refuse an edit and a removal, saying so", async () => {
    const text = (await call("GET", "/skill/research")).json.text;
    const put = await call("PUT", "/skill/research", { text });
    expect(put.status).toBe(403);
    expect(put.json.error).toContain("built into OpenLive");
    const del = await call("DELETE", "/skill/research");
    expect(del.status).toBe(403);
    expect(del.json.error).toContain("Turn it off instead");
    expect(existsSync(join(repoSkills, "research", "SKILL.md"))).toBe(true);
  });

  it("give way to a skill of yours with the same name, which shows the built-in one as replaced", async () => {
    mkdirSync(join(userDir, "research"), { recursive: true });
    writeFileSync(join(userDir, "research", "SKILL.md"), md("research", "My own way to research."));
    const { skills, replaced } = catalog();
    expect(skills.find((s) => s.name === "research")).toMatchObject({ source: "user", warnings: [] });
    expect(replaced.map((s) => [s.name, s.source])).toEqual([["research", "bundled"]]);
    const listed = (await call("GET", "/")).json.skills.filter((s: any) => s.name === "research");
    expect(listed.map((s: any) => [s.source, s.replacedBy ?? null])).toEqual([["user", null], ["bundled", "user"]]);
    expect((await call("GET", "/skill/research?source=bundled")).json.text).toContain("Researching well");
    expect((await call("GET", "/skill/research")).json.text).toContain("My own way");
    // Removing yours brings the built-in one back.
    expect((await call("DELETE", "/skill/research")).status).toBe(200);
    expect(catalog().skills.find((s) => s.name === "research")!.source).toBe("bundled");
  });

  it("are marked as duplicates when another tool offers the same name to import", () => {
    const src = join(tmp, "claude-skills");
    mkdirSync(join(src, "research"), { recursive: true });
    writeFileSync(join(src, "research", "SKILL.md"), md("research", "Theirs."));
    const [preview] = previewSkills([{ id: "claude-code", label: "Claude Code", path: src }]);
    expect(preview!.skills).toEqual([expect.objectContaining({ name: "research", duplicateOf: "OpenLive's built-in skills" })]);
  });
});

describe("save_skill", () => {
  const good = { name: "weekly-report", description: "Use when the user asks for their weekly report.", body: "1. Gather.\n2. Write." };

  it("asks first, and writes nothing on a no", async () => {
    expect(saveSkill.confirm!(good)).toBe("save a new skill named weekly-report");
    const [r] = await run(good, async () => ({ block: true, reason: "no" }));
    expect(r!.isError).toBe(true);
    expect(existsSync(join(userDir, "weekly-report"))).toBe(false);
  });

  it("writes a skill into the user's folder that loads at once", async () => {
    const [r] = await run(good);
    expect(r!.isError).toBe(false);
    expect(readFileSync(join(userDir, "weekly-report", "SKILL.md"), "utf8")).toContain("1. Gather.");
    expect(catalog().skills.find((s) => s.name === "weekly-report")).toMatchObject({ source: "user", description: good.description });
    const [again] = await run(good);
    expect(again!.isError).toBe(true);
  });

  it("refuses a name the spec does not allow, before asking anyone", async () => {
    let asked = false;
    for (const name of ["Weekly Report", "-x", "a--b", "x".repeat(65)]) {
      const [r] = await run({ ...good, name }, async () => { asked = true; return {}; });
      expect(r!.isError, name).toBe(true);
    }
    const [noDesc] = await run({ ...good, description: " " }, async () => { asked = true; return {}; });
    expect(noDesc!.isError).toBe(true);
    expect(asked).toBe(false);
    expect(readdirSync(tmp)).not.toContain("user-skills");
  });

  it("refuses a built-in name, unless the user wants theirs to replace it", async () => {
    const [refused] = await run({ ...good, name: "research" });
    expect(refused!.content[0]).toMatchObject({ text: expect.stringContaining("built into OpenLive") });
    const over = { ...good, name: "research", replace_built_in: true };
    expect(saveSkill.confirm!(over)).toContain("replaces the built-in one");
    const [r] = await run(over);
    expect(r!.isError).toBe(false);
    expect(catalog().skills.find((s) => s.name === "research")!.source).toBe("user");
  });
});
