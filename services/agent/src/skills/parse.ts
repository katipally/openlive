import { parse as parseYaml } from "yaml";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX, skillNameProblem } from "@openlive/shared";

// SKILL.md: YAML frontmatter between `---` lines, then the instructions.
// Lenient where the client guide says to be (agentskills.io, "Adding skills
// support"), so a skill written for another tool still loads: cosmetic
// problems are warnings, and only what makes a skill unusable skips it.

const COMPATIBILITY_MAX = 500;
const FRONT = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface Skill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  /** Experimental in the spec: parsed and shown, never enforced. */
  allowedTools: string[];
  body: string;
}

export type Parsed = { ok: true; skill: Skill; warnings: string[] } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/**
 * `description: Use when: the user asks` is invalid YAML that other clients
 * accept. Quote any top-level value holding a colon, for one more try.
 */
function quoteColons(yaml: string): string {
  return yaml.split("\n").map((line) => {
    const m = /^([A-Za-z0-9_-]+):[ \t]+(.+?)\s*$/.exec(line);
    if (!m || !/:(\s|$)/.test(m[2]!) || /^["'|>[{&*!]/.test(m[2]!)) return line;
    return `${m[1]}: ${JSON.stringify(m[2])}`;
  }).join("\n");
}

function frontmatter(yaml: string): unknown {
  try { return parseYaml(yaml); }
  catch { return parseYaml(quoteColons(yaml)); }
}

/** One SKILL.md. `folder` is the name of the folder it sits in. Never throws. */
export function parseSkill(raw: string, folder: string): Parsed {
  const m = FRONT.exec(raw.replace(/^﻿/, ""));
  if (!m) return { ok: false, error: "SKILL.md has no frontmatter: it starts with a --- line, then name and description." };
  let data: unknown;
  try { data = frontmatter(m[1]!); }
  catch (e) { return { ok: false, error: `Its frontmatter is not valid YAML: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` }; }
  if (!isObj(data)) return { ok: false, error: "Its frontmatter is not a list of fields." };

  const name = str(data.name);
  const description = str(data.description);
  if (!name) return { ok: false, error: "It has no name." };
  // A name past the character rule cannot be offered as a tool argument or typed as /name.
  const bad = skillNameProblem(name);
  if (bad && name.length <= SKILL_NAME_MAX) return { ok: false, error: `Its name "${name}" is not valid. ${bad}` };
  if (!description) return { ok: false, error: "It has no description, which is how a model knows when to use it." };

  const warnings: string[] = [];
  if (bad) warnings.push(bad);
  if (name !== folder) warnings.push(`Its name "${name}" does not match its folder "${folder}".`);
  if (description.length > SKILL_DESCRIPTION_MAX) warnings.push(`Its description is over ${SKILL_DESCRIPTION_MAX} characters; models see the first ${SKILL_DESCRIPTION_MAX}.`);
  const compatibility = str(data.compatibility);
  if (compatibility.length > COMPATIBILITY_MAX) warnings.push(`Its compatibility note is over ${COMPATIBILITY_MAX} characters.`);

  const metadata: Record<string, string> = {};
  if (isObj(data.metadata)) for (const [k, v] of Object.entries(data.metadata)) { const s = str(v); if (s) metadata[k] = s; }
  const tools = data["allowed-tools"];
  const allowedTools = Array.isArray(tools) ? tools.map(str).filter(Boolean) : str(tools).split(/\s+/).filter(Boolean);
  const license = str(data.license);

  return {
    ok: true,
    warnings,
    skill: {
      name,
      description: description.slice(0, SKILL_DESCRIPTION_MAX),
      ...(license && { license }),
      ...(compatibility && { compatibility }),
      metadata,
      allowedTools,
      body: raw.replace(/^﻿/, "").slice(m[0].length).trim(),
    },
  };
}
