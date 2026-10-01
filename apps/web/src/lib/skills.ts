// Skills settings, the pure half: finding a skill in a long list, checking a
// new one before it is sent, and which import candidates start checked. No
// React, no DOM, so it tests on its own.

import { SKILL_DESCRIPTION_MAX, skillNameProblem, type SkillImportSource, type SkillWire } from "@openlive/shared";

/** Skills whose name or description holds the query, case-insensitive. O(skills). */
export function filterSkills(skills: readonly SkillWire[], query: string): SkillWire[] {
  const q = query.trim().toLowerCase();
  return q ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q)) : [...skills];
}

/** What stops a new skill, checked as it is typed: the name rule, a name taken, a description. */
export function newSkillProblem(name: string, description: string, taken: readonly string[]): { name: string; description: string } {
  const n = name.trim(), d = description.trim();
  return {
    name: n && taken.includes(n) ? `There is already a skill named ${n}.` : n ? skillNameProblem(n) : "",
    description: d.length > SKILL_DESCRIPTION_MAX ? `Keep it to ${SKILL_DESCRIPTION_MAX} characters; this is ${d.length}.` : "",
  };
}

/** One import candidate, as a key a Set can hold. */
export const pickKey = (source: string, name: string) => `${source}\n${name}`;

/** What starts checked: every skill found, except a duplicate. */
export const initialPicks = (sources: readonly SkillImportSource[]) =>
  new Set(sources.flatMap((s) => s.skills.filter((k) => !k.duplicateOf).map((k) => pickKey(s.source, k.name))));

/** The commit body for what is checked, in the order the preview lists it. Two picks of one name keep the first. */
export function pickedItems(sources: readonly SkillImportSource[], picks: ReadonlySet<string>): { source: string; name: string }[] {
  const names = new Set<string>();
  const items: { source: string; name: string }[] = [];
  for (const s of sources) {
    for (const k of s.skills) {
      if (!picks.has(pickKey(s.source, k.name)) || names.has(k.name)) continue;
      names.add(k.name);
      items.push({ source: s.source, name: k.name });
    }
  }
  return items;
}
