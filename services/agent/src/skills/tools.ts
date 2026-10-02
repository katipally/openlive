import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { disabledSkills, skillKey } from "@openlive/db";
import type { ToolProvider } from "../capabilities/registry.js";
import type { ToolSet } from "../capabilities/dispatch.js";
import { confine } from "../capabilities/files.js";
import type { TextPart, Tool, ToolCtx, ToolResult } from "../capabilities/types.js";
import { catalog, load, resources, type SkillEntry } from "./catalog.js";
import { esc, skillContent } from "./content.js";
import { builtIn, createSkill, newSkillProblem } from "./routes.js";

// Skills as registry tools, so every brain in both modes gets the same two:
// an API brain natively, a coding agent over the `openlive` MCP server. The
// catalog rides in activate_skill's description, not the system prompt, so it
// reaches both kinds of brain the same way and costs nothing when there are no
// skills: with none enabled, neither tool is offered. save_skill is a built-in
// (capabilities/registry.ts), offered whatever skills there are.

export const ACTIVATE = "activate_skill";
/** About 10k tokens. Past it, the rest is one read_skill_file away. */
const BODY_MAX = 40_000;
/** As read_file's caps: text returned, and the largest file read at all. */
const FILE_MAX = 100_000;
const FILE_BYTES_MAX = 2_000_000;

const text = (t: string): TextPart => ({ type: "text", text: t });
const fail = (why: string): never => { throw new Error(why); };

function activateSkill(skills: Map<string, SkillEntry>, active: Set<string>): Tool<{ name: string }, { skill: string; activated: boolean }> {
  const catalogXml = [...skills.values()].map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${esc(s.description)}</description>\n  </skill>`).join("\n");
  return {
    name: ACTIVATE,
    description: `Load a skill: instructions written for a specific kind of task. When a task matches a skill's description, call this with the skill's name before you start, and follow what it says.\n\n<available_skills>\n${catalogXml}\n</available_skills>`,
    parameters: { type: "object", properties: { name: { type: "string", enum: [...skills.keys()], description: "The skill to load." } }, required: ["name"], additionalProperties: false },
    readOnly: true,
    async execute({ name }) {
      const s = skills.get(name) ?? fail(`There is no skill named ${name}.`);
      if (active.has(name)) return { content: [text(`The ${name} skill is already active in this conversation. Its instructions are above.`)], details: { skill: name, activated: false } };
      // Read again, so an edit since the session started is what the model gets.
      const parsed = load(s.file) ?? fail(`The ${name} skill is no longer on disk.`);
      if (!parsed.ok) throw new Error(`The ${name} skill no longer loads: ${parsed.error}`);
      const body = parsed.skill.body;
      const cut = body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}\n\n[The rest of SKILL.md was cut here. Read it with read_skill_file.]` : body;
      active.add(name);
      return { content: [text(skillContent(name, cut, s.dir, resources(s.dir)))], details: { skill: name, activated: true } };
    },
  };
}

function readSkillFile(skills: Map<string, SkillEntry>): Tool<{ name: string; path: string }, null> {
  return {
    name: "read_skill_file",
    description: "Read one file from a skill's folder, by its path relative to that folder, as the skill's resources list it. Load the skill with activate_skill first.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: [...skills.keys()], description: "The skill the file belongs to." },
        path: { type: "string", description: "Relative to the skill's folder, as scripts/extract.py." },
      },
      required: ["name", "path"],
      additionalProperties: false,
    },
    readOnly: true,
    async execute({ name, path }): Promise<ToolResult<null>> {
      const s = skills.get(name) ?? fail(`There is no skill named ${name}.`);
      const abs = confine(s.dir, path) ?? fail("That path is outside the skill's folder.");
      const st = await stat(abs).catch(() => fail(`The ${name} skill has no file ${path}.`));
      if (st.isDirectory()) fail(`${path} is a folder. Its files are in the skill's resources list.`);
      if (st.size > FILE_BYTES_MAX) fail(`${path} is ${st.size} bytes, too large to read here. Use it by its path: ${abs}`);
      const buf = await readFile(abs);
      if (buf.includes(0)) return { content: [text(`${path} is a binary file of ${buf.length} bytes. Use it by its path: ${abs}`)], details: null };
      const out = buf.toString("utf8");
      return { content: [text(out.length > FILE_MAX ? `${out.slice(0, FILE_MAX)}\n[cut: the file is longer than ${FILE_MAX} characters]` : out)], details: null };
    },
  };
}

