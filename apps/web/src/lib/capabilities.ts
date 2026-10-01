// Capabilities settings, the pure half: how the Tools subtab narrows and shows
// OpenLive's own tool groups. No React, no DOM, so it tests on its own.

import type { ToolGroupWire } from "@openlive/shared";

/** The first `max` items and how many are left for a "+N". */
export function chipOverflow<T>(items: readonly T[], max: number): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/** Groups whose name or description, or one of whose tools, holds the query. O(tools). */
export function filterGroups(groups: readonly ToolGroupWire[], query: string): ToolGroupWire[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  return groups.filter((g) => `${g.name} ${g.description}`.toLowerCase().includes(q) || g.tools.some((t) => t.name.toLowerCase().includes(q)));
}

/** Every built-in tool across the groups, for the subtab's count. */
export const toolCount = (groups: readonly ToolGroupWire[]) => groups.reduce((n, g) => n + g.tools.length, 0);

/** How many of a group's tools ask before they act. */
export const asksFirst = (g: ToolGroupWire) => g.tools.reduce((n, t) => n + (t.asksFirst ? 1 : 0), 0);
