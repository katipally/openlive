import { join } from "node:path";
import type { SkillSource } from "@openlive/shared";
import { readJson, updateJson } from "./store";
import { PATHS } from "./paths";

// Which skills are switched off, by where each comes from and its name, so
// turning off a project's skill leaves your own of the same name on. The skills
// themselves are folders on disk (skillsDir()); this choice is the only skill
// state OpenLive keeps.

const SKILLS = join(PATHS.state, "skills.json");
const SOURCES: readonly SkillSource[] = ["user", "workspace", "bundled"];

interface SkillsState { disabled: string[] }

/** How skills.json names one skill. */
export const skillKey = (source: SkillSource, name: string): string => `${source}:${name}`;

/** An entry written before keys had a source (a bare name, which never holds a colon) still turns that name off everywhere. O(entries). */
const keys = (s: SkillsState): Set<string> =>
  new Set(s.disabled.flatMap((k) => (k.includes(":") ? [k] : SOURCES.map((src) => skillKey(src, k)))));

export const disabledSkills = (): Set<string> => keys(readJson<SkillsState>(SKILLS, { disabled: [] }));

export async function setSkillEnabled(source: SkillSource, name: string, enabled: boolean): Promise<void> {
  await updateJson<SkillsState>(SKILLS, { disabled: [] }, (s) => {
    const off = keys(s);
    if (enabled) off.delete(skillKey(source, name)); else off.add(skillKey(source, name));
    return { disabled: [...off].sort() };
  });
}