type SaveArgs = { name: string; description: string; body: string; replace_built_in?: boolean };

function saveProblem(a: SaveArgs): string {
  const name = a.name.trim();
  const bad = newSkillProblem(name, a.description.trim());
  if (bad) return bad;
  if (builtIn(name) && !a.replace_built_in) return `${name} is a skill built into OpenLive. Pick another name. Only if the user said they want their own version to replace the built-in one, call again with replace_built_in set to true.`;
  return "";
}

/** A new skill in the user's folder, written as the Skills settings write one. Asks first: it adds to what every brain loads. */
export const saveSkill: Tool<SaveArgs, { skill: string; dir: string }> = {
  name: "save_skill",
  group: "skills",
  description: "Save a new skill to the user's skills folder. Show the user the name, description and instructions first and save only once they agree. It never overwrites a skill they already have.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Lowercase letters, digits and single hyphens, at most 64 characters, as weekly-report." },
      description: { type: "string", description: "One line, at most 1024 characters: what it does and when to use it." },
      body: { type: "string", description: "The instructions, in Markdown." },
      replace_built_in: { type: "boolean", description: "True only when the user asked for their own version of a built-in skill, which then replaces it." },
    },
    required: ["name", "description", "body"],
    additionalProperties: false,
  },
  confirm: (a) => (a.replace_built_in ? `save a skill named ${a.name.trim()} that replaces the built-in one` : `save a new skill named ${a.name.trim()}`),
  precheck(a) { const bad = saveProblem(a); if (bad) fail(bad); },
  async execute(a) {
    const r = createSkill(a);
    if ("error" in r) throw new Error(r.error);
    const { skill } = r;
    return {
      content: [text(`Saved the ${skill.name} skill in ${skill.dir}. Every brain can load it from the next call or Flow session; the user can edit or remove it in Settings, Capabilities, Skills.`)],
      details: { skill: skill.name, dir: skill.dir },
    };
  },
};

/**
 * The skill tools for one session, from a scan at its start: OpenLive's
 * folder, plus the workspace's when the session has one. Activations are
 * remembered per session, so a second load of one skill is a short note.
 */
export function skillTools(): ToolProvider {
  return (s) => {
    const off = disabledSkills();
    const on = catalog(s.workspace?.() ?? "").skills.filter((k) => !off.has(skillKey(k.source, k.name)));
    if (!on.length) return [];
    const skills = new Map(on.map((k) => [k.name, k]));
    return [activateSkill(skills, new Set()), readSkillFile(skills)];
  };
}

/**
 * A typed `/skill-name ...`, loaded by OpenLive before the turn rather than
 * left for the model to decide. Null unless the name is a skill this session
 * offers, so anything else goes on exactly as typed.
 */
export async function slashSkill(typed: string, tools: ToolSet, ctx: Omit<ToolCtx, "callId">): Promise<{ name: string; content: string; rest: string } | null> {
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(typed.trim());
  const tool = m && tools.list.find((t) => t.name === ACTIVATE);
  const names = (tool?.parameters as { properties?: { name?: { enum?: string[] } } } | undefined)?.properties?.name?.enum ?? [];
  if (!m || !tool || !names.includes(m[1]!)) return null;
  const r = await tool.execute({ name: m[1] }, { ...ctx, callId: randomUUID() });
  return { name: m[1]!, content: r.content.filter((c): c is TextPart => c.type === "text").map((c) => c.text).join("\n"), rest: m[2]?.trim() ?? "" };
}
