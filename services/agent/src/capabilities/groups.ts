import { getSetting, updateSetting } from "@openlive/db";
import type { BuiltinToolWire, ToolGroupWire } from "@openlive/shared";
import type { Tool } from "./types.js";

// The groups OpenLive's own tools come in, as Settings shows and switches them.
// A tool names its group (Tool.group); this table only says how a group reads,
// in the order Settings lists them. A group with no tools is not listed.

export const GROUPS = {
  computer: { name: "Computer use", icon: "monitor", description: "Sees and drives the apps on your screen", needs: "Needs the desktop app" },
  files: { name: "Files", icon: "folder", description: "Reads and edits your workspace folder", needs: "Needs a folder" },
  web: { name: "Web research", icon: "globe", description: "Searches and reads the web, with sources" },
  text: { name: "Text", icon: "type", description: "Types at your cursor and reads selections" },
  assistant: { name: "Assistant", icon: "sparkles", description: "Plans, remembers facts and sees what a call shares" },
  shell: { name: "Shell", icon: "terminal", description: "Runs commands on this computer", needs: "Needs the desktop app" },
} as const satisfies Record<string, { name: string; icon: string; description: string; needs?: string }>;

export type ToolGroupId = keyof typeof GROUPS;

/** settings.json key: a comma-separated list, so it reads and edits by hand. */
const OFF_KEY = "disabledToolGroups";

const parse = (v: string | undefined) => new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

/** The groups switched off. Read fresh, so the next session sees a change. */
export const disabledGroups = (): ReadonlySet<string> => parse(getSetting(OFF_KEY));

export async function setGroupEnabled(id: ToolGroupId, enabled: boolean): Promise<void> {
  await updateSetting(OFF_KEY, (cur) => {
    const off = parse(cur);
    if (enabled) off.delete(id); else off.add(id);
    return [...off].join(",");
  });
}

const ONE_LINE_MAX = 160;

/** A tool's description cut to its first sentence, for a one-line tooltip. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const one = end >= 0 ? flat.slice(0, end + 1) : flat;
  return one.length > ONE_LINE_MAX ? `${one.slice(0, ONE_LINE_MAX - 1).trimEnd()}…` : one;
}

/**
 * Every grouped tool in GROUPS order, with whether each group is on. One pass
 * over the tools and one over the groups: O(tools + groups). A name offered
 * twice keeps its first, as the registry does.
 */
export function groupTools(tools: readonly Tool[], off: ReadonlySet<string>): ToolGroupWire[] {
  const byGroup = new Map<string, BuiltinToolWire[]>();
  const seen = new Set<string>();
  for (const t of tools) {
    if (!t.group || seen.has(t.name)) continue;
    seen.add(t.name);
    const list = byGroup.get(t.group) ?? [];
    list.push({ name: t.name, description: firstSentence(t.description), asksFirst: !!t.confirm });
    byGroup.set(t.group, list);
  }
  return (Object.entries(GROUPS) as [ToolGroupId, (typeof GROUPS)[ToolGroupId]][]).flatMap(([id, g]) => {
    const list = byGroup.get(id);
    return list ? [{ id, ...g, enabled: !off.has(id), tools: list }] : [];
  });
}
