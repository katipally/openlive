// What the agent's /skills routes send and take, and the name rule both sides
// check. A skill is an Agent Skills folder (agentskills.io/specification): a
// SKILL.md with `name` and `description` frontmatter, and optional scripts/,
// references/ and assets/.

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

/** Why a skill name breaks the spec, or "" when it is fine. */
export function skillNameProblem(name: string): string {
  if (!name) return "Give it a name.";
  if (name.length > SKILL_NAME_MAX) return `A name is at most ${SKILL_NAME_MAX} characters.`;
  if (!/^[a-z0-9-]+$/.test(name)) return "Use lowercase letters, digits and hyphens only.";
  if (name.startsWith("-") || name.endsWith("-")) return "A name cannot start or end with a hyphen.";
  if (name.includes("--")) return "A name cannot have two hyphens in a row.";
  return "";
}

/** `user`: OpenLive's own folder. `workspace`: the bound project's .agents/skills or .claude/skills, read in place.
 *  `bundled`: shipped with OpenLive, read-only. */
export type SkillSource = "user" | "workspace" | "bundled";

export interface SkillWire {
  name: string;
  description: string;
  source: SkillSource;
  /** The skill's folder, absolute. */
  dir: string;
  enabled: boolean;
  /** Files beside SKILL.md, counted up to a cap. */
  resources: number;
  /** Problems that did not stop it loading, as a name that does not match its folder. */
  warnings: string[];
  license?: string;
  compatibility?: string;
}

/** A folder with a SKILL.md that could not load, and why. */
export interface SkillProblemWire { dir: string; source: SkillSource; error: string }

export interface SkillListWire {
  /** OpenLive's skills folder. */
  dir: string;
  skills: SkillWire[];
  problems: SkillProblemWire[];
}

export type SkillImportSourceId = "claude-code" | "agents" | "codex" | "gemini";

export interface SkillImportCandidate {
  name: string;
  description: string;
  /** An OpenLive skill, or an earlier candidate, with the same name. */
  duplicateOf?: string;
  warnings: string[];
}

export interface SkillImportSource {
  source: SkillImportSourceId;
  label: string;
  path: string;
  found: boolean;
  skills: SkillImportCandidate[];
  /** Folders there that are not valid skills. */
  problems: { dir: string; error: string }[];
}
