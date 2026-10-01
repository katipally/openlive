import { readJson, updateJson } from "./store";

// Which skills are switched off, by name. The skills themselves are folders on
// disk (skillsDir()); this choice is the only skill state OpenLive keeps.

const SKILLS = "skills.json";

interface SkillsState { disabled: string[] }

export const disabledSkills = (): Set<string> => new Set(readJson<SkillsState>(SKILLS, { disabled: [] }).disabled);

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  await updateJson<SkillsState>(SKILLS, { disabled: [] }, (s) => {
    const off = new Set(s.disabled);
    if (enabled) off.delete(name); else off.add(name);
    return { disabled: [...off].sort() };
  });
}
